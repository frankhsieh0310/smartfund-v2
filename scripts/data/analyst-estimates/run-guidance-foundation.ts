import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type Row = Record<string, unknown>;
const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, "runtime", "analyst-estimates", "production-foundation");
const UA = "SmartFund-GlobalStockGuidance/1.0 data-operations@smartfund.local";
const now = () => new Date().toISOString();
const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? process.env.DIRECT_URL } } });

async function atomicJson(name: string, value: unknown) {
  await mkdir(RUNTIME, { recursive: true });
  const target = path.join(RUNTIME, name), temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

function exchangeFamily(value: unknown) {
  const x = String(value ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  if (x.includes("NASDAQ")) return "NASDAQ";
  if (x === "NYSE" || x.includes("NEWYORKSTOCKEXCHANGE")) return "NYSE";
  if (x.includes("AMEX") || x.includes("NYSEAMERICAN")) return "AMEX";
  return x;
}

async function secIdentity() {
  const response = await fetch("https://www.sec.gov/files/company_tickers_exchange.json", {
    headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`SEC_IDENTITY_HTTP_${response.status}`);
  const body = await response.json() as { fields?: string[]; data?: unknown[][] };
  const fields = body.fields ?? [], index = Object.fromEntries(fields.map((field, i) => [field, i]));
  const official = (body.data ?? []).map(row => ({
    cik: String(row[index.cik]).padStart(10, "0"), name: String(row[index.name]),
    ticker: String(row[index.ticker]).toUpperCase(), exchange: exchangeFamily(row[index.exchange]),
  })).filter(row => row.cik !== "0000000000" && row.ticker && row.exchange);
  const byKey = new Map<string, typeof official>();
  for (const row of official) { const key = `${row.ticker}|${row.exchange}`; byKey.set(key, [...(byKey.get(key) ?? []), row]); }
  const stocks = await db.$queryRawUnsafe<Row[]>(`SELECT id,ticker,exchange,country FROM stocks WHERE is_active=true AND status='ACTIVE' AND exchange IN ('NASDAQ','NYSE','AMEX') ORDER BY exchange,ticker,id`);
  const mapped: Row[] = [], pending: Row[] = [];
  for (const stock of stocks) {
    const matches = byKey.get(`${String(stock.ticker).toUpperCase()}|${exchangeFamily(stock.exchange)}`) ?? [];
    if (matches.length === 1) mapped.push({ stockId: stock.id, ticker: stock.ticker, exchange: stock.exchange, cik: matches[0].cik, registrantName: matches[0].name, source: "SEC_OFFICIAL_TICKER_EXCHANGE_REGISTRY", verificationStatus: "EXACT_TICKER_AND_EXCHANGE" });
    else pending.push({ stockId: stock.id, ticker: stock.ticker, exchange: stock.exchange, state: matches.length ? "AMBIGUOUS" : "IDENTITY_PENDING", matchCount: matches.length });
  }
  const result = { retrievedAt: now(), officialIdentifiers: official.length, usStocks: stocks.length, mapped: mapped.length, pending: pending.length, mappings: mapped, unresolved: pending };
  await atomicJson("sec-cik-identity.json", result);
  await atomicJson("sec-document-cursor.json", { version: 1, source: "SEC_EDGAR", cursor: null, completedAccessions: [], retry: [], resumable: true, updatedAt: now() });
  return result;
}

function normalizedText(record: Row) {
  const payload = record.originalNormalizedPayload as Row | undefined;
  const fields = (payload?.rawRowFields as Row | undefined) ?? payload ?? {};
  return Object.values(fields).filter(value => typeof value === "string" || typeof value === "number").join(" ").replace(/\s+/g, " ").trim();
}

function classifyMops(text: string) {
  const forward = /預估|預期|展望|財測|目標|將達|可望|預計/;
  const metric = /營收|每股盈餘|EPS|營業利益|毛利率|營業利益率|資本支出|自由現金流|出貨|產量|產能|接單|訂單/i;
  const numeric = /\d+(?:\.\d+)?\s*(?:%|％|億|萬|元|美元|新台幣|片|台|顆|至|到|~|-)/;
  if (!forward.test(text) || !metric.test(text)) return "REJECTED_NOT_GUIDANCE";
  return numeric.test(text) ? "STRUCTURED_CANDIDATE" : "QUALITATIVE_ONLY";
}

async function mopsCanary() {
  const stockCode = "2330", root = path.join(ROOT, "runtime", "mops-by-stock", stockCode);
  const files: string[] = [];
  for (const domain of ["material-events", "investor-relations"]) {
    const dir = path.join(root, domain);
    for (const file of await readdir(dir).catch(() => [])) if (file.endsWith(".json")) files.push(path.join(dir, file));
  }
  files.sort();
  const evaluated: Row[] = [];
  for (const file of files.slice(0, 32)) {
    const records = JSON.parse(await readFile(file, "utf8")) as Row[];
    for (const record of records) {
      const text = normalizedText(record), state = classifyMops(text);
      evaluated.push({ stockCode, recordKey: record.recordKey, sourceReference: record.sourceReference, reportedAt: record.announcementOrReportDate, state, text: text.slice(0, 500) });
    }
  }
  const structured = evaluated.filter(row => row.state === "STRUCTURED_CANDIDATE");
  const qualitative = evaluated.filter(row => row.state === "QUALITATIVE_ONLY");
  const result = { parser: "MOPS_GUIDANCE_CHILD_PARSER_V1", parserRule: "EXPLICIT_FORWARD_LANGUAGE_AND_METRIC_AND_NUMERIC_VALUE", stockCode, artifactsEvaluated: files.slice(0, 32).length, recordsEvaluated: evaluated.length, structuredCandidates: structured.length, qualitativeOnly: qualitative.length, rejectedNotGuidance: evaluated.length - structured.length - qualitative.length, canonicalRowsWritten: 0, promotionStatus: structured.length ? "CANDIDATE_ONLY_PIT_SCHEMA_BLOCKED" : "VALID_EMPTY_NO_EXPLICIT_GUIDANCE_IN_BOUNDED_ARTIFACTS", readback: "N/A", samples: [...structured, ...qualitative].slice(0, 10), completedAt: now() };
  await atomicJson("mops-guidance-canary.json", result);
  return result;
}

async function main() {
  await atomicJson("checkpoint.json", { asset: "GLOBAL_STOCK_GUIDANCE", owner: "FOUNDATION_RECOVERY_14", pid: process.pid, state: "RUNNING", stage: "SEC_IDENTITY", updatedAt: now() });
  const sec = await secIdentity();
  await atomicJson("checkpoint.json", { asset: "GLOBAL_STOCK_GUIDANCE", owner: "FOUNDATION_RECOVERY_14", pid: process.pid, state: "RUNNING", stage: "MOPS_CANARY", sec: { mapped: sec.mapped, pending: sec.pending }, updatedAt: now() });
  const mops = await mopsCanary();
  const result = { asset: "GLOBAL_STOCK_GUIDANCE", status: "FOUNDATION_READY_PARTIAL", pitSchema: "BLOCKED_MIGRATION_GOVERNANCE", sec: { officialIdentifiers: sec.officialIdentifiers, usStocks: sec.usStocks, mapped: sec.mapped, pending: sec.pending, cursorReady: true }, mops, companyIr: { registryReady: true, verifiedIssuerRoutes: 0 }, productionOwner: { contractCreated: true, started: false, reason: "LAUNCH_PREREQUISITES_NOT_ALL_PASS" }, completedAt: now() };
  await atomicJson("completion-manifest.json", result);
  await atomicJson("checkpoint.json", { asset: "GLOBAL_STOCK_GUIDANCE", owner: "FOUNDATION_RECOVERY_14", pid: process.pid, state: "COMPLETE", stage: "FOUNDATION_READY_PARTIAL", updatedAt: now(), next: "RECONCILE_MIGRATION_LEDGER_THEN_APPLY_PIT_SCHEMA" });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(async error => {
  await atomicJson("checkpoint.json", { asset: "GLOBAL_STOCK_GUIDANCE", owner: "FOUNDATION_RECOVERY_14", pid: process.pid, state: "BLOCKED", error: String(error), updatedAt: now() }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
}).finally(() => db.$disconnect());
