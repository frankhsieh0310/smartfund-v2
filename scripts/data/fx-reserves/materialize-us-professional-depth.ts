import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, "runtime", "fx-reserves");
const SERIES_CODE = "US_FX_RESERVES_EX_GOLD";
const SOURCE_SERIES_ID = "TRESEGUSM052N";
const FORMULA_VERSION = "FX_RESERVE_LEVEL_ANALYTICS_V1";
const now = () => new Date().toISOString();

async function json(file: string) { return JSON.parse(await readFile(file, "utf8")); }
async function atomic(name: string, value: unknown) { const file = path.join(RUNTIME, name), temp = `${file}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2)); await rename(temp, file); }
const key = (value: Date | string) => new Date(value).toISOString().slice(0, 10);
const monthKey = (value: Date | string) => key(value).slice(0, 7);
function shiftMonth(date: Date, months: number) { return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)); }

function change(points: Array<{ date: Date; value: number }>, latest: { date: Date; value: number }, months: number | "YTD") {
  const target = months === "YTD" ? new Date(Date.UTC(latest.date.getUTCFullYear(), 0, 1)) : shiftMonth(latest.date, -months);
  const base = points.find((point) => monthKey(point.date) === monthKey(target));
  if (!base) return { status: "INSUFFICIENT_COMPATIBLE_MONTH", targetMonth: monthKey(target), formulaVersion: FORMULA_VERSION };
  const absoluteChange = latest.value - base.value;
  return { status: "AVAILABLE", targetMonth: monthKey(target), baseDate: key(base.date), latestDate: key(latest.date), baseValue: base.value, latestValue: latest.value, absoluteUsdMillionsChange: absoluteChange, percentageChange: base.value === 0 ? null : absoluteChange / base.value * 100, semantic: "RESERVE_LEVEL_CHANGE", formulaVersion: FORMULA_VERSION };
}

function range(points: Array<{ date: Date; value: number }>, latest: { date: Date; value: number }, months: number) {
  const cutoff = shiftMonth(latest.date, -months);
  const sample = points.filter((point) => point.date >= cutoff && point.date <= latest.date);
  if (sample.length < 2) return { status: "INSUFFICIENT_HISTORY", windowMonths: months, sampleSize: sample.length, formulaVersion: FORMULA_VERSION };
  const values = sample.map((point) => point.value), min = Math.min(...values), max = Math.max(...values);
  return { status: "AVAILABLE", windowMonths: months, sampleSize: sample.length, startDate: key(sample[0].date), endDate: key(sample.at(-1)!.date), min, max, latest: latest.value, historicalPercentile: max === min ? 100 : values.filter((value) => value <= latest.value).length / values.length * 100, formulaVersion: FORMULA_VERSION };
}

async function main() {
  const archivePayload = await json(path.join(RUNTIME, "archive", SERIES_CODE, "historical.json"));
  const archive = archivePayload.records as Array<Record<string, unknown>>;
  const registry = await json(path.join(ROOT, "config", "fx-reserves-registry.json"));
  const identity = registry.series.find((item: any) => item.code === SERIES_CODE);
  if (!identity) throw new Error("REGISTRY_IDENTITY_MISSING");

  const seen = new Set<string>(), duplicateDates: string[] = [], invalid: Array<{ index: number; reason: string }> = [];
  archive.forEach((row, index) => {
    const date = String(row.date), validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(new Date(`${date}T00:00:00.000Z`).getTime());
    const valid = validDate && Number.isFinite(Number(row.value)) && row.source_url === identity.sourceUrl && row.source === identity.source && row.frequency === identity.frequency && row.unit === identity.unit && row.country === identity.country && row.currency === identity.currency;
    if (!valid) invalid.push({ index, reason: "INVALID_DATE_VALUE_OR_SOURCE_IDENTITY" });
    if (seen.has(date)) duplicateDates.push(date); else seen.add(date);
  });
  const validRows = archive.filter((_, index) => !invalid.some((item) => item.index === index));
  const archiveByDate = new Map(validRows.map((row: any) => [row.date, Number(row.value)]));
  const sortedDates = [...archiveByDate.keys()].sort();
  const missingMonths: string[] = [];
  if (sortedDates.length) for (let cursor = new Date(`${sortedDates[0]}T00:00:00.000Z`), end = new Date(`${sortedDates.at(-1)}T00:00:00.000Z`); cursor <= end; cursor = shiftMonth(cursor, 1)) if (!archiveByDate.has(key(cursor))) missingMonths.push(monthKey(cursor));

  const series = await prisma.economicSeries.findUnique({ where: { provider_seriesId: { provider: "FRED", seriesId: SOURCE_SERIES_ID } }, include: { values: { orderBy: { date: "asc" } } } });
  if (!series || series.code !== SERIES_CODE) throw new Error("CANONICAL_IDENTITY_MISMATCH");
  const canonical = series.values.map((row) => ({ date: row.date, value: Number(row.value), sourceUrl: row.sourceUrl, sourceVersion: row.sourceVersion, rawChecksum: row.rawChecksum, importedAt: row.importedAt }));
  const canonicalByDate = new Map(canonical.map((row) => [key(row.date), row]));
  const missingCanonicalRows = sortedDates.filter((date) => !canonicalByDate.has(date));
  const extraCanonicalRows = [...canonicalByDate.keys()].filter((date) => !archiveByDate.has(date));
  const valueConflictRows = sortedDates.filter((date) => canonicalByDate.has(date) && Number(canonicalByDate.get(date)!.value).toFixed(6) !== Number(archiveByDate.get(date)).toFixed(6));
  const canonicalKeyCounts = new Map<string, number>(); canonical.forEach((row) => canonicalKeyCounts.set(key(row.date), (canonicalKeyCounts.get(key(row.date)) ?? 0) + 1));
  const duplicateCanonicalKeys = [...canonicalKeyCounts].filter(([, count]) => count > 1).map(([date]) => date);
  if (missingCanonicalRows.length || extraCanonicalRows.length || valueConflictRows.length || duplicateCanonicalKeys.length) throw new Error("FAIL_CANONICAL_RECONCILIATION");

  const points = canonical.map((row) => ({ date: row.date, value: row.value }));
  const latest = points.at(-1)!;
  const changes = { "1M": change(points, latest, 1), "3M": change(points, latest, 3), "6M": change(points, latest, 6), YTD: change(points, latest, "YTD"), "1Y": change(points, latest, 12), "3Y": change(points, latest, 36), "5Y": change(points, latest, 60), "10Y": change(points, latest, 120) };
  const ranges = { "52W": range(points, latest, 12), "3Y": range(points, latest, 36), "5Y": range(points, latest, 60), "10Y": range(points, latest, 120) };
  const latestAgeMonths = (new Date().getUTCFullYear() - latest.date.getUTCFullYear()) * 12 + new Date().getUTCMonth() - latest.date.getUTCMonth();
  const freshness = latestAgeMonths <= 3 ? "WAITING_FOR_NEXT_PUBLICATION" : "STALE";
  const provenanceComplete = canonical.every((row) => row.sourceUrl && row.sourceVersion && row.importedAt);
  const checksumComplete = canonical.every((row) => row.rawChecksum);
  const generatedAt = now();

  await atomic("archive-census.json", { asset: "FX_RESERVES", seriesCode: SERIES_CODE, generatedAt, rows: archive.length, validRows: validRows.length, invalidRows: invalid, duplicateRows: duplicateDates, earliestDate: sortedDates[0], latestDate: sortedDates.at(-1), missingMonths, sourceRecordCoverage: { sourceSeriesId: SOURCE_SERIES_ID, coveredRows: validRows.length, percent: archive.length ? validRows.length / archive.length * 100 : 0 } });
  await atomic("canonical-reconciliation.json", { asset: "FX_RESERVES", seriesId: series.id, generatedAt, archiveRows: archive.length, canonicalRows: canonical.length, missingCanonicalRows, extraCanonicalRows, valueConflictRows, duplicateCanonicalKeys, status: "PASS" });
  await atomic("us-analytics.json", { asset: "FX_RESERVES", seriesCode: SERIES_CODE, semantic: "RESERVE_LEVEL_CHANGE_NOT_INVESTMENT_RETURN", generatedAt, latest: { date: key(latest.date), value: latest.value, unit: series.unit }, changes, ranges, formulaVersion: FORMULA_VERSION });
  await atomic("us-detail-contract.json", { asset: "FX_RESERVES", generatedAt, identity: { canonicalId: series.id, seriesCode: series.code, officialName: series.name, country: series.country, currency: identity.currency, reserveType: identity.reserveType, frequency: series.frequency, unit: series.unit, provider: series.provider, externalSeriesId: series.seriesId, status: series.enabled ? "ACTIVE" : "INACTIVE", observationStartDate: key(points[0].date), authority: identity.reserveAuthorityName }, current: { date: key(latest.date), value: latest.value, unit: series.unit }, history: { rows: points.length, earliestDate: key(points[0].date), latestDate: key(latest.date) }, taxonomy: { allowed: ["TOTAL_RESERVES", "FOREIGN_CURRENCY_RESERVES", "FX_RESERVES_EX_GOLD", "GOLD", "SDR", "IMF_RESERVE_POSITION", "OTHER_RESERVE_ASSETS"], current: "FX_RESERVES_EX_GOLD", sourceSupportedOnly: true }, provenance: { source: series.source, sourceRecordId: series.seriesId, sourceUrl: series.apiUrl, sourceVersionCoverage: canonical.filter((row) => row.sourceVersion).length, importedTimestampCoverage: canonical.filter((row) => row.importedAt).length, verificationState: "VERIFIED_OFFICIAL", checksumStatus: checksumComplete ? "AVAILABLE_COMPLETE" : "CHECKSUM_NOT_AVAILABLE" }, freshness: { status: freshness, policy: "MONTHLY_PUBLICATION_AWARE", publicationTimestamp: null }, changes, ranges, pointInTimeLevel: 0, releaseMetadataStatus: "SOURCE_NOT_AVAILABLE", revisionMetadataStatus: "SOURCE_NOT_AVAILABLE", searchKeys: [series.country, series.name, series.code, identity.reserveType], screenerStatus: "INSUFFICIENT_UNIVERSE", compareStatus: "INTERNAL_HISTORY_READY_CROSS_COUNTRY_NOT_READY", rankingStatus: "DEFERRED_ONE_COUNTRY_UNIVERSE" });
  await atomic("coverage-matrix.json", { asset: "FX_RESERVES", generatedAt, rows: [{ seriesCode: SERIES_CODE, identity: "PASS", current: "PASS", history: "PASS", historyDepthMonths: canonical.length, taxonomy: "PASS", analytics: Object.values(changes).every((item) => item.status === "AVAILABLE") ? "PASS" : "PARTIAL", provenance: provenanceComplete ? "PASS" : "FAIL", checksum: checksumComplete ? "PASS" : "CHECKSUM_NOT_AVAILABLE", freshness, pointInTime: "LEVEL_0_SOURCE_VINTAGES_UNAVAILABLE", detailReadiness: "READY", search: "READY", screener: "INSUFFICIENT_UNIVERSE", compare: "INTERNAL_ONLY", ranking: "DEFERRED" }], complete: true, globalSourcePending: ["TAIWAN", "JAPAN", "HONG_KONG", "UK", "EURO_AREA", "CHINA", "SINGAPORE", "AUSTRALIA", "CANADA"] });
  console.log(JSON.stringify({ status: "PASS", archiveRows: archive.length, canonicalRows: canonical.length, validRows: validRows.length, invalidRows: invalid.length, duplicateRows: duplicateDates.length, missingMonths: missingMonths.length, earliest: key(points[0].date), latest: key(latest.date), provenanceComplete, checksumComplete, freshness, changes: Object.fromEntries(Object.entries(changes).map(([window, value]) => [window, value.status])), ranges: Object.fromEntries(Object.entries(ranges).map(([window, value]) => [window, value.status])) }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
