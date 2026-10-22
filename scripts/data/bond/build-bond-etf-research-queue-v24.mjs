import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve("runtime", "fixed-income", "bond-etf-research-v24");
const now = () => new Date().toISOString();
const priority = [
  ["ISHARES", /ishares|blackrock/i], ["VANGUARD", /vanguard/i],
  ["STATE_STREET_SPDR", /state street|spdr|ssga/i], ["INVESCO", /invesco/i],
  ["JPMORGAN", /j\.?p\.?\s*morgan|jpmorgan/i], ["PIMCO", /pimco/i],
  ["FRANKLIN", /franklin/i], ["FIDELITY", /fidelity/i], ["SCHWAB", /schwab/i],
  ["VANECK", /vaneck/i], ["WISDOMTREE", /wisdomtree/i],
  ["FIRST_TRUST", /first trust/i], ["GLOBAL_X", /global\s*x/i],
];

async function atomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}
function dbUrl() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL_REQUIRED");
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set("connection_limit", "1");
  url.searchParams.set("pgbouncer", "true");
  return url.toString();
}
function issuer(provider = "") {
  return priority.find(([, pattern]) => pattern.test(provider))?.[0] ?? null;
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl() } } });
  await atomic(path.join(ROOT, "checkpoint.json"), { state: "RUNNING", processId: process.pid, checkpoint: "READBACK", maxDbConcurrency: 1, updatedAt: now() });
  try {
    const rows = await prisma.$queryRawUnsafe(`
      WITH bond AS (
        SELECT DISTINCT a.etf_id
        FROM asset_knowledge_tags a JOIN knowledge_tags t ON t.id=a.tag_id
        WHERE a.asset_type='ETF' AND t.tag_key='FIXED_INCOME:BOND_ETF'
      )
      SELECT e.id,e.code,e.name,e.provider,e.benchmark,
        EXISTS(SELECT 1 FROM holdings h WHERE h.etf_id=e.id AND h.asset_type='ETF' AND h.source='BLACKROCK_OFFICIAL_CSV') official_holdings,
        COALESCE((SELECT count(*)::int FROM holdings h WHERE h.etf_id=e.id AND h.asset_type='ETF' AND h.source='BLACKROCK_OFFICIAL_CSV'),0) official_holding_rows
      FROM bond b JOIN etfs e ON e.id=b.etf_id ORDER BY e.provider,e.code,e.id`);
    const worker = JSON.parse(await readFile(path.resolve("runtime", "etf-holdings", "checkpoint.json"), "utf8").catch(() => "{}"));
    const items = rows.map((row) => {
      // In the canonical ETF master `provider` is commonly the listing venue, so
      // issuer routing must also use the official product name.
      const owner = issuer(`${row.name ?? ""} ${row.provider ?? ""}`);
      const existingAdapter = owner === "ISHARES" && ["AGG", "IVV", "IWM"].includes(String(row.code).toUpperCase());
      const fields = {
        ytm: "SOURCE_REQUIRED", ytw: "SOURCE_REQUIRED", effectiveDuration: "SOURCE_REQUIRED",
        modifiedDuration: "SOURCE_REQUIRED", averageMaturity: "SOURCE_REQUIRED", spread: "SOURCE_REQUIRED",
        ratingAllocation: "SOURCE_REQUIRED", maturityAllocation: "SOURCE_REQUIRED",
        sectorAllocation: row.official_holdings ? "DERIVABLE_FROM_OFFICIAL_HOLDINGS" : "SOURCE_REQUIRED",
        countryAllocation: row.official_holdings ? "DERIVABLE_FROM_OFFICIAL_HOLDINGS" : "SOURCE_REQUIRED",
        holdings: row.official_holdings ? "READY" : "SOURCE_REQUIRED",
        benchmark: row.benchmark?.trim() ? "READY" : "SOURCE_REQUIRED",
      };
      return {
        id: `BOND_ETF_RESEARCH:${row.id}`, etfId: row.id, code: row.code, name: row.name,
        provider: row.provider, issuerOwner: owner, state: existingAdapter ? "DELEGATED_EXISTING_WORKER" : owner ? "ADAPTER_REQUIRED" : "SOURCE_LIMITED",
        attempts: 0, checkpoint: row.official_holdings ? `OFFICIAL_HOLDINGS_ROWS:${row.official_holding_rows}` : null,
        fields, updatedAt: now(), lastError: null,
      };
    });
    const count = (predicate) => items.filter(predicate).length;
    const report = {
      status: "ROUTED_WITH_VERIFIED_LIMITS", bondEtfs: items.length,
      ytmReady: 0, ytwReady: 0, durationReady: 0, maturityReady: 0, spreadReady: 0,
      ratingReady: 0, maturityAllocationReady: 0,
      sectorReady: count(x => x.fields.sectorAllocation === "DERIVABLE_FROM_OFFICIAL_HOLDINGS"),
      holdingsReady: count(x => x.fields.holdings === "READY"),
      benchmarkReady: count(x => x.fields.benchmark === "READY"),
      holdingsRowsAdded: 0, researchRowsAdded: 0, databaseWritten: false,
      pending: count(x => x.state === "DELEGATED_EXISTING_WORKER" || x.state === "ADAPTER_REQUIRED"),
      sourceLimited: count(x => x.state === "SOURCE_LIMITED"),
      existingWorker: { state: worker.state ?? null, processId: worker.processId ?? worker.pid ?? null, autoContinuing: worker.autoContinuing === true },
      maxDbConcurrency: 1, yahooHistoryTouched: false, updatedAt: now(),
    };
    await atomic(path.join(ROOT, "work-queue.json"), { version: 1, asset: "FIXED_INCOME", queue: "BOND_ETF_RESEARCH_FIELDS", maxDbConcurrency: 1, items, updatedAt: now() });
    await atomic(path.join(ROOT, "report.json"), report);
    await atomic(path.join(ROOT, "checkpoint.json"), { state: worker.autoContinuing ? "SCHEDULED_WAIT" : "BLOCKED", processId: worker.processId ?? worker.pid ?? null, checkpoint: `ROUTED:${items.length};OFFICIAL_HOLDINGS_READY:${report.holdingsReady}`, autoContinuing: worker.autoContinuing === true, maxDbConcurrency: 1, updatedAt: now() });
    console.log(JSON.stringify(report, null, 2));
  } finally { await prisma.$disconnect(); }
}
main().catch(async (error) => { await atomic(path.join(ROOT, "checkpoint.json"), { state: "BLOCKED", processId: null, lastError: error instanceof Error ? error.message : String(error), autoContinuing: false, maxDbConcurrency: 1, updatedAt: now() }); console.error(error); process.exitCode = 1; });
