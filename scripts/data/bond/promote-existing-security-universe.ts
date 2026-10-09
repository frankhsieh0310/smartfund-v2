import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

const RUNTIME = path.resolve("runtime", "fixed-income", "security-universe-terms-expansion");
const CHECKPOINT = path.join(RUNTIME, "checkpoint.json");
const REPORT = path.join(RUNTIME, "report.json");
const GERMANY_ISSUER_ID = "fec0eb62-bad7-523b-a9a8-b40a7e729408";

type Candidate = { id: string; ticker: string; isin: string; name: string; country: string; currency: string; industry: string };

function stableUuid(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32).split("");
  hex[12] = "5"; hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}
function writerUrl(): string {
  const raw = process.env.DIRECT_URL;
  if (!raw) throw new Error("DIRECT_URL_REQUIRED_FOR_FIXED_INCOME_SCOPED_WRITER");
  const url = new URL(raw);
  if (url.port !== "5432") throw new Error("DIRECT_WRITER_5432_REQUIRED");
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("connect_timeout", "20");
  return url.toString();
}
async function atomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}
async function prior(): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(CHECKPOINT, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function maturity(name: string): string | null { return name.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null; }
function subtype(industry: string): "BILL" | "NOTE" {
  return /discount paper/i.test(industry) ? "BILL" : "NOTE";
}

export async function promoteExistingSecurityUniverse(): Promise<Record<string, unknown>> {
  const prisma = new PrismaClient({ datasources: { db: { url: writerUrl() } } });
  const startedAt = new Date().toISOString();
  const previous = await prior();
  await atomic(CHECKPOINT, { version: 1, state: "RUNNING", processId: process.pid, owner: "EXISTING_BOND_INCREMENTAL_HOOK", source: "EXISTING_SECURITIES_CANONICAL", scope: "GERMANY_DBR_EXACT_IDENTITIES", maxDbConcurrency: 1, startedAt, previousCompletedAt: previous?.completedAt ?? null });
  try {
    const before = (await prisma.$queryRawUnsafe<Array<{ rows: number }>>("SELECT COUNT(*)::int rows FROM bond_instruments"))[0].rows;
    const candidates = await prisma.$queryRawUnsafe<Candidate[]>(`
      SELECT s.id,s.ticker,s.isin,s.name,s.country,s.currency,s.industry
      FROM securities s LEFT JOIN bond_instruments b ON b.security_id=s.id
      WHERE b.id IS NULL AND s.country='DE' AND s.ticker LIKE 'DBR-%'
        AND s.isin ~ '^DE[0-9A-Z]{10}$'
        AND s.sector='Federal Republic of Germany'
        AND s.name ~ '20[0-9]{2}-[0-9]{2}-[0-9]{2}$'
      ORDER BY s.ticker`);
    let created = 0;
    for (const row of candidates) {
      const date = maturity(row.name);
      if (!date) continue;
      const id = stableUuid(`bond-instrument:EXISTING_SECURITY_CANONICAL:${row.id}`);
      const inserted = await prisma.$executeRawUnsafe(`
        INSERT INTO bond_instruments
          (id,security_id,issuer_id,source_namespace,official_security_id,official_name,instrument_type,taxonomy,government_subtype,identifier_type,identifier_value,isin,cusip,sedol,country,jurisdiction,currency,issue_date,maturity_date,status,source_id,verification_status,mapping_type,first_seen_at,last_seen_at,created_at,updated_at)
        VALUES ($1,$2,$3,'EXISTING_SECURITY_CANONICAL',$2,$4,$5,'GOVERNMENT',$6,'ISIN',$7,$7,NULL,NULL,'DE','DE','EUR',NULL,$8::date,'ACTIVE','SECURITIES','VERIFIED_EXISTING_DETERMINISTIC','EXACT_ISIN',NOW(),NOW(),NOW(),NOW())
        ON CONFLICT DO NOTHING`, id, row.id, GERMANY_ISSUER_ID, row.name, row.industry, subtype(row.industry), row.isin, date);
      created += inserted;
      await prisma.$executeRawUnsafe(`
        INSERT INTO bond_terms
          (id,bond_id,issue_date,maturity_date,coupon_rate,coupon_type,coupon_frequency,face_value,currency,day_count_convention,seniority,secured_status,callable,putable,convertible,inflation_linked,outstanding_amount,as_of_date,source_id,verification_status,created_at,updated_at)
        VALUES ($1,$2,NULL,$3::date,NULL,$4,NULL,NULL,'EUR',NULL,NULL,NULL,false,false,false,false,NULL,CURRENT_DATE,'SECURITIES','VERIFIED_EXISTING_DETERMINISTIC',NOW(),NOW())
        ON CONFLICT DO NOTHING`, stableUuid(`bond-terms:${id}`), id, date, subtype(row.industry) === "BILL" ? "ZERO_COUPON" : "UNKNOWN");
    }

    const eligible = await prisma.$queryRawUnsafe<Array<{ bond_id: string; maturity_date: string; subtype: string }>>(`
      SELECT b.id bond_id,(regexp_match(s.name,'(20[0-9]{2}-[0-9]{2}-[0-9]{2})$'))[1] maturity_date,b.government_subtype subtype
      FROM bond_instruments b JOIN securities s ON s.id=b.security_id
      WHERE b.country='DE' AND s.ticker LIKE 'DBR-%' AND s.isin ~ '^DE[0-9A-Z]{10}$'
        AND s.name ~ '20[0-9]{2}-[0-9]{2}-[0-9]{2}$'`);
    let enriched = 0;
    for (const row of eligible) {
      enriched += await prisma.$executeRawUnsafe("UPDATE bond_instruments SET maturity_date=$2::date,status=CASE WHEN $2::date<CURRENT_DATE THEN 'MATURED' ELSE 'ACTIVE' END,updated_at=NOW() WHERE id=$1 AND maturity_date IS NULL", row.bond_id, row.maturity_date);
      enriched += await prisma.$executeRawUnsafe("UPDATE bond_terms SET maturity_date=$2::date,coupon_type=CASE WHEN $3='BILL' AND (coupon_type IS NULL OR coupon_type='UNKNOWN') THEN 'ZERO_COUPON' ELSE coupon_type END,updated_at=NOW() WHERE bond_id=$1 AND maturity_date IS NULL", row.bond_id, row.maturity_date, row.subtype);
    }

    const census = (await prisma.$queryRawUnsafe<Array<Record<string, number>>>(`
      SELECT COUNT(*)::int universe,
        COUNT(*) FILTER(WHERE isin IS NOT NULL)::int isin,
        COUNT(*) FILTER(WHERE cusip IS NOT NULL)::int cusip,
        COUNT(*) FILTER(WHERE sedol IS NOT NULL)::int sedol,
        COUNT(*) FILTER(WHERE issuer_id IS NOT NULL)::int issuer,
        COUNT(*) FILTER(WHERE issue_date IS NOT NULL)::int issue_date,
        COUNT(*) FILTER(WHERE maturity_date IS NOT NULL)::int maturity_date,
        COUNT(*) FILTER(WHERE status='ACTIVE')::int active,
        COUNT(*) FILTER(WHERE status='MATURED')::int matured,
        COUNT(*) FILTER(WHERE status='CALLED')::int called,
        COUNT(*) FILTER(WHERE status='REDEEMED')::int redeemed,
        COUNT(*) FILTER(WHERE status='UNKNOWN')::int unknown
      FROM bond_instruments`))[0];
    const terms = (await prisma.$queryRawUnsafe<Array<Record<string, number>>>(`
      SELECT COUNT(*)::int rows,
        COUNT(*) FILTER(WHERE issue_date IS NOT NULL)::int issue_date,
        COUNT(*) FILTER(WHERE maturity_date IS NOT NULL)::int maturity_date,
        COUNT(*) FILTER(WHERE coupon_rate IS NOT NULL)::int coupon_rate,
        COUNT(*) FILTER(WHERE coupon_type IS NOT NULL AND coupon_type<>'UNKNOWN')::int coupon_type,
        COUNT(*) FILTER(WHERE coupon_frequency IS NOT NULL)::int coupon_frequency,
        COUNT(*) FILTER(WHERE face_value IS NOT NULL)::int face_value,
        COUNT(*) FILTER(WHERE currency IS NOT NULL)::int currency,
        COUNT(*) FILTER(WHERE day_count_convention IS NOT NULL)::int day_count,
        COUNT(*) FILTER(WHERE outstanding_amount IS NOT NULL)::int outstanding,
        COUNT(*) FILTER(WHERE callable=true)::int callable,
        COUNT(*) FILTER(WHERE putable=true)::int putable,
        COUNT(*) FILTER(WHERE convertible=true)::int convertible
      FROM bond_terms`))[0];
    const markets = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>("SELECT country market,COUNT(*)::int securities,COUNT(*) FILTER(WHERE maturity_date IS NOT NULL)::int terms FROM bond_instruments GROUP BY country ORDER BY securities DESC");
    const quality = (await prisma.$queryRawUnsafe<Array<Record<string, number>>>(`
      SELECT
       (SELECT COUNT(*)::int FROM (SELECT source_namespace,official_security_id,COUNT(*) FROM bond_instruments GROUP BY 1,2 HAVING COUNT(*)>1)d) duplicates,
       (SELECT COUNT(*)::int FROM bond_instruments WHERE issuer_id IS NULL) orphans,
       (SELECT COUNT(*)::int FROM bond_instruments WHERE mapping_type ILIKE '%FUZZY%' OR mapping_type ILIKE '%AMBIGUOUS%') ambiguous`))[0];
    const completedAt = new Date().toISOString();
    const distinctExistingEnriched = Math.floor(enriched / 2);
    const report = { status: "PARTIAL_WITH_RECORDED_GAPS", processId: process.pid, universeBefore: before, universeAfter: census.universe, newSecuritiesCreated: created, existingSecuritiesEnriched: distinctExistingEnriched, census, terms, markets, quality, sourceStatus: { completeAsAvailable: ["GERMANY_DBR_EXISTING_SECURITY_RECORDS"], partial: ["GLOBAL_GOVERNMENT", "CORPORATE", "AGENCY", "SUPRANATIONAL", "MUNICIPAL", "COVERED_BOND", "STRUCTURED"], sourceLimited: ["PUBLIC_SECURITY_MASTER_OUTSIDE_EXISTING_DETERMINISTIC_RECORDS"], licenseConstrained: ["PROPRIETARY_RATINGS", "FULL_FINRA_TRACE_BOND_HISTORY"], identityPending: [] }, autoContinuing: true, newSecuritiesAutoEnrolled: true, maxDbConcurrency: 1, dbWritePath: "DIRECT_URL_5432_SCOPED_CONNECTION_LIMIT_1", completedAt };
    await atomic(REPORT, report);
    await atomic(CHECKPOINT, { version: 1, state: "SCHEDULED_WAIT", processId: process.pid, owner: "EXISTING_BOND_INCREMENTAL_HOOK", source: "EXISTING_SECURITIES_CANONICAL", scope: "GERMANY_DBR_EXACT_IDENTITIES", maxDbConcurrency: 1, completedAt, nextRunOwner: "EXISTING_BOND_INCREMENTAL", autoContinuing: true, universe: census.universe, lastProgress: { created, enriched: distinctExistingEnriched } });
    return report;
  } catch (error) {
    await atomic(CHECKPOINT, { version: 1, state: "BLOCKED", processId: process.pid, owner: "EXISTING_BOND_INCREMENTAL_HOOK", maxDbConcurrency: 1, updatedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), autoContinuing: false });
    throw error;
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  promoteExistingSecurityUniverse().then((value) => console.log(JSON.stringify(value, null, 2))).catch((error) => { console.error(error); process.exitCode = 1; });
}
