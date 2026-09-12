// Canonical FX read API — reads fx_pairs / fx_latest_quotes / fx_candles (the FX Data Platform P0
// tables, migrated 2026-08-05/09, now populated by lib/cron/fxUpdate.ts via /api/cron/yahoo-fx).
// Replaces the previous implementation, which read the generic market_master/market_data rows
// (assetType="FOREX") and derived base/quote by regexing the Yahoo symbol — exactly the "identity
// == provider symbol" anti-pattern the FX P0 spec calls out. Same exported function names/shapes
// (getFxList, searchFx, getFxSummaries, getFxDetail, getFxHistory) so callers — including
// lib/data-platform/web/searchService.ts's FX domain — need no changes.
//
// lib/data-platform/web/compareService.ts still reads market_master/market_data FOREX rows
// directly (its own asset-comparison feature, out of this P0's scope) — flagged, not touched.

import { prisma } from "../../prisma.ts";
import { FX_CURRENCIES } from "../../cloud-ingestion/fxUniverse.ts";
import { WebDataError } from "./errors.ts";
import { freshnessStatus } from "./freshness.ts";
import { normalizePagination, paginationMeta } from "./pagination.ts";
import { buildProvenance } from "./provenance.ts";
import { isoOrNull, numberOrNull, type CanonicalIdentity, type HistoryQuery, type ListQuery, type ServiceResponse, type SummaryMetrics } from "./types.ts";

const currencyNameZh = new Map(FX_CURRENCIES.map((c) => [c.code, c.name]));

// FX-specific freshness display (2026-09-12 hotfix, Step P0-3). FX updates ~every 2 hours, not in
// real time — this must never read as "即時"/live. Reuses the SAME quotedAt this service already
// carries in `meta.asOfDate`; this only adds a human-readable label + a weekend-aware bucket, it is
// not a second freshness engine (freshness.ts's generic MARKET_DAY policy stays untouched and is
// still used for the base `freshnessStatus` field below — this is purely additive).
export type FxFreshnessBucket = "CURRENT" | "DELAYED_SHORT" | "DELAYED_LONG" | "MARKET_CLOSED";
export interface FxFreshnessDisplay {
  bucket: FxFreshnessBucket;
  dataTimeText: string; // "資料時間：2026/09/12 20:00" (empty if no quote yet)
  statusText: string; // "最新資料" / "資料約延遲 2 小時" / "資料可能延遲，等待下一次更新" / "市場休市｜最近資料時間：..."
  updateFrequencyText: string; // "約每 2 小時更新" — constant, matches the registered quote cron cadence
}

const UPDATE_FREQUENCY_TEXT = "約每 2 小時更新";

function taipeiTimeText(d: Date): string {
  const parts = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}`;
}

// FX trades ~24/5 (Mon 06:00 Taipei / Sun 22:00 UTC roughly through Sat 05:00 Taipei). A gap over
// the weekend is a normal closed-market gap, not staleness — never let it read as an error.
function isFxWeekendNow(now: Date): boolean {
  const utcDay = now.getUTCDay(); // 0=Sun..6=Sat
  const utcHour = now.getUTCHours();
  if (utcDay === 6) return true; // all Saturday UTC
  if (utcDay === 0) return true; // all Sunday UTC
  if (utcDay === 1 && utcHour < 6) return true; // early Monday UTC, before the Asia session has had time to post a fresh quote
  return false;
}

export function fxFreshnessDisplay(quotedAt: Date | null | undefined, now: Date = new Date()): FxFreshnessDisplay {
  if (!quotedAt) return { bucket: "DELAYED_LONG", dataTimeText: "", statusText: "資料可能延遲，等待下一次更新", updateFrequencyText: UPDATE_FREQUENCY_TEXT };
  const dataTimeText = `資料時間：${taipeiTimeText(quotedAt)}`;
  if (isFxWeekendNow(now)) return { bucket: "MARKET_CLOSED", dataTimeText, statusText: `市場休市｜最近資料時間：${taipeiTimeText(quotedAt)}`, updateFrequencyText: UPDATE_FREQUENCY_TEXT };
  const ageMs = now.getTime() - quotedAt.getTime();
  if (ageMs <= 2 * 3_600_000) return { bucket: "CURRENT", dataTimeText, statusText: "最新資料", updateFrequencyText: UPDATE_FREQUENCY_TEXT };
  if (ageMs <= 4 * 3_600_000) return { bucket: "DELAYED_SHORT", dataTimeText, statusText: "資料約延遲 2 小時", updateFrequencyText: UPDATE_FREQUENCY_TEXT };
  return { bucket: "DELAYED_LONG", dataTimeText, statusText: "資料可能延遲，等待下一次更新", updateFrequencyText: UPDATE_FREQUENCY_TEXT };
}

// Local widening of ServiceResponse — adds the `fx` display block without touching the shared
// types.ts (other asset services don't need this and aren't touched by this file).
type FxServiceResponse<T> = ServiceResponse<T> & { fx: FxFreshnessDisplay };

type FxPairRow = { symbol: string; baseCurrency: string; quoteCurrency: string; displayPair: string | null; active: boolean };
type FxQuoteRow = { pairSymbol: string; mid: unknown; source: string; quotedAt: Date; ingestedAt: Date; metadata: unknown } | null;

const fxIdentity = (row: FxPairRow): CanonicalIdentity => ({
  assetType: "FX",
  id: row.symbol,
  symbol: row.symbol,
  name: row.displayPair ?? `${row.baseCurrency}/${row.quoteCurrency}`,
  displayName: `${currencyNameZh.get(row.baseCurrency) ?? row.baseCurrency}/${currencyNameZh.get(row.quoteCurrency) ?? row.quoteCurrency}`,
  currency: row.quoteCurrency,
  market: "GLOBAL_FX",
  country: null,
});

function fxMetrics(row: FxPairRow, quote: FxQuoteRow): SummaryMetrics {
  const price = numberOrNull(quote?.mid);
  const meta = (quote?.metadata as { previousClose?: number } | null) ?? null;
  const prev = numberOrNull(meta?.previousClose);
  const change = price != null && prev != null ? price - prev : null;
  const changePercent = change != null && prev ? (change / prev) * 100 : null;
  return { priceOrNav: price, change, changePercent, currency: row.quoteCurrency, asOfDate: isoOrNull(quote?.quotedAt), performance1M: null, performance3M: null, performance1Y: null };
}

async function latestQuotesFor(symbols: string[]): Promise<Map<string, FxQuoteRow>> {
  if (!symbols.length) return new Map();
  const rows = await prisma.fxLatestQuote.findMany({ where: { pairSymbol: { in: symbols } } });
  return new Map(rows.map((r) => [r.pairSymbol, r]));
}

export async function getFxList(query: ListQuery = {}): Promise<FxServiceResponse<Array<{ identity: CanonicalIdentity; metrics: SummaryMetrics }>>> {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const term = query.query?.trim();
  const termUpper = term?.toUpperCase();
  const where = {
    active: true,
    ...(term
      ? { OR: [
          { symbol: { contains: term, mode: "insensitive" as const } },
          { displayPair: { contains: term, mode: "insensitive" as const } },
          { baseCurrency: { equals: termUpper } },
          { quoteCurrency: { equals: termUpper } },
        ] }
      : {}),
  };
  const [total, rows] = await prisma.$transaction([prisma.fxPair.count({ where }), prisma.fxPair.findMany({ where, skip, take: pageSize, orderBy: { symbol: "asc" } })]);
  const quotes = await latestQuotesFor(rows.map((r) => r.symbol));
  const latest = rows.reduce<Date | null>((value, row) => {
    const q = quotes.get(row.symbol)?.quotedAt ?? null;
    return !value || (q && q > value) ? q : value;
  }, null);
  const updated = rows.reduce<Date | null>((value, row) => {
    const q = quotes.get(row.symbol)?.ingestedAt ?? null;
    return !value || (q && q > value) ? q : value;
  }, null);
  const provenance = buildProvenance({ source: "YAHOO_SPARK", asOfDate: latest, lastUpdated: updated });
  return {
    data: rows.map((row) => ({ identity: fxIdentity(row), metrics: fxMetrics(row, quotes.get(row.symbol) ?? null) })),
    meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(latest, "MARKET_DAY"), source: provenance.source, provenance, coverageStatus: "FULL" },
    pagination: paginationMeta(page, pageSize, total),
    error: null,
    fx: fxFreshnessDisplay(latest),
  };
}

export const searchFx = (query: string, options: Omit<ListQuery, "query"> = {}) => getFxList({ ...options, query });

export async function getFxSummaries(identifiers: readonly string[]) {
  const keys = [...new Set(identifiers.map((v) => v.trim().toUpperCase().replace("/", "")).filter(Boolean))].slice(0, 10);
  if (!keys.length) return [];
  const rows = await prisma.fxPair.findMany({ where: { active: true, symbol: { in: keys } }, orderBy: { symbol: "asc" } });
  const quotes = await latestQuotesFor(rows.map((r) => r.symbol));
  return rows.map((row) => {
    const q = quotes.get(row.symbol) ?? null;
    const provenance = buildProvenance({ source: "YAHOO_SPARK", sourceRecordId: row.symbol, asOfDate: q?.quotedAt, lastUpdated: q?.ingestedAt });
    return { data: { identity: fxIdentity(row), metrics: fxMetrics(row, q) }, meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(q?.quotedAt, "MARKET_DAY"), source: provenance.source, provenance, coverageStatus: "FULL" as const }, fx: fxFreshnessDisplay(q?.quotedAt ?? null) };
  });
}

async function findFx(identifier: string): Promise<FxPairRow | null> {
  const key = decodeURIComponent(identifier).trim();
  if (!key) throw new WebDataError("INVALID_QUERY", "An FX pair is required.");
  const normalized = key.replace("/", "").toUpperCase();
  return prisma.fxPair.findFirst({ where: { OR: [{ symbol: key }, { symbol: normalized }, { displayPair: { equals: key, mode: "insensitive" } }] } });
}

export async function getFxDetail(identifier: string): Promise<FxServiceResponse<{ identity: CanonicalIdentity; metrics: SummaryMetrics }>> {
  const row = await findFx(identifier);
  if (!row) throw new WebDataError("NOT_FOUND", "FX pair not found.");
  const quote = await prisma.fxLatestQuote.findUnique({ where: { pairSymbol: row.symbol } });
  const provenance = buildProvenance({ source: quote?.source ?? "YAHOO", sourceRecordId: row.symbol, asOfDate: quote?.quotedAt, lastUpdated: quote?.ingestedAt });
  return {
    data: { identity: fxIdentity(row), metrics: fxMetrics(row, quote) },
    meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(quote?.quotedAt, "MARKET_DAY"), source: provenance.source, provenance, coverageStatus: "FULL" },
    pagination: null,
    error: null,
    fx: fxFreshnessDisplay(quote?.quotedAt ?? null),
  };
}

export async function getFxHistory(identifier: string, query: HistoryQuery = {}) {
  const { page, pageSize, skip } = normalizePagination(query.page, query.pageSize);
  const pair = await findFx(identifier);
  if (!pair) throw new WebDataError("NOT_FOUND", "FX pair not found.");
  const cursorDate = query.cursor ? new Date(query.cursor) : null;
  if (cursorDate && Number.isNaN(cursorDate.getTime())) throw new WebDataError("INVALID_QUERY", "Invalid history cursor.");
  const where = {
    pairSymbol: pair.symbol,
    interval: "1d",
    openTime: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}), ...(cursorDate ? { lt: cursorDate } : {}) },
  };
  const [total, rows] = await prisma.$transaction([
    prisma.fxCandle.count({ where }),
    prisma.fxCandle.findMany({ where, skip: cursorDate ? 0 : skip, take: pageSize, orderBy: { openTime: "desc" } }),
  ]);
  const provenance = buildProvenance({ source: rows[0]?.source ?? "YAHOO_CHART", sourceRecordId: pair.symbol, asOfDate: rows[0]?.openTime, lastUpdated: rows[0]?.ingestedAt });
  return {
    data: rows.map((row) => ({ date: row.openTime.toISOString(), open: numberOrNull(row.open), high: numberOrNull(row.high), low: numberOrNull(row.low), close: Number(row.close), change: null, changePercent: null, volume: numberOrNull(row.volume), source: row.source })),
    meta: { asOfDate: provenance.asOfDate, lastUpdated: provenance.lastUpdated, freshnessStatus: freshnessStatus(rows[0]?.openTime, "MARKET_DAY"), source: provenance.source, provenance, coverageStatus: "FULL" as const },
    pagination: paginationMeta(page, pageSize, total, rows.length === pageSize ? rows.at(-1)?.openTime.toISOString() ?? null : null),
    error: null,
    fx: fxFreshnessDisplay(rows[0]?.openTime ?? null),
  };
}
