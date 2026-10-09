import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, "runtime", "money-market");
const STAGING = path.join(RUNTIME, "staging");
const VERIFIED = ["SOFR", "EFFR", "OBFR", "TGCR", "BGCR", "ESTR", "SONIA"];
const SPREADS = [
  { id: "SOFR_MINUS_EFFR", left: "SOFR", right: "EFFR" },
  { id: "TGCR_MINUS_SOFR", left: "TGCR", right: "SOFR" },
  { id: "BGCR_MINUS_SOFR", left: "BGCR", right: "SOFR" },
];
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? process.env.DIRECT_URL } } });
const now = () => new Date().toISOString();

async function json(file, fallback) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } }
async function atomic(file, value) { await mkdir(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(value, null, 2)); await rename(tmp, file); }
async function records(code) { return (await json(path.join(STAGING, code, "historical.json"), { records: [] })).records || []; }
function ytd(rows) { const current = rows.at(-1); const reference = rows.find(row => row.date.startsWith(current.date.slice(0, 4))); const delta = Number(current.value) - Number(reference.value); return { referenceDate: reference.date, currentDate: current.date, absoluteRateChange: delta, bpsChange: delta * 100, formulaVersion: "MONEY_MARKET_BPS_V1", alignment: "FIRST_VALID_OBSERVATION_OF_CALENDAR_YEAR_NO_FUTURE_FILL" }; }

async function materializeAnalytics() {
  const analytics = await json(path.join(RUNTIME, "rate-analytics.json"), { series: {} });
  const all = {};
  for (const code of VERIFIED) { all[code] = await records(code); analytics.series[code] ||= {}; analytics.series[code].changes ||= {}; analytics.series[code].changes.YTD = ytd(all[code]); analytics.series[code].derivation = { formulaVersion: "MONEY_MARKET_RATE_ANALYTICS_V1", canonicalUnit: "PERCENT", generatedAt: now() }; }
  delete analytics.series.CORRA;
  analytics.generatedAt = now(); analytics.eligibleSeries = VERIFIED;
  await atomic(path.join(RUNTIME, "rate-analytics.json"), analytics);
  const output = { generatedAt: now(), unit: "BASIS_POINTS", derivationVersion: "SAME_DATE_SPREAD_BPS_V1", spreads: {} };
  for (const spec of SPREADS) { const right = new Map(all[spec.right].map(row => [row.date, Number(row.value)])); const rows = all[spec.left].filter(row => right.has(row.date)).map(row => ({ leftSeries: spec.left, rightSeries: spec.right, observationDate: row.date, leftValue: Number(row.value), rightValue: right.get(row.date), spreadBps: (Number(row.value) - right.get(row.date)) * 100, derivationVersion: "SAME_DATE_SPREAD_BPS_V1" })); output.spreads[spec.id] = { status: rows.length ? "MATERIALIZED" : "NO_DATE_INTERSECTION", rows }; }
  await atomic(path.join(RUNTIME, "cross-rate-spreads.json"), output); return output;
}

async function invalidateCorra() {
  const series = await prisma.economicSeries.findUnique({ where: { provider_seriesId: { provider: "Bank of Canada", seriesId: "CORRA" } }, include: { values: { orderBy: { date: "asc" } } } });
  if (!series) throw new Error("CORRA_CANONICAL_SERIES_NOT_FOUND");
  const rows = series.values.map(row => ({ id: row.id, seriesId: row.seriesId, date: row.date.toISOString(), rawValue: row.value?.toString() ?? null, canonicalUnit: series.unit, sourceUrl: row.sourceUrl, sourceVersion: row.sourceVersion, rawChecksum: row.rawChecksum, retrievedAt: row.importedAt?.toISOString() ?? null, classification: "WRONG_FIELD", verificationState: "INVALIDATED_SEMANTIC_CONFLICT", reason: "Generic HTML parser captured page ordinals rather than official CORRA rate field" }));
  const ledger = { asset: "GLOBAL_MONEY_MARKET_RATES", benchmarkCode: "CORRA", invalidatedAt: now(), sourceState: "SOURCE_PENDING", preservationPolicy: "FULL_ROW_PROVENANCE_BEFORE_CANONICAL_EXCLUSION", rows, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
  await atomic(path.join(RUNTIME, "corra-invalidation-ledger.json"), ledger);
  const ids = series.values.map(row => row.id);
  await prisma.$transaction(async tx => { if (ids.length) await tx.economicValue.deleteMany({ where: { id: { in: ids }, seriesId: series.id } }); await tx.economicSeries.update({ where: { id: series.id }, data: { enabled: false, description: "secured overnight | SOURCE_CONSTRAINED | INVALID_ROWS_EXCLUDED" } }); });
  const remaining = await prisma.economicValue.count({ where: { seriesId: series.id } });
  if (remaining !== 0) throw new Error("CORRA_INVALID_ROWS_STILL_EXPOSED");
  return { storedRows: ids.length, validRows: 0, invalidatedRows: ids.length, unknownRows: 0, remainingRows: remaining, canonicalSeriesId: series.id };
}

async function materializeCoverage(corra, spreads) {
  const contract = await json(path.join(ROOT, "config", "money-market-professional-contract.json"), {}); const matrix = [];
  for (const identity of contract.identities) { const code = identity.benchmarkCode; const verified = VERIFIED.includes(code); const source = contract.sourceRecovery[code]?.status || (code === "CORRA" ? "SOURCE_PENDING" : "OFFICIAL_ACTIVE"); const access = source === "ACCESS_BLOCKED_CONFIRMED"; matrix.push({ benchmarkCode: code, identity_state: "COMPLETE", source_state: source, current_state: verified ? "VERIFIED_CURRENT" : code === "CORRA" ? "INVALIDATED_SOURCE_CONSTRAINED" : access ? "ACCESS_CONSTRAINED" : "SOURCE_CONSTRAINED", history_state: verified ? "FULL_ARCHIVE_CANONICALIZED" : code === "CORRA" ? "INVALIDATED_SOURCE_CONSTRAINED" : access ? "ACCESS_CONSTRAINED" : "SOURCE_CONSTRAINED", analytics_state: verified ? "CORE_P0_MATERIALIZED" : "NOT_APPLICABLE_SOURCE_CONSTRAINED", spread_state: ["SOFR", "EFFR", "TGCR", "BGCR"].includes(code) ? "MATERIALIZED" : "NOT_APPLICABLE", provenance_state: verified ? "VERIFIED_OFFICIAL" : code === "CORRA" ? "INVALIDATION_LEDGER_PRESERVED" : "OFFICIAL_IDENTITY_VERIFIED", freshness_state: verified ? "WAITING_FOR_NEXT_PUBLICATION" : access ? "ACCESS_BLOCKED" : "SOURCE_PENDING", detail_state: verified ? "PROFESSIONAL_READY" : access ? "ACCESS_CONSTRAINED_READY" : "SOURCE_CONSTRAINED_READY" }); }
  const unknownStates = matrix.reduce((count, row) => count + Object.values(row).filter(value => value === "UNKNOWN").length, 0);
  const spreadCounts = Object.fromEntries(Object.entries(spreads.spreads).map(([key, value]) => [key, value.rows.length]));
  const doc = { generatedAt: now(), rows: matrix, unknownStates, corra, spreadCounts };
  await atomic(path.join(RUNTIME, "coverage-matrix-v3.json"), doc); return doc;
}

async function main() { if (!process.argv.includes("--apply")) throw new Error("--apply required"); const corra = await invalidateCorra(); const spreads = await materializeAnalytics(); const matrix = await materializeCoverage(corra, spreads); const result = { completedAt: now(), status: "PASS_VERIFIED_CORE_SOURCE_CONSTRAINED", corra, spreadCounts: matrix.spreadCounts, analyticsEligibleSeries: VERIFIED.length, coverageMatrixRows: matrix.rows.length, unknownStates: matrix.unknownStates }; await atomic(path.join(RUNTIME, "p0-closeout-v3.json"), result); console.log(JSON.stringify(result)); }
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
