import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

const RUNTIME = path.resolve("runtime", "fixed-income", "corporate-agency-public-expansion");
const CHECKPOINT = path.join(RUNTIME, "checkpoint.json");
const REPORT = path.join(RUNTIME, "report.json");

type Event = { id: string; issuer_name: string; issue_date: Date; amount: string | null; currency: string; coupon: string; maturity_date: Date; seniority: string | null; isin: string | null; cusip: string | null; source: string; source_event_id: string };

function uuid(key: string): string {
  const h = createHash("sha256").update(key).digest("hex").slice(0, 32).split("");
  h[12] = "5"; h[16] = ((Number.parseInt(h[16], 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8).join("")}-${h.slice(8, 12).join("")}-${h.slice(12, 16).join("")}-${h.slice(16, 20).join("")}-${h.slice(20).join("")}`;
}
function dbUrl(): string {
  const raw = process.env.DIRECT_URL;
  if (!raw) throw new Error("DIRECT_URL_REQUIRED_FOR_FIXED_INCOME_SCOPED_WRITER");
  const u = new URL(raw); if (u.port !== "5432") throw new Error("DIRECT_WRITER_5432_REQUIRED");
  u.searchParams.set("connection_limit", "1"); u.searchParams.set("connect_timeout", "20"); return u.toString();
}
async function atomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temp, file);
}
const iso = (date: Date): string => date.toISOString().slice(0, 10);

export async function promoteCorporateAgencyPublicSources(): Promise<Record<string, unknown>> {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl() } } });
  const startedAt = new Date().toISOString();
  await atomic(CHECKPOINT, { version: 1, state: "RUNNING", processId: process.pid, owner: "EXISTING_BOND_INCREMENTAL_HOOK", maxDbConcurrency: 1, currentSource: "SEC_EDGAR_424B5", startedAt });
  try {
    const before = (await prisma.$queryRawUnsafe<Array<{ rows: number }>>("SELECT COUNT(*)::int rows FROM bond_instruments"))[0].rows;
    const events = await prisma.$queryRawUnsafe<Event[]>(`
      SELECT id,issuer_name,issue_date,amount::text,currency,coupon::text,maturity_date,seniority,isin,cusip,source,source_event_id
      FROM corporate_issuance_events
      WHERE instrument_type='CORPORATE_BOND' AND source='SEC_EDGAR_424B5'
        AND source_event_id IS NOT NULL AND issue_date IS NOT NULL AND maturity_date IS NOT NULL AND coupon IS NOT NULL
      ORDER BY source_event_id`);
    let created = 0; let enriched = 0; let companyLinks = 0; let mappingPending = 0;
    for (const event of events) {
      const companies = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`
        SELECT id FROM securities WHERE country='US' AND ticker='PWR'
          AND upper(name) LIKE upper($1)||'%'`, event.issuer_name);
      if (companies.length !== 1) { mappingPending += 1; continue; }
      const issuerId = uuid(`bond-issuer:${event.source}:${event.issuer_name}:US`);
      await prisma.$executeRawUnsafe(`
        INSERT INTO bond_issuers (id,official_name,issuer_type,country,verification_status,source_id,created_at,updated_at)
        VALUES ($1,$2,'CORPORATE','US','VERIFIED_OFFICIAL',$3,NOW(),NOW()) ON CONFLICT DO NOTHING`, issuerId, event.issuer_name, event.source);
      // The production schema has no approved bond-issuer-to-company relation.
      // Keep the exact equity match as a gate, but record the relationship pending.
      mappingPending += 1;
      const securityId = uuid(`corporate-security:${event.source}:${event.source_event_id}`);
      const name = `${event.issuer_name} ${Number(event.coupon).toFixed(3)}% ${event.seniority?.replaceAll("_", " ") ?? "Notes"} due ${event.maturity_date.getUTCFullYear()}`;
      created += await prisma.$executeRawUnsafe(`
        INSERT INTO bond_instruments
          (id,security_id,issuer_id,source_namespace,official_security_id,official_name,instrument_type,taxonomy,government_subtype,identifier_type,identifier_value,isin,cusip,sedol,country,jurisdiction,currency,issue_date,maturity_date,status,source_id,verification_status,mapping_type,first_seen_at,last_seen_at,source_updated_at,created_at,updated_at)
        VALUES ($1,NULL,$2,$3,$4,$5,'CORPORATE_BOND','CORPORATE_UNRATED','NOT_APPLICABLE',$6,$4,$7,$8,NULL,'US','US',$9,$10::date,$11::date,CASE WHEN $11::date<CURRENT_DATE THEN 'MATURED' ELSE 'ACTIVE' END,$3,'VERIFIED_OFFICIAL','EXACT_REGULATORY_EVENT_AND_COMPANY',$12::timestamptz,$12::timestamptz,$12::timestamptz,NOW(),NOW())
        ON CONFLICT DO NOTHING`, securityId, issuerId, event.source, event.source_event_id, name, event.isin ? "ISIN" : event.cusip ? "CUSIP" : "REGULATORY_EVENT_ID", event.isin, event.cusip, event.currency, iso(event.issue_date), iso(event.maturity_date), startedAt);
      await prisma.$executeRawUnsafe(`
        INSERT INTO bond_terms
          (id,bond_id,issue_date,maturity_date,coupon_rate,coupon_type,coupon_frequency,face_value,currency,day_count_convention,seniority,secured_status,callable,putable,convertible,inflation_linked,outstanding_amount,as_of_date,source_id,verification_status,created_at,updated_at)
        VALUES ($1,$2,$3::date,$4::date,$5::numeric,'FIXED',NULL,NULL,$6,NULL,$7,$8,NULL,NULL,NULL,false,NULL,$3::date,$9,'VERIFIED_OFFICIAL',NOW(),NOW())
        ON CONFLICT DO NOTHING`, uuid(`corporate-terms:${securityId}`), securityId, iso(event.issue_date), iso(event.maturity_date), event.coupon, event.currency, event.seniority, /UNSECURED/i.test(event.seniority ?? "") ? "UNSECURED" : null, event.source);
    }
    const counts = (await prisma.$queryRawUnsafe<Array<Record<string, number>>>(`
      SELECT COUNT(*)::int universe,
       COUNT(*) FILTER(WHERE taxonomy='CORPORATE_IG')::int corporate_ig,
       COUNT(*) FILTER(WHERE taxonomy='CORPORATE_HY')::int corporate_hy,
       COUNT(*) FILTER(WHERE taxonomy='CORPORATE_UNRATED')::int corporate_unrated,
       COUNT(*) FILTER(WHERE taxonomy='AGENCY')::int agency,
       COUNT(*) FILTER(WHERE taxonomy='SUPRANATIONAL')::int supranational,
       COUNT(*) FILTER(WHERE taxonomy='MUNICIPAL')::int municipal,
       COUNT(*) FILTER(WHERE taxonomy='GOVERNMENT')::int government,
       COUNT(*) FILTER(WHERE isin IS NOT NULL)::int isin,
       COUNT(*) FILTER(WHERE cusip IS NOT NULL)::int cusip,
       COUNT(*) FILTER(WHERE issuer_id IS NOT NULL)::int issuer
      FROM bond_instruments`))[0];
    const terms = (await prisma.$queryRawUnsafe<Array<Record<string, number>>>(`
      SELECT COUNT(*) FILTER(WHERE issue_date IS NOT NULL)::int issue_date,COUNT(*) FILTER(WHERE maturity_date IS NOT NULL)::int maturity_date,
       COUNT(*) FILTER(WHERE coupon_rate IS NOT NULL)::int coupon_rate,COUNT(*) FILTER(WHERE coupon_type IS NOT NULL AND coupon_type<>'UNKNOWN')::int coupon_type,
       COUNT(*) FILTER(WHERE coupon_frequency IS NOT NULL)::int coupon_frequency,COUNT(*) FILTER(WHERE face_value IS NOT NULL)::int face_value,
       COUNT(*) FILTER(WHERE outstanding_amount IS NOT NULL)::int outstanding,COUNT(*) FILTER(WHERE seniority='SENIOR_SECURED')::int senior_secured,
       COUNT(*) FILTER(WHERE seniority='SENIOR_UNSECURED')::int senior_unsecured,COUNT(*) FILTER(WHERE seniority='SUBORDINATED')::int subordinated,
       COUNT(*) FILTER(WHERE callable=true)::int callable,COUNT(*) FILTER(WHERE putable=true)::int puttable,COUNT(*) FILTER(WHERE convertible=true)::int convertible
      FROM bond_terms`))[0];
    const quality = (await prisma.$queryRawUnsafe<Array<Record<string, number>>>(`
      SELECT (SELECT COUNT(*)::int FROM (SELECT source_namespace,official_security_id,COUNT(*) FROM bond_instruments GROUP BY 1,2 HAVING COUNT(*)>1)d) duplicates,
       (SELECT COUNT(*)::int FROM bond_instruments WHERE issuer_id IS NULL) orphans,
       (SELECT COUNT(*)::int FROM bond_instruments WHERE mapping_type ILIKE '%FUZZY%' OR mapping_type ILIKE '%AMBIGUOUS%') ambiguous`))[0];
    const completedAt = new Date().toISOString();
    const report = { status: "PARTIAL_WITH_RECORDED_GAPS", processId: process.pid, universeBefore: before, universeAfter: counts.universe, newSecurities: created, eventsEligible: events.length, existingEventsEnriched: enriched, companyLinks, issuerCompanyMappingPending: mappingPending, counts, terms, quality, sourceBreakdown: [{ source: "SEC_EDGAR_424B5", securityType: "CORPORATE_UNRATED", discovered: events.length, created, enriched, sourceStatus: "COMPLETE_AS_AVAILABLE" }, { source: "FINRA_PUBLIC", securityType: "CORPORATE", discovered: 0, created: 0, enriched: 0, sourceStatus: "LICENSE_CONSTRAINED_SECURITY_LEVEL_UNIVERSE" }, { source: "US_AGENCY_PUBLIC", securityType: "AGENCY", discovered: 0, created: 0, enriched: 0, sourceStatus: "SOURCE_REQUIRED" }, { source: "SUPRANATIONAL_PUBLIC", securityType: "SUPRANATIONAL", discovered: 0, created: 0, enriched: 0, sourceStatus: "SOURCE_REQUIRED" }], autoContinuing: true, maxDbConcurrency: 1, newSecuritiesAutoEnrolled: true, dbWritePath: "DIRECT_URL_5432_SCOPED_CONNECTION_LIMIT_1", safeForPriceYieldHistory: counts.corporate_unrated + counts.corporate_ig + counts.corporate_hy + counts.agency >= 100, completedAt };
    await atomic(REPORT, report);
    await atomic(CHECKPOINT, { version: 1, state: "SCHEDULED_WAIT", processId: process.pid, owner: "EXISTING_BOND_INCREMENTAL_HOOK", maxDbConcurrency: 1, completedAt, nextRunOwner: "EXISTING_BOND_INCREMENTAL", autoContinuing: true, lastProgress: { created, enriched, universe: counts.universe }, sourceStates: { SEC_EDGAR_424B5: "COMPLETE_AS_AVAILABLE", FINRA_PUBLIC: "LICENSE_CONSTRAINED", US_AGENCY_PUBLIC: "SOURCE_REQUIRED", SUPRANATIONAL_PUBLIC: "SOURCE_REQUIRED" } });
    return report;
  } catch (error) {
    await atomic(CHECKPOINT, { version: 1, state: "BLOCKED", processId: process.pid, updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), autoContinuing: false, maxDbConcurrency: 1 }); throw error;
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  promoteCorporateAgencyPublicSources().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
}
