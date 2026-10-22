import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const ROOT = path.join(process.cwd(), "runtime", "mops-staging");
const MANIFESTS = path.join(ROOT, "manifests");
const APPLY = process.argv.includes("--apply");
const IDENTITY_RETRY = process.argv.includes("--identity-retry");
const CHECKPOINT = path.join(ROOT, IDENTITY_RETRY ? "security-identity-mapping-checkpoint.json" : "promotion-checkpoint.json");
const RESULT = path.join(ROOT, IDENTITY_RETRY ? "security-identity-mapping-results.json" : "promotion-results.json");
const SOURCE = "TWSE_MOPS_OFFICIAL";
const BATCH_SIZE = 100;

type Row = Record<string, unknown>;
type Manifest = {
  domain: string;
  sourceReference: string;
  fetchedAt: string;
  objectPath: string;
};

function pooledUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL_REQUIRED");
  const url = new URL(raw);
  if (url.port !== "6543") throw new Error("TRANSACTION_POOLER_6543_REQUIRED");
  url.searchParams.set("pgbouncer", "true");
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pool_timeout", "20");
  return url.toString();
}

function uuid(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function rocDate(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^\d{7}$/.test(text)) return null;
  return new Date(Date.UTC(Number(text.slice(0, 3)) + 1911, Number(text.slice(3, 5)) - 1, Number(text.slice(5, 7))));
}

function rocMonth(value: unknown) {
  const text = String(value ?? "").trim();
  if (!/^\d{5}$/.test(text)) return null;
  const year = Number(text.slice(0, 3)) + 1911;
  const month = Number(text.slice(3, 5));
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 0)),
    label: text,
  };
}

function numeric(value: unknown) {
  const text = String(value ?? "").replaceAll(",", "").trim();
  return /^-?\d+(\.\d+)?$/.test(text) ? text : null;
}

async function load() {
  const loaded: Array<{ id: string; manifest: Manifest; rows: Row[] }> = [];
  for (const file of (await readdir(MANIFESTS)).sort()) {
    const manifest = JSON.parse(await readFile(path.join(MANIFESTS, file), "utf8")) as Manifest;
    const payload = JSON.parse(await readFile(path.join(ROOT, manifest.objectPath), "utf8"));
    loaded.push({ id: file.replace(/\.json$/, ""), manifest, rows: Array.isArray(payload) ? payload : payload.data ?? [] });
  }
  return loaded;
}

function classify<T extends { ticker: string }>(items: T[], identities: Array<{ id: string; ticker: string }>) {
  const byTicker = new Map<string, string[]>();
  for (const identity of identities) byTicker.set(identity.ticker, [...(byTicker.get(identity.ticker) ?? []), identity.id]);
  return items.map((item) => {
    const ids = byTicker.get(item.ticker) ?? [];
    return { ...item, mapping: ids.length === 1 ? "MAPPED" : ids.length === 0 ? "UNMAPPED" : "AMBIGUOUS", canonicalId: ids[0] };
  });
}

function classifyMonthly<T extends { ticker: string; dataset: string }>(
  items: T[],
  identities: Array<{ id: string; ticker: string; yahooSymbol: string; exchange: string }>,
) {
  const byTicker = new Map<string, typeof identities>();
  for (const identity of identities) byTicker.set(identity.ticker, [...(byTicker.get(identity.ticker) ?? []), identity]);
  return items.map((item) => {
    const all = byTicker.get(item.ticker) ?? [];
    const exactOfficialSymbol = item.dataset.endsWith("_LISTED")
      ? all.filter((candidate) => candidate.yahooSymbol.toUpperCase() === `${item.ticker}.TW`)
      : [];
    const exactOfficialExchange = item.dataset.endsWith("_LISTED")
      ? all.filter((candidate) => candidate.exchange.toUpperCase() === "TWSE")
      : [];
    const candidates = exactOfficialSymbol.length ? exactOfficialSymbol : exactOfficialExchange.length ? exactOfficialExchange : all;
    return {
      ...item,
      mapping: candidates.length === 1 ? "MAPPED" : candidates.length === 0 ? "UNMAPPED" : "AMBIGUOUS",
      canonicalId: candidates[0]?.id,
    };
  });
}

async function main() {
  const loaded = await load();
  const totalStaging = loaded.reduce((sum, item) => sum + item.rows.length, 0);
  if (totalStaging !== 47_442) throw new Error(`STAGING_COUNT_MISMATCH:${totalStaging}`);

  const monthly = loaded
    .filter((item) => item.manifest.domain === "MONTHLY_REVENUE")
    .flatMap((item) => item.rows.map((row) => ({ dataset: item.id, manifest: item.manifest, row, ticker: String(row["公司代號"] ?? "").trim() })));
  const director = loaded
    .filter((item) => item.id.startsWith("DIRECTOR_HOLDINGS_"))
    .flatMap((item) => item.rows.map((row) => ({ dataset: item.id, manifest: item.manifest, row, ticker: String(row["公司代號"] ?? "").trim() })));
  const ownershipOther = loaded.filter((item) => item.manifest.domain === "MOPS_OWNERSHIP" && !item.id.startsWith("DIRECTOR_HOLDINGS_")).reduce((sum, item) => sum + item.rows.length, 0);
  const capital = loaded.filter((item) => item.manifest.domain === "CAPITAL_FUNDING_RISK").reduce((sum, item) => sum + item.rows.length, 0);
  const investorRelations = loaded.filter((item) => item.manifest.domain === "INVESTOR_RELATIONS").reduce((sum, item) => sum + item.rows.length, 0);

  const prisma = new PrismaClient({ datasources: { db: { url: pooledUrl() } } });
  const startedAt = new Date().toISOString();
  const state = {
    status: APPLY ? "RUNNING" : "DRY_RUN",
    startedAt,
    updatedAt: startedAt,
    concurrency: 1,
    source: SOURCE,
    totals: { monthlyPromoted: 0, ownershipPromoted: 0 },
  };
  if (APPLY) await writeFile(CHECKPOINT, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  try {
    const stockTickers = [...new Set(monthly.map((item) => item.ticker).filter(Boolean))];
    const securityTickers = [...new Set(director.map((item) => item.ticker).filter(Boolean))];
    const stocks = await prisma.stock.findMany({ where: { ticker: { in: stockTickers } }, select: { id: true, ticker: true, yahooSymbol: true, exchange: true } });
    const securities = await prisma.security.findMany({ where: { ticker: { in: securityTickers } }, select: { id: true, ticker: true } });
    const monthlyMapped = classifyMonthly(monthly, stocks);
    const ownershipMapped = classify(director, securities);
    const existingMonthlyKeys = new Set((await prisma.stockFinancialFact.findMany({
      where: { source: SOURCE, metric: "REVENUE_MONTHLY" },
      select: { sourceFactKey: true },
    })).map((row) => row.sourceFactKey));
    const monthlyRetry = monthlyMapped.filter((item) => {
      const period = rocMonth(item.row["資料年月"]);
      return period && !existingMonthlyKeys.has(`MOPS:${item.dataset}:${item.ticker}:${period.label}:MONTHLY_REVENUE`);
    });

    if (APPLY) {
      for (let offset = 0; offset < monthlyMapped.length; offset += BATCH_SIZE) {
        const data = monthlyMapped.slice(offset, offset + BATCH_SIZE).flatMap((item) => {
          if (item.mapping !== "MAPPED") return [];
          const period = rocMonth(item.row["資料年月"]);
          const publicationDate = rocDate(item.row["出表日期"]);
          const value = numeric(item.row["營業收入-當月營收"]);
          if (!period || !value) return [];
          const sourceFactKey = `MOPS:${item.dataset}:${item.ticker}:${period.label}:MONTHLY_REVENUE`;
          if (existingMonthlyKeys.has(sourceFactKey)) return [];
          return [{
            id: uuid(sourceFactKey), stockId: item.canonicalId, metric: "REVENUE_MONTHLY", periodStart: period.start,
            periodEnd: period.end, fiscalPeriod: `MONTH:${period.label}`, formType: "MOPS_MONTHLY_REVENUE",
            filingDate: publicationDate, publicationDate, value, unit: "TWD_THOUSAND", currency: "TWD",
            source: SOURCE, sourceFactKey, sourceDocumentUrl: item.manifest.sourceReference,
            restatementVersion: createHash("sha256").update(JSON.stringify(item.row)).digest("hex"), updatedAt: new Date(),
          }];
        });
        if (data.length) state.totals.monthlyPromoted += (await prisma.stockFinancialFact.createMany({ data, skipDuplicates: true })).count;
        state.updatedAt = new Date().toISOString();
        await writeFile(CHECKPOINT, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      }

      for (let offset = 0; offset < ownershipMapped.length; offset += BATCH_SIZE) {
        const rows = ownershipMapped.slice(offset, offset + BATCH_SIZE).flatMap((item) => {
          if (item.mapping !== "MAPPED") return [];
          const name = String(item.row["姓名"] ?? "").trim();
          const role = String(item.row["職稱"] ?? "").trim();
          const month = rocMonth(item.row["資料年月"]);
          const shares = numeric(item.row["目前持股"]);
          if (!name || !role || !month || !shares) return [];
          const sourceKey = `MOPS_OWNER:${item.ticker}:${role}:${name}`;
          const sourceRecordId = `${item.dataset}:${item.ticker}:${month.label}:${role}:${name}`;
          const ownerId = uuid(sourceKey);
          return [{ item, name, role, shares, month, sourceKey, sourceRecordId, ownerId, relationshipId: uuid(`REL:${sourceRecordId}`), snapshotId: uuid(`SNAP:${sourceRecordId}`) }];
        });
        if (rows.length) {
          await prisma.$executeRaw(Prisma.sql`INSERT INTO insider_owners (id,owner_type,legal_name,country,jurisdiction,status,source,source_key,source_type,source_record_id,source_url,retrieved_at,verification_status,license_status,updated_at) VALUES ${Prisma.join(rows.map((x) => Prisma.sql`(${x.ownerId}::uuid,'UNKNOWN',${x.name},'TW','TW','ACTIVE',${SOURCE},${x.sourceKey},'REGULATOR_OFFICIAL',${x.sourceRecordId},${x.item.manifest.sourceReference},${new Date(x.item.manifest.fetchedAt)},'VERIFIED','PUBLIC_OFFICIAL',now())`))} ON CONFLICT (source_key) DO NOTHING`);
          await prisma.$executeRaw(Prisma.sql`INSERT INTO insider_issuer_relationships (id,owner_id,security_id,is_director,is_officer,is_ten_percent_owner,is_other,normalized_role,raw_role_text,source,source_record_id,source_url,retrieved_at,verification_status,license_status) VALUES ${Prisma.join(rows.map((x) => Prisma.sql`(${x.relationshipId}::uuid,${x.ownerId}::uuid,${x.item.canonicalId},${x.role.includes("董事")},${x.role.includes("經理")},false,false,${x.role.includes("董事") ? "DIRECTOR" : "UNKNOWN"},${x.role},${SOURCE},${x.sourceRecordId},${x.item.manifest.sourceReference},${new Date(x.item.manifest.fetchedAt)},'VERIFIED','PUBLIC_OFFICIAL')`))} ON CONFLICT (id) DO NOTHING`);
          state.totals.ownershipPromoted += await prisma.$executeRaw(Prisma.sql`INSERT INTO insider_ownership_snapshots (id,security_id,owner_id,snapshot_type,disclosure_regime,as_of_date,shares_held,direct_indirect,beneficial_ownership_type,raw_source_text,source,source_type,source_record_id,source_url,retrieved_at,verification_status,quality_status,license_status,parser_name,parser_version) VALUES ${Prisma.join(rows.map((x) => Prisma.sql`(${x.snapshotId}::uuid,${x.item.canonicalId},${x.ownerId}::uuid,'MONTH_END','TW_MOPS',${x.month.end},${x.shares}::numeric,'UNKNOWN','REPORTED_HOLDER',${JSON.stringify(x.item.row)},${SOURCE},'REGULATOR_OFFICIAL',${x.sourceRecordId},${x.item.manifest.sourceReference},${new Date(x.item.manifest.fetchedAt)},'VERIFIED','SOURCE_REPORTED','PUBLIC_OFFICIAL','MOPS_CANONICAL_PROMOTION','1')`))} ON CONFLICT (id) DO NOTHING`);
        }
        state.updatedAt = new Date().toISOString();
        await writeFile(CHECKPOINT, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      }
    }

    const summary = {
      status: APPLY ? "COMPLETE" : "DRY_RUN_COMPLETE",
      stagingRecordsAvailable: totalStaging,
      monthlyRevenue: {
        staging: monthly.length,
        mapped: monthlyMapped.filter((x) => x.mapping === "MAPPED").length,
        promoted: state.totals.monthlyPromoted,
        unmapped: monthlyMapped.filter((x) => x.mapping === "UNMAPPED").length,
        ambiguous: monthlyMapped.filter((x) => x.mapping === "AMBIGUOUS").length,
        retryCandidates: monthlyRetry.length,
        retryMapped: monthlyRetry.filter((x) => x.mapping === "MAPPED").length,
      },
      ownership: {
        staging: director.length + ownershipOther,
        mapped: ownershipMapped.filter((x) => x.mapping === "MAPPED").length,
        promoted: state.totals.ownershipPromoted,
        unmapped: ownershipMapped.filter((x) => x.mapping === "UNMAPPED").length,
        ambiguous: ownershipMapped.filter((x) => x.mapping === "AMBIGUOUS").length,
        skippedNoExactSemantics: ownershipOther,
      },
      capitalCorporateActions: { staging: capital, mapped: 0, promoted: 0, skippedNoExactSemantics: capital },
      investorRelations: { staging: investorRelations, mapped: 0, promoted: 0, skippedDocumentOnly: investorRelations },
      totalPromoted: state.totals.monthlyPromoted + state.totals.ownershipPromoted,
      totalLeftInStaging: totalStaging - state.totals.monthlyPromoted - state.totals.ownershipPromoted,
      newSchemaDomainRecordsLeftInStaging: totalStaging - monthly.length - director.length - ownershipOther - capital - investorRelations,
      duplicatesCreated: 0,
      stagingRawPreserved: true,
      completedAt: new Date().toISOString(),
    };
    if (APPLY) {
      await writeFile(RESULT, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      await writeFile(CHECKPOINT, `${JSON.stringify({ ...state, status: "COMPLETE", completedAt: summary.completedAt }, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
