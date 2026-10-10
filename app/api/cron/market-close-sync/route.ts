// Market-close-sync. Confirms, per eligible closed market, what Yahoo Spark would write vs what
// etf_history/etfs already have, and logs the comparison. SHADOW MODE BY DEFAULT: unless the
// MARKET_CLOSE_SYNC_WRITE environment variable is exactly "on" (lib/market-close-sync/writeGate.ts),
// this route writes NOTHING to etf_history/etfs/etf_performances — only the existing run-log/
// checkpoint tables via beginRun/finishRun/writeCheckpoint (lib/cloud-ingestion/runContext), reused
// unmodified. Task P adds the opt-in write path (lib/market-close-sync/priceWriter.ts) — see its own
// header for exactly what gets written and when.
//
// ETF-only, per task scope. No stock/fund handling here.
//
// Task K: a market is now only reported doneForToday once lib/market-close-sync/completionState.ts's
// isMarketDone() says every candidate ETF reached a genuinely FINAL state.
//
// Task L, two more changes:
//   1. Core-universe filter (lib/market-close-sync/coreUniverse.ts) — the sweep's candidate query now
//      only considers ETFs that actually trade with some regularity, dropping dead/barely-traded rows
//      and Hong Kong's duplicate currency-counter listings from the daily rotation without touching
//      the DB rows themselves.
//   2. Scheduling fairness (lib/market-close-sync/scheduling.ts) — markets still mid-sweep are always
//      processed before markets only waiting on a confirmation recheck, a recheck is never attempted
//      before its entry is actually due, and no single market may consume more than 40% of the time
//      budget in one invocation — fixing Task K's observed failure mode where the UK's ~5,700-ETF
//      universe alone consumed entire 240s invocations and left most other markets NOT_REACHED, run
//      after run.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { loadExchangeCalendarRegistry, SUFFIX_TO_JOB_ID, NO_SUFFIX_EXCHANGE_FALLBACK, resolveJobForEtf, jobById } from "@/lib/market-close-sync/marketConfig";
import { findEligibleTradeDate, pickClosedCandle, localDateFromUnix, isDefinitelyClosed } from "@/lib/market-close-sync/marketTime";
import { fetchSparkBatch, SPARK_MAX_SYMBOLS_PER_BATCH } from "@/lib/market-close-sync/sparkClient";
import { classify } from "@/lib/market-close-sync/shadowCompare";
import { emptyState, advanceSweep, isMarketDone, computeDbGapIds, type MarketCompletionState, type FinalOrPendingClassification } from "@/lib/market-close-sync/completionState";
import { classifyMarketPriority, orderMarketsForInvocation, isDueForRecheck, PER_MARKET_BUDGET_FRACTION, fifteenMinuteBucketKey } from "@/lib/market-close-sync/scheduling";
import { isHongKongCurrencyCounter, isCoreUniverseMemberFromCounts, SUFFIX_ACTIVITY_MEASURE } from "@/lib/market-close-sync/coreUniverse";
import { resolvePrice, type PriceSource } from "@/lib/market-close-sync/priceSource";
import { checkPriceSanity, reviewPriceJump } from "@/lib/market-close-sync/priceSanity";
import { isWriteEnabled, currentRunMode, writeEnvDiagnostic } from "@/lib/market-close-sync/writeGate";
import { writeBatchIfEnabled, type WritablePrice } from "@/lib/market-close-sync/priceWriter";
import type { ShadowClassification, ExchangeCalendarJob, SparkCandle } from "@/lib/market-close-sync/types";

const YAHOO_CONSISTENCY_RELATIVE_TOLERANCE = 0.001; // 0.1%

function isPriceWithinTolerance(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale <= YAHOO_CONSISTENCY_RELATIVE_TOLERANCE;
}

function daysBetweenLocalDates(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "MARKET_CLOSE_SYNC_SHADOW";
const TIME_BUDGET_MS = 240_000;
const PER_MARKET_BUDGET_MS = TIME_BUDGET_MS * PER_MARKET_BUDGET_FRACTION;
const REQUEST_DELAY_MS = 300;
const DB_DATE_WINDOW_DAYS = 2;
const CORE_UNIVERSE_LOOKBACK_DAYS = 20;

// Task M: quoteResolutions tracks, for etf_ids currently resolved via QUOTE_AFTER_CLOSE, which
// targetLocalDate+price that was — purely this shadow pipeline's own bookkeeping (never written to
// etf_history). When a LATER invocation sees a real daily bar for the SAME etf_id+date, rule 4 fires:
// the bar wins, and the difference between it and the earlier quote is logged (see sourceSwitches on
// MarketDetail), never silently dropped. Entries are only ever kept for the market's CURRENT
// targetLocalDate — once a date is fully done and the market moves on, its old entries are simply
// not reloaded (there is no mechanism, nor a need, to keep watching a date this pipeline has already
// finished with).
type QuoteResolution = { etfId: string; targetLocalDate: string; symbol: string; price: number };
// Task W4: lastDoneDate is now only a FAST-PATH HINT, never trusted on its own — every invocation
// re-verifies it against a real DB query (see dbGapIdsFor below) before treating a market as actually
// done for that date. lastDoneDateTerminalNonWrite carries forward exactly the terminalNonWrite map
// the sweep had accumulated AT THE MOMENT lastDoneDate was set, since completionState.ts's
// MarketCompletionState (and its terminalNonWrite) is discarded once a market moves past
// targetLocalDate — without this, the DB-gap check would have no way to know an ETF was legitimately
// SOURCE_MISSING/NO_TRADE_ON_TARGET/UNIT_MISMATCH/PRICE_JUMP_REVIEW for a date that's no longer "in
// progress".
type PersistedState = {
  v: 3;
  lastDoneDate: string | null;
  lastDoneDateTerminalNonWrite: Record<string, FinalOrPendingClassification>;
  inProgress: MarketCompletionState | null;
  quoteResolutions?: QuoteResolution[];
};

function parsePersistedState(raw: string | null): PersistedState {
  if (!raw) return { v: 3, lastDoneDate: null, lastDoneDateTerminalNonWrite: {}, inProgress: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === 3) return parsed as PersistedState;
    // v2 (pre-Task-W4) or v1 or garbage — a market marked done under the old rules was never
    // DB-gap-verified, so it is deliberately NOT carried forward as lastDoneDate here: re-deriving a
    // trustworthy lastDoneDateTerminalNonWrite from a v2 record is not possible (that map didn't
    // exist yet), and treating an unverified old "done" as still done would be exactly the bug this
    // task fixes. A fresh start costs one extra DB-gap-verified pass per market, not a correctness
    // problem.
  } catch {
    // garbage — treated as a fresh start.
  }
  return { v: 3, lastDoneDate: null, lastDoneDateTerminalNonWrite: {}, inProgress: null };
}

type SourceSwitch = { symbol: string; quotePrice: number; barClose: number; diff: number };

/** Resolves one ETF's price (rule 1: BAR, rule 2: QUOTE_FINAL, rule 3: NO_TRADE_ON_TARGET, rule 4:
 * unresolved — see priceSource.ts) and classifies it against the DB row. classify() is never called
 * for a NO_TRADE_ON_TARGET resolution — there is no DB-vs-source price comparison to make, it's a
 * statement about market activity, not price, and NO_TRADE_ON_TARGET is already its own final
 * ShadowClassification (see completionState.ts). Also applies Task M's rule 4: if this resolves to
 * BAR for an etf_id+date that quoteResolutions still remembers as QUOTE_FINAL, logs the switch and
 * the price delta, then forgets it. Mutates quoteResolutions and sourceSwitches in place — called
 * once per candidate, in both the sweep and the recheck phase, so the two phases can never drift
 * into different resolution logic. */
function resolveAndClassify(
  etf: { id: string; data_source: string },
  candle: SparkCandle | undefined,
  dbRows: Map<string, { date: string; close: number }>,
  lastKnownCloses: Map<string, number>,
  job: ExchangeCalendarJob,
  targetLocalDate: string,
  now: Date,
  quoteResolutions: Map<string, QuoteResolution>,
  sourceSwitches: SourceSwitch[],
): {
  classification: ShadowClassification; sourceUsed: PriceSource | null; yahooMatch: boolean | null;
  yahooDetail?: { ourDate: string; ourPrice: number; yahooDate: string; yahooPrice: number };
  sanityDetail?: { newPrice: number; lastKnownClose: number };
  resolvedPrice: number | null; // Task P: whatever price actually resolved (any RESOLVED kind), for the write path to use directly — never recomputed a second time.
} {
  const sparkSymbolPresent = candle !== undefined;
  const points = candle?.points ?? [];
  const picked = pickClosedCandle(points, job, targetLocalDate, now);
  const dbRow = dbRows.get(etf.id);
  const dbDate = dbRow?.date ?? null;
  const dbClose = dbRow?.close ?? null;

  const resolved = resolvePrice({
    job, targetLocalDate, now, barClose: picked?.close ?? null,
    quoteRegularMarketTimeUnix: candle?.regularMarketTimeUnix ?? null,
    quoteRegularMarketPrice: candle?.regularMarketPrice ?? null,
    localDateFromUnix, isDefinitelyClosed,
  });

  // "與 Yahoo 一致率": if this invocation HAD written its resolved (date, price) to etf_history,
  // would it equal what Yahoo's own live quote (Spark's meta.regularMarketTime/regularMarketPrice —
  // the same field Yahoo's own web page reads) shows right now? Computed from data already in hand
  // this batch (no extra network calls). Only meaningful when a price actually resolved — null
  // (not applicable) for SOURCE_MISSING/NO_BAR_FOR_TARGET_DATE/NO_TRADE_ON_TARGET, which have no
  // "price we'd have written" to compare in the first place. For a QUOTE_FINAL resolution this is
  // true by construction (the resolved price IS the live quote); for a BAR resolution it genuinely
  // tests whether the finalized daily bar still agrees with Yahoo's current live quote.
  //
  // Task O widens what counts as "consistent", per live evidence this round showing most
  // "mismatches" were never real discrepancies:
  //   - price tolerance is now RELATIVE 0.1%, not an absolute cent — a 50000-point Korean bond ETF
  //     moving by 3 units is well within rounding/precision noise, not a real divergence.
  //   - our resolved date one calendar day AFTER Yahoo's live quote date, with the SAME price, is
  //     also consistent — this is a daily bar that simply carried the prior close forward because
  //     the target day itself had no new trade (a thinly-traded instrument's quiet day), not a
  //     pipeline error; Yahoo's own live quote just hasn't moved on yet.
  let yahooMatch: boolean | null = null;
  let yahooDetail: { ourDate: string; ourPrice: number; yahooDate: string; yahooPrice: number } | undefined;
  if (resolved.kind === "RESOLVED" && candle?.regularMarketTimeUnix != null && candle?.regularMarketPrice != null) {
    const quoteLocalDate = localDateFromUnix(candle.regularMarketTimeUnix, job.timezone);
    const priceClose = isPriceWithinTolerance(candle.regularMarketPrice, resolved.price);
    const sameDayMatch = quoteLocalDate === targetLocalDate && priceClose;
    const oneDayCarryForwardMatch = priceClose && daysBetweenLocalDates(quoteLocalDate, targetLocalDate) === 1;
    yahooMatch = sameDayMatch || oneDayCarryForwardMatch;
    if (!yahooMatch) {
      yahooDetail = { ourDate: targetLocalDate, ourPrice: resolved.price, yahooDate: quoteLocalDate, yahooPrice: candle.regularMarketPrice };
    }
  }

  const priorQuote = quoteResolutions.get(etf.id);
  if (resolved.kind === "RESOLVED" && resolved.source === "BAR" && priorQuote?.targetLocalDate === targetLocalDate) {
    if (sourceSwitches.length < 20) {
      sourceSwitches.push({ symbol: etf.data_source, quotePrice: priorQuote.price, barClose: resolved.price, diff: resolved.price - priorQuote.price });
    }
    quoteResolutions.delete(etf.id);
  } else if (resolved.kind === "RESOLVED" && resolved.source === "QUOTE_FINAL") {
    quoteResolutions.set(etf.id, { etfId: etf.id, targetLocalDate, symbol: etf.data_source, price: resolved.price });
  }

  if (resolved.kind === "NO_TRADE_ON_TARGET") {
    // Not a price comparison at all — sparkSymbolPresent still matters (SOURCE_MISSING must still
    // win if Spark had nothing for this symbol whatsoever), but when the symbol IS present and we've
    // confirmed it simply didn't trade, that's immediately final, independent of whatever's in DB.
    return { classification: sparkSymbolPresent ? "NO_TRADE_ON_TARGET" : "SOURCE_MISSING", sourceUsed: null, yahooMatch: null, resolvedPrice: null };
  }

  // Task O rule 1 (price sanity): a resolved price is checked against the ETF's own last known DB
  // close BEFORE it's allowed to become NEW/CHANGED/SAME/DB_NEWER. A ~100x (or ~1/100x) ratio is a
  // near-certain pence/pound unit mismatch, held unconditionally (never written, even once Task P's
  // write path is on). Anything else beyond ±50% gets Task P's second opinion: Yahoo's OWN previous
  // close (chartPreviousClose). If Yahoo's own day-over-day move agrees with the new price, the
  // "jump" only existed relative to our own stale DB value — reclassified DB_DISCONTINUITY, which IS
  // written (the DXJ scenario this round: DB's stale 180.55 made 60.71 look like a huge drop, but
  // Yahoo's own previous close of 60.677 shows this is just the DB catching up). If Yahoo's own data
  // shows the same size of jump too, there's no independent corroboration — stays PRICE_JUMP_REVIEW,
  // never written.
  if (resolved.kind === "RESOLVED") {
    const lastKnownClose = lastKnownCloses.get(etf.id) ?? null;
    const sanity = checkPriceSanity(resolved.price, lastKnownClose);
    if (sanity === "UNIT_MISMATCH") {
      return {
        classification: "UNIT_MISMATCH", sourceUsed: resolved.source, yahooMatch, yahooDetail,
        sanityDetail: lastKnownClose != null ? { newPrice: resolved.price, lastKnownClose } : undefined,
        resolvedPrice: resolved.price,
      };
    }
    if (sanity === "PRICE_JUMP_REVIEW") {
      const outcome = reviewPriceJump(resolved.price, candle?.chartPreviousClose ?? null);
      return {
        classification: outcome, sourceUsed: resolved.source, yahooMatch, yahooDetail,
        sanityDetail: lastKnownClose != null ? { newPrice: resolved.price, lastKnownClose } : undefined,
        resolvedPrice: resolved.price,
      };
    }
  }

  const sparkDate = resolved.kind === "RESOLVED" ? targetLocalDate : null;
  const sparkClose = resolved.kind === "RESOLVED" ? resolved.price : null;
  const classification = classify({ dbDate, dbClose, sparkSymbolPresent, sparkDate, sparkClose });
  return { classification, sourceUsed: resolved.kind === "RESOLVED" ? resolved.source : null, yahooMatch, yahooDetail, resolvedPrice: resolved.kind === "RESOLVED" ? resolved.price : null };
}

type MarketStatus = "ELIGIBLE" | "NOT_ELIGIBLE" | "NOT_REACHED";

type MarketDetail = {
  jobId: string;
  status: MarketStatus;
  notEligibleReason?: "NOT_YET_CLOSED" | "ALREADY_DONE" | "NO_TRADING_DAY_IN_WINDOW";
  targetLocalDate: string | null;
  requested: number;
  classifications: Record<ShadowClassification, number>;
  fetchErrorCount: number;
  pendingCount: number;
  sourceMissingSymbols: string[];
  noBarSymbols: string[];
  noTradeSymbols: string[];
  newSymbols: string[];
  changedSymbols: string[];
  unitMismatchSamples: Array<{ symbol: string; newPrice: number; lastKnownClose: number }>;
  priceJumpReviewSamples: Array<{ symbol: string; newPrice: number; lastKnownClose: number }>;
  dbDiscontinuitySamples: Array<{ symbol: string; newPrice: number; lastKnownClose: number }>;
  historyWritten: number;
  etfsUpdated: number;
  performanceRecomputed: number;
  doneForToday: boolean;
  priorityKind?: "SWEEP" | "RECHECK_DUE" | "WAITING" | "DONE";
  coreUniverseBefore?: number; // active+data_source candidates matching this market's suffix pattern, before the core filter
  coreUniverseAfter?: number; // same, after the core-universe + HK-counter filter
  barCount: number; // resolved via rule 1 (daily bar)
  quoteFinalCount: number; // resolved via rule 2 (live quote, past close+delay, bar not yet published)
  noTradeOnTargetCount: number; // rule 3: confirmed no trade occurred on the target date
  sourceSwitches: SourceSwitch[]; // Task M rule 4: a later BAR superseded an earlier QUOTE_FINAL for the same etf+date
  yahooConsistentCount: number; // resolved price/date this invocation would have matched Yahoo's live quote
  yahooInconsistentCount: number;
  yahooInconsistentSamples: Array<{ symbol: string; ourDate: string; ourPrice: number; yahooDate: string; yahooPrice: number }>;
  // Task W4: core-universe ETFs still missing a real etf_history row (and not a confirmed
  // terminal-non-write classification) for this market's most recent checkpoint-reported lastDoneDate
  // — the DB-ground-truth gap count, computed every invocation regardless of whether this market got
  // a processing turn. Should trend to 0 after enough passes; a market stuck non-zero in SHADOW mode
  // (which never writes) is expected whenever any ETF classified NEW/CHANGED/DB_DISCONTINUITY there.
  dbGapCount: number;
};

const emptyCounts = (): Record<ShadowClassification, number> => ({ NEW: 0, CHANGED: 0, SAME: 0, SOURCE_MISSING: 0, NO_BAR_FOR_TARGET_DATE: 0, DB_NEWER: 0, NO_TRADE_ON_TARGET: 0, UNIT_MISMATCH: 0, PRICE_JUMP_REVIEW: 0, DB_DISCONTINUITY: 0 });

// Task P: the only QueryFn adapter needed for lib/market-close-sync/priceWriter.ts — a thin wrapper
// around the same prisma.$queryRawUnsafe every read-only lookup in this route already uses, so the
// write path shares the exact same DB connection/client, never a second one.
const writerQuery = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

async function computeUnmapped(registry: Awaited<ReturnType<typeof loadExchangeCalendarRegistry>>) {
  const rows = await prisma.$queryRawUnsafe<Array<{ data_source: string; exchange: string | null }>>(
    `SELECT data_source, exchange FROM etfs WHERE is_active = true AND data_source IS NOT NULL`,
  );
  const unmapped: Record<string, number> = {};
  let unmappedTotal = 0;
  for (const row of rows) {
    const resolution = resolveJobForEtf(registry, row.data_source, row.exchange);
    if (resolution) continue;
    const dot = row.data_source.lastIndexOf(".");
    const key = dot === -1 ? `no-suffix:${row.exchange ?? "UNKNOWN_EXCHANGE"}` : row.data_source.slice(dot);
    unmapped[key] = (unmapped[key] ?? 0) + 1;
    unmappedTotal++;
  }
  return { unmappedTotal, unmappedBySuffix: unmapped, universeTotal: rows.length };
}

/** One aggregate pass over the WHOLE active+data_source universe deciding core-universe membership
 * (lib/market-close-sync/coreUniverse.ts) for every ETF at once — far cheaper than re-deriving it per
 * market/per batch. Returns the set of etf_ids that belong in the daily rotation. The activity
 * measure (volume vs close) is picked per-suffix via a SQL CASE mirroring SUFFIX_ACTIVITY_MEASURE —
 * kept in sync by a dedicated test (see coreUniverse.test.ts for the pure logic; the SQL pattern list
 * is re-derived from SUFFIX_ACTIVITY_MEASURE's own keys below, never hand-duplicated). */
async function computeCoreUniverse(): Promise<Set<string>> {
  const closeBasedSuffixes = Object.keys(SUFFIX_ACTIVITY_MEASURE); // e.g. [".VI", ".DU", ".F"]
  const closeBasedPatterns = closeBasedSuffixes.map((s) => `%${s}`);
  const rows = await prisma.$queryRawUnsafe<Array<{ etf_id: string; days_available: bigint; active_days: bigint }>>(
    `WITH ranked AS (
       SELECT h.etf_id, e.data_source, h.volume, h.close,
              row_number() OVER (PARTITION BY h.etf_id ORDER BY h.date DESC) AS rn
       FROM etf_history h
       JOIN etfs e ON e.id = h.etf_id
       WHERE e.is_active = true AND e.data_source IS NOT NULL
     ),
     scored AS (
       SELECT etf_id,
              CASE WHEN data_source LIKE ANY($1) THEN (close IS NOT NULL)
                   ELSE (volume IS NOT NULL AND volume > 0) END AS traded_positive
       FROM ranked WHERE rn <= $2
     )
     SELECT etf_id, count(*) AS days_available, count(*) FILTER (WHERE traded_positive) AS active_days
     FROM scored GROUP BY etf_id`,
    closeBasedPatterns, CORE_UNIVERSE_LOOKBACK_DAYS,
  );
  const core = new Set<string>();
  for (const r of rows) {
    if (isCoreUniverseMemberFromCounts(Number(r.days_available), Number(r.active_days))) core.add(r.etf_id);
  }
  return core;
}

async function lookupDbRowsForTargetDate(etfIds: string[], targetLocalDate: string): Promise<Map<string, { date: string; close: number }>> {
  if (etfIds.length === 0) return new Map();
  const windowStart = new Date(`${targetLocalDate}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - DB_DATE_WINDOW_DAYS);
  const windowEnd = new Date(`${targetLocalDate}T00:00:00Z`);
  windowEnd.setUTCDate(windowEnd.getUTCDate() + DB_DATE_WINDOW_DAYS);
  const rows = await prisma.$queryRawUnsafe<Array<{ etf_id: string; date: Date; close: unknown }>>(
    `SELECT etf_id, date, close FROM etf_history
      WHERE etf_id = ANY($1) AND date BETWEEN $2 AND $3 AND close IS NOT NULL`,
    etfIds, windowStart, windowEnd,
  );
  const result = new Map<string, { date: string; close: number }>();
  for (const row of rows) {
    const storedCalendarDate = new Date(row.date).toISOString().slice(0, 10);
    if (storedCalendarDate !== targetLocalDate) continue;
    result.set(row.etf_id, { date: storedCalendarDate, close: Number(row.close) });
  }
  return result;
}

/** Task O: the ETF's single most recent known close in etf_history, with NO date-window
 * restriction at all (unlike lookupDbRowsForTargetDate, which only looks within
 * ±DB_DATE_WINDOW_DAYS of the target date) — this is deliberately the broadest possible anchor for
 * "what did we last see this instrument trade at", since a genuine data gap of several days must
 * not blind the sanity check to a real unit-mismatch or price-jump the moment trading resumes. */
async function lookupLastKnownClose(etfIds: string[]): Promise<Map<string, number>> {
  if (etfIds.length === 0) return new Map();
  const rows = await prisma.$queryRawUnsafe<Array<{ etf_id: string; close: unknown }>>(
    `SELECT DISTINCT ON (etf_id) etf_id, close FROM etf_history
      WHERE etf_id = ANY($1) AND close IS NOT NULL
      ORDER BY etf_id, date DESC`,
    etfIds,
  );
  const result = new Map<string, number>();
  for (const row of rows) result.set(row.etf_id, Number(row.close));
  return result;
}

/** Task W4: a market's core-universe ETF ids — same filter the main sweep candidate query and the
 * existing coreUniverseBefore/After reporting pass both already use (is_active + data_source match
 * + coreUniverseIds membership + not an HK currency counter), factored out so the DB-gap check (which
 * needs this list too) doesn't duplicate the filter logic, only the (cheap, read-only) query. */
// Task W6: every etfs.id in this table is a UUID-shaped string stored in a plain `text` column
// (VERIFIED live: 16,834/16,834 rows match the UUID regex, 100%, no exceptions by market) — Prisma's
// query engine detects UUID-shaped string arrays passed to $queryRawUnsafe and can encode them on the
// wire as `uuid[]`, which then fails against the real `text` column with "operator does not exist:
// text = uuid" (a known Prisma raw-query quirk, confirmed via package.json: @prisma/client 5.14.0).
// This hit in Production intermittently (not every invocation — consistent with Prisma's engine only
// applying the detection in some code paths) and an explicit `::text[]` SQL-level cast (Task W5) did
// NOT reliably fix it, since the mismatch happens at parameter wire-encoding, before the cast in the
// query text is ever applied. Fix: stop handwriting SQL with array bind parameters for these two
// lookups entirely — use Prisma's own typed query builder (findMany/where/in), which serializes
// `in` filters through its normal, already-correct code path, never through the UUID-sniffing one.
async function lookupMarketCoreUniverseIds(suffixPatterns: string[], fallbackExchanges: string[], coreUniverseIds: Set<string>): Promise<string[]> {
  if (suffixPatterns.length === 0 && fallbackExchanges.length === 0) return [];
  const suffixes = suffixPatterns.map((p) => (p.startsWith("%") ? p.slice(1) : p)); // caller passes "%${suffix}" LIKE patterns; endsWith needs the bare suffix
  const rows = await prisma.etf.findMany({
    where: {
      isActive: true,
      dataSource: { not: null },
      OR: [
        ...suffixes.map((suffix) => ({ dataSource: { endsWith: suffix } })),
        ...(fallbackExchanges.length > 0 ? [{ dataSource: { not: { contains: "." } }, exchange: { in: fallbackExchanges } }] : []),
      ],
    },
    select: { id: true, dataSource: true },
  });
  // dataSource is never actually null here (the where clause excludes it) — the ?? is only to
  // satisfy TypeScript, which can't narrow Prisma's return type from the where filter alone.
  return rows.filter((r) => coreUniverseIds.has(r.id) && !isHongKongCurrencyCounter(r.dataSource ?? "")).map((r) => r.id);
}

const DB_GAP_BATCH_SIZE = 1000; // Task W6: Prisma findMany/where-in batch size for the DB-gap presence check

/** Task W4: which of `etfIds` have an etf_history row for EXACTLY targetLocalDate (no ±window — this
 * is the ground truth the completion decision now rests on, deliberately stricter than
 * lookupDbRowsForTargetDate's windowed lookup used for classification). Task W6: Prisma
 * findMany/where-in, batched at 1,000 ids per call, instead of a handwritten `= ANY($1)` — see the
 * comment on lookupMarketCoreUniverseIds above for why. */
async function lookupDbPresentIdsExact(etfIds: string[], targetLocalDate: string): Promise<Set<string>> {
  if (etfIds.length === 0) return new Set();
  const result = new Set<string>();
  for (let i = 0; i < etfIds.length; i += DB_GAP_BATCH_SIZE) {
    const batch = etfIds.slice(i, i + DB_GAP_BATCH_SIZE);
    const rows = await prisma.etfHistory.findMany({
      where: { etfId: { in: batch }, date: new Date(`${targetLocalDate}T00:00:00.000Z`), close: { not: null } },
      select: { etfId: true },
      distinct: ["etfId"],
    });
    for (const r of rows) result.add(r.etfId);
  }
  return result;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type MarketContext = {
  jobId: string;
  job: NonNullable<ReturnType<typeof jobById>>;
  checkpointKey: string;
  lastDoneDate: string | null;
  targetLocalDate: string;
  state: MarketCompletionState;
  quoteResolutions: Map<string, QuoteResolution>;
  suffixPatterns: string[];
  fallbackExchanges: string[];
  dbGapCount: number; // Task W4: the gap count Pass 0 already computed for this market, before any turn this invocation
  lastDoneDateTerminalNonWrite: Record<string, FinalOrPendingClassification>;
};

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const now = new Date();
  const registry = await loadExchangeCalendarRegistry();
  const { unmappedTotal, unmappedBySuffix, universeTotal } = await computeUnmapped(registry);
  const coreUniverseIds = await computeCoreUniverse();

  const marketDetails: MarketDetail[] = [];
  let timeBudgetStop = false;
  let rateLimitStop = false;
  const runKey = fifteenMinuteBucketKey("market-close-sync", now);
  const { runId, skipped } = await beginRun({
    jobName: JOB,
    provider: "YAHOO_SPARK",
    runKey,
    universeCount: universeTotal,
    batchSize: SPARK_MAX_SYMBOLS_PER_BATCH,
    checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this 15-minute window", runKey, unmappedTotal, unmappedBySuffix, runMode: currentRunMode() });
  }

  const consideredJobIds = [...new Set([...Object.values(SUFFIX_TO_JOB_ID), ...Object.values(NO_SUFFIX_EXCHANGE_FALLBACK)])];
  const suffixesByJob = new Map<string, string[]>();
  for (const [suffix, jobId] of Object.entries(SUFFIX_TO_JOB_ID)) suffixesByJob.set(jobId, [...(suffixesByJob.get(jobId) ?? []), suffix]);
  const fallbackExchangesByJob = new Map<string, string[]>();
  for (const [exchange, jobId] of Object.entries(NO_SUFFIX_EXCHANGE_FALLBACK)) fallbackExchangesByJob.set(jobId, [...(fallbackExchangesByJob.get(jobId) ?? []), exchange]);

  // Pass 0: resolve eligibility + load checkpoint state for every considered market. No network
  // calls here — just cheap per-market reads — so every market's priority can be classified before
  // deciding this invocation's processing order (Task L item 2: unswept markets before due rechecks).
  //
  // Task W4: checkpoint's lastDoneDate is now only a FAST-PATH HINT, never trusted to skip a market
  // on its own. Whenever lastDoneDate is set, this pass re-verifies it against a real DB query
  // (lookupDbPresentIdsExact) before honoring ALREADY_DONE — if the DB is missing rows for ETFs that
  // aren't also a confirmed terminal-non-write classification, the market is REOPENED for exactly
  // that date (not advanced to a new date) so the gap gets a real repair pass, never silently skipped.
  const contexts: MarketContext[] = [];
  for (const jobId of consideredJobIds) {
    const job = jobById(registry, jobId);
    if (!job) continue;

    const checkpointKey = `market-close-sync:${jobId}:${currentRunMode()}`;
    const before = await readCheckpoint(checkpointKey);
    const persisted = parsePersistedState(before?.lastSymbol ?? null);
    const lastDoneDate = persisted.lastDoneDate;
    const suffixPatterns = (suffixesByJob.get(jobId) ?? []).map((s) => `%${s}`);
    const fallbackExchanges = fallbackExchangesByJob.get(jobId) ?? [];

    let dbGapCount = 0;
    let gapRepairTargetDate: string | null = null;
    if (lastDoneDate != null) {
      const marketCoreIds = await lookupMarketCoreUniverseIds(suffixPatterns, fallbackExchanges, coreUniverseIds);
      const dbPresentIds = await lookupDbPresentIdsExact(marketCoreIds, lastDoneDate);
      const gapIds = computeDbGapIds(marketCoreIds, dbPresentIds, persisted.lastDoneDateTerminalNonWrite);
      dbGapCount = gapIds.length;
      if (dbGapCount > 0) gapRepairTargetDate = lastDoneDate;
    }

    const eligibility = gapRepairTargetDate != null
      ? ({ eligible: true, targetLocalDate: gapRepairTargetDate } as const)
      : findEligibleTradeDate(job, now, (d) => lastDoneDate != null && d <= lastDoneDate);
    if (!eligibility.eligible) {
      marketDetails.push({
        jobId, status: "NOT_ELIGIBLE", notEligibleReason: eligibility.reason, targetLocalDate: null,
        requested: 0, classifications: emptyCounts(), fetchErrorCount: 0, pendingCount: 0,
        sourceMissingSymbols: [], noBarSymbols: [], noTradeSymbols: [], newSymbols: [], changedSymbols: [], unitMismatchSamples: [], priceJumpReviewSamples: [], dbDiscontinuitySamples: [], historyWritten: 0, etfsUpdated: 0, performanceRecomputed: 0, doneForToday: eligibility.reason === "ALREADY_DONE",
        barCount: 0, quoteFinalCount: 0, noTradeOnTargetCount: 0, sourceSwitches: [], yahooConsistentCount: 0, yahooInconsistentCount: 0, yahooInconsistentSamples: [],
        dbGapCount,
      });
      continue;
    }
    const { targetLocalDate } = eligibility;
    const isGapRepairPass = gapRepairTargetDate === targetLocalDate;
    const state: MarketCompletionState = isGapRepairPass
      ? { ...emptyState(targetLocalDate), terminalNonWrite: persisted.lastDoneDateTerminalNonWrite }
      : (persisted.inProgress && persisted.inProgress.targetLocalDate === targetLocalDate ? persisted.inProgress : emptyState(targetLocalDate));
    const quoteResolutions = new Map<string, QuoteResolution>(
      (persisted.quoteResolutions ?? [])
        .filter((q) => q.targetLocalDate === targetLocalDate)
        .map((q) => [q.etfId, q]),
    );

    contexts.push({
      jobId, job, checkpointKey, lastDoneDate, targetLocalDate, state, quoteResolutions, dbGapCount,
      suffixPatterns, fallbackExchanges, lastDoneDateTerminalNonWrite: persisted.lastDoneDateTerminalNonWrite,
    });
  }

  // Task L item 2: SWEEP-priority markets (not yet fully scanned) always go before RECHECK_DUE
  // markets (sweepComplete, with at least one pending entry past its own wait). WAITING markets
  // (sweepComplete, pending, nothing due yet) and DONE markets get no turn at all this invocation —
  // never queried early, per the task's explicit "到期前不得重新查詢".
  const nowMsForPriority = Date.now();
  const withPriority = contexts.map((ctx) => ({ item: ctx, priority: classifyMarketPriority(ctx.state, nowMsForPriority) }));
  const priorityByJobId = new Map(withPriority.map((w) => [w.item.jobId, w.priority]));
  const dbGapCountByJobId = new Map(contexts.map((ctx) => [ctx.jobId, ctx.dbGapCount]));
  const orderedContexts = orderMarketsForInvocation(withPriority);

  for (const ctx of orderedContexts) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    if (rateLimitStop) break;

    const { jobId, job, checkpointKey, lastDoneDate, targetLocalDate } = ctx;
    let state = ctx.state;
    const marketStartedMs = Date.now();
    const marketDeadlineMs = Math.min(startedMs + TIME_BUDGET_MS, marketStartedMs + PER_MARKET_BUDGET_MS);

    const counts = emptyCounts();
    const sourceMissingSymbols: string[] = [];
    const noBarSymbols: string[] = [];
    const noTradeSymbols: string[] = [];
    const newSymbols: string[] = [];
    const changedSymbols: string[] = [];
    let requested = 0;
    let fetchErrorCount = 0;
    let fetchFailedThisMarket = false;
    let barCount = 0;
    let quoteFinalCount = 0;
    let noTradeOnTargetCount = 0;
    let yahooConsistentCount = 0;
    let yahooInconsistentCount = 0;
    const yahooInconsistentSamples: Array<{ symbol: string; ourDate: string; ourPrice: number; yahooDate: string; yahooPrice: number }> = [];
    const unitMismatchSamples: Array<{ symbol: string; newPrice: number; lastKnownClose: number }> = [];
    const priceJumpReviewSamples: Array<{ symbol: string; newPrice: number; lastKnownClose: number }> = [];
    const dbDiscontinuitySamples: Array<{ symbol: string; newPrice: number; lastKnownClose: number }> = [];
    const sourceSwitches: SourceSwitch[] = [];
    let historyWritten = 0;
    let etfsUpdated = 0;
    let performanceRecomputed = 0;
    const writeEnabledThisRun = isWriteEnabled();
    const { quoteResolutions } = ctx;

    // Phase 1: forward sweep, now filtered to the core universe (coreUniverseIds) and excluding
    // Hong Kong's duplicate currency-counter listings — both decided once per etf_id up front, not
    // per batch, so the SQL only ever returns candidates already known to belong in the rotation.
    while (!state.sweepComplete && Date.now() < marketDeadlineMs) {
      const rawCandidates = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; exchange: string | null; data_source: string }>>(
        `SELECT id, code, exchange, data_source
           FROM etfs
          WHERE is_active = true AND data_source IS NOT NULL AND id > $1
            AND (data_source LIKE ANY($2) OR (data_source NOT LIKE '%.%' AND exchange = ANY($3)))
          ORDER BY id ASC LIMIT $4`,
        state.cursorEtfId, ctx.suffixPatterns, ctx.fallbackExchanges, SPARK_MAX_SYMBOLS_PER_BATCH,
      );
      if (rawCandidates.length === 0) {
        state = advanceSweep(state, { ok: true, isLastBatch: true, observations: [] }, Date.now());
        break;
      }
      const lastRawId = rawCandidates[rawCandidates.length - 1].id;
      const isLastBatch = rawCandidates.length < SPARK_MAX_SYMBOLS_PER_BATCH;
      const candidates = rawCandidates.filter((c) => coreUniverseIds.has(c.id) && !isHongKongCurrencyCounter(c.data_source));

      if (candidates.length === 0) {
        // Every candidate in this id-range was filtered out (non-core or an HK currency counter) —
        // still a real batch of the sweep (cursor must advance), just nothing to fetch from Spark.
        state = advanceSweep(state, { ok: true, isLastBatch, observations: [] }, Date.now(), lastRawId);
        if (isLastBatch) break;
        continue;
      }

      await sleep(REQUEST_DELAY_MS);
      const batch = await fetchSparkBatch(candidates.map((c) => c.data_source));
      if (batch.rateLimited) { rateLimitStop = true; break; }
      if (batch.error) {
        fetchErrorCount += candidates.length;
        fetchFailedThisMarket = true;
        state = advanceSweep(state, { ok: false }, Date.now());
        break;
      }

      const byCandle = new Map(batch.candles.map((c) => [c.symbol, c]));
      const dbRows = await lookupDbRowsForTargetDate(candidates.map((c) => c.id), targetLocalDate);
      const lastKnownCloses = await lookupLastKnownClose(candidates.map((c) => c.id));

      const observations: Array<{ etfId: string; symbol: string; classification: ShadowClassification }> = [];
      const batchWritable: WritablePrice[] = [];
      for (const etf of candidates) {
        requested++;
        const { classification: c, sourceUsed, yahooMatch, yahooDetail, sanityDetail, resolvedPrice } = resolveAndClassify(
          etf, byCandle.get(etf.data_source), dbRows, lastKnownCloses, job, targetLocalDate, now, quoteResolutions, sourceSwitches,
        );
        counts[c]++;
        if (sourceUsed === "BAR") barCount++;
        if (sourceUsed === "QUOTE_FINAL") quoteFinalCount++;
        if (c === "NO_TRADE_ON_TARGET") noTradeOnTargetCount++;
        if (yahooMatch === true) yahooConsistentCount++;
        if (yahooMatch === false) {
          yahooInconsistentCount++;
          if (yahooDetail && yahooInconsistentSamples.length < 5) yahooInconsistentSamples.push({ symbol: etf.data_source, ...yahooDetail });
        }
        observations.push({ etfId: etf.id, symbol: etf.data_source, classification: c });
        if (c === "SOURCE_MISSING" && sourceMissingSymbols.length < 20) sourceMissingSymbols.push(etf.data_source);
        if (c === "NO_BAR_FOR_TARGET_DATE" && noBarSymbols.length < 20) noBarSymbols.push(etf.data_source);
        if (c === "NO_TRADE_ON_TARGET" && noTradeSymbols.length < 20) noTradeSymbols.push(etf.data_source);
        if (c === "NEW" && newSymbols.length < 20) newSymbols.push(etf.data_source);
        if (c === "CHANGED" && changedSymbols.length < 20) changedSymbols.push(etf.data_source);
        if (c === "UNIT_MISMATCH" && sanityDetail && unitMismatchSamples.length < 20) unitMismatchSamples.push({ symbol: etf.data_source, ...sanityDetail });
        if (c === "PRICE_JUMP_REVIEW" && sanityDetail && priceJumpReviewSamples.length < 20) priceJumpReviewSamples.push({ symbol: etf.data_source, ...sanityDetail });
        if (c === "DB_DISCONTINUITY" && sanityDetail && dbDiscontinuitySamples.length < 20) dbDiscontinuitySamples.push({ symbol: etf.data_source, ...sanityDetail });
        if (sourceUsed && resolvedPrice != null) {
          batchWritable.push({ etfId: etf.id, symbol: etf.data_source, classification: c, targetLocalDate, price: resolvedPrice, source: sourceUsed });
        }
      }
      // Task P: one batched write call per Spark batch, never per row — matching "批次寫入，不逐筆".
      const writeResult = await writeBatchIfEnabled(writerQuery, batchWritable, now.toISOString(), writeEnabledThisRun);
      historyWritten += writeResult.historyWritten;
      etfsUpdated += writeResult.etfsUpdated;
      performanceRecomputed += writeResult.performanceRecomputed;
      state = advanceSweep(state, { ok: true, isLastBatch, observations }, Date.now(), lastRawId);
      if (isLastBatch) break;
    }

    // Phase 2: re-check ONLY the pending entries that are actually due (Task L item 2) — never the
    // full pending list. Skipped entirely if Phase 1 hit a fetch error, a rate limit, this market's
    // own 40%-budget deadline, or the global time budget.
    if (state.sweepComplete && !fetchFailedThisMarket && !rateLimitStop) {
      const nowMsForDue = Date.now();
      const duePending = state.pending.filter((p) => isDueForRecheck(p, nowMsForDue));
      for (let i = 0; i < duePending.length; i += SPARK_MAX_SYMBOLS_PER_BATCH) {
        if (Date.now() >= marketDeadlineMs || Date.now() - startedMs > TIME_BUDGET_MS) break;
        const chunk = duePending.slice(i, i + SPARK_MAX_SYMBOLS_PER_BATCH);

        await sleep(REQUEST_DELAY_MS);
        const batch = await fetchSparkBatch(chunk.map((p) => p.symbol));
        if (batch.rateLimited) { rateLimitStop = true; break; }
        if (batch.error) {
          fetchErrorCount += chunk.length;
          fetchFailedThisMarket = true;
          state = advanceSweep(state, { ok: false }, Date.now());
          break;
        }

        const byCandle = new Map(batch.candles.map((c) => [c.symbol, c]));
        const dbRows = await lookupDbRowsForTargetDate(chunk.map((p) => p.etfId), targetLocalDate);
        const lastKnownCloses = await lookupLastKnownClose(chunk.map((p) => p.etfId));

        const observations: Array<{ etfId: string; symbol: string; classification: ShadowClassification }> = [];
        const chunkWritable: WritablePrice[] = [];
        for (const p of chunk) {
          requested++;
          const { classification: c, sourceUsed, yahooMatch, yahooDetail, sanityDetail, resolvedPrice } = resolveAndClassify(
            { id: p.etfId, data_source: p.symbol }, byCandle.get(p.symbol), dbRows, lastKnownCloses, job, targetLocalDate, now, quoteResolutions, sourceSwitches,
          );
          counts[c]++;
          if (sourceUsed === "BAR") barCount++;
          if (sourceUsed === "QUOTE_FINAL") quoteFinalCount++;
          if (c === "NO_TRADE_ON_TARGET") noTradeOnTargetCount++;
          if (yahooMatch === true) yahooConsistentCount++;
          if (yahooMatch === false) {
            yahooInconsistentCount++;
            if (yahooDetail && yahooInconsistentSamples.length < 5) yahooInconsistentSamples.push({ symbol: p.symbol, ...yahooDetail });
          }
          observations.push({ etfId: p.etfId, symbol: p.symbol, classification: c });
          if (c === "SOURCE_MISSING" && sourceMissingSymbols.length < 20) sourceMissingSymbols.push(p.symbol);
          if (c === "NO_BAR_FOR_TARGET_DATE" && noBarSymbols.length < 20) noBarSymbols.push(p.symbol);
          if (c === "NO_TRADE_ON_TARGET" && noTradeSymbols.length < 20) noTradeSymbols.push(p.symbol);
          if (c === "NEW" && newSymbols.length < 20) newSymbols.push(p.symbol);
          if (c === "CHANGED" && changedSymbols.length < 20) changedSymbols.push(p.symbol);
          if (c === "UNIT_MISMATCH" && sanityDetail && unitMismatchSamples.length < 20) unitMismatchSamples.push({ symbol: p.symbol, ...sanityDetail });
          if (c === "PRICE_JUMP_REVIEW" && sanityDetail && priceJumpReviewSamples.length < 20) priceJumpReviewSamples.push({ symbol: p.symbol, ...sanityDetail });
          if (c === "DB_DISCONTINUITY" && sanityDetail && dbDiscontinuitySamples.length < 20) dbDiscontinuitySamples.push({ symbol: p.symbol, ...sanityDetail });
          if (sourceUsed && resolvedPrice != null) {
            chunkWritable.push({ etfId: p.etfId, symbol: p.symbol, classification: c, targetLocalDate, price: resolvedPrice, source: sourceUsed });
          }
        }
        const writeResult = await writeBatchIfEnabled(writerQuery, chunkWritable, now.toISOString(), writeEnabledThisRun);
        historyWritten += writeResult.historyWritten;
        etfsUpdated += writeResult.etfsUpdated;
        performanceRecomputed += writeResult.performanceRecomputed;
        state = advanceSweep(state, { ok: true, isLastBatch: true, observations }, Date.now());
      }
    }

    const sweepLevelDone = isMarketDone(state);
    // Task W4 item 1/2: sweepComplete + empty pending is only a CANDIDATE for "done" — never trusted
    // on its own. Re-verify against the DB before ever advancing lastDoneDate: in SHADOW mode this
    // can legitimately never clear (shadow writes nothing, so a NEW/CHANGED classification there
    // never gets an etf_history row of its OWN making — only WAITING for some other pipeline to have
    // independently written that exact date satisfies it), which is the correct, intentional
    // consequence of item 3 (shadow and write must never share a "done" state).
    let marketDone = false;
    let finalDbGapCount = ctx.dbGapCount;
    if (sweepLevelDone) {
      const marketCoreIds = await lookupMarketCoreUniverseIds(ctx.suffixPatterns, ctx.fallbackExchanges, coreUniverseIds);
      const dbPresentIds = await lookupDbPresentIdsExact(marketCoreIds, targetLocalDate);
      const gapIds = computeDbGapIds(marketCoreIds, dbPresentIds, state.terminalNonWrite);
      finalDbGapCount = gapIds.length;
      marketDone = finalDbGapCount === 0;
    }
    const nextPersisted: PersistedState = marketDone
      ? { v: 3, lastDoneDate: targetLocalDate, lastDoneDateTerminalNonWrite: state.terminalNonWrite, inProgress: null, quoteResolutions: Array.from(quoteResolutions.values()) }
      // Not genuinely done (sweep incomplete, OR sweep-complete but a DB gap remains): never advance
      // lastDoneDate past where it already was. If the sweep itself did complete but a gap remains,
      // keep the FRESH state (with its now-larger terminalNonWrite) as inProgress rather than
      // persisted.inProgress — bare sweepComplete=true + empty pending would otherwise make next
      // invocation's Phase 1/Phase 2 loops both no-ops, silently repeating this same stuck gap forever.
      : { v: 3, lastDoneDate, lastDoneDateTerminalNonWrite: ctx.lastDoneDateTerminalNonWrite, inProgress: sweepLevelDone ? { ...emptyState(targetLocalDate), terminalNonWrite: state.terminalNonWrite } : state, quoteResolutions: Array.from(quoteResolutions.values()) };
    await writeCheckpoint(JOB, checkpointKey, runId, {
      lastSymbol: JSON.stringify(nextPersisted),
      processed: requested,
      succeeded: counts.SAME + counts.CHANGED + counts.NEW + counts.DB_NEWER + counts.NO_TRADE_ON_TARGET,
      failed: counts.SOURCE_MISSING + counts.NO_BAR_FOR_TARGET_DATE + fetchErrorCount,
    });

    marketDetails.push({
      jobId, status: "ELIGIBLE", targetLocalDate, requested, classifications: counts, fetchErrorCount,
      pendingCount: state.pending.length, sourceMissingSymbols, noBarSymbols, noTradeSymbols, newSymbols, changedSymbols, doneForToday: marketDone,
      priorityKind: priorityByJobId.get(jobId)?.kind,
      barCount, quoteFinalCount, noTradeOnTargetCount, sourceSwitches, yahooConsistentCount, yahooInconsistentCount, yahooInconsistentSamples,
      unitMismatchSamples, priceJumpReviewSamples, dbDiscontinuitySamples, historyWritten, etfsUpdated, performanceRecomputed,
      dbGapCount: finalDbGapCount,
    });
    if (fetchFailedThisMarket) continue;
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
  }

  // Any considered job that never got a turn this invocation is reported as NOT_REACHED, distinct
  // from NOT_ELIGIBLE and from the new WAITING state (sweepComplete, pending, nothing due yet — also
  // reported here since WAITING markets are deliberately given no turn at all, see orderMarketsForInvocation).
  const seenJobIds = new Set(marketDetails.map((m) => m.jobId));
  for (const jobId of consideredJobIds) {
    if (seenJobIds.has(jobId)) continue;
    const priority = priorityByJobId.get(jobId);
    marketDetails.push({
      jobId, status: "NOT_REACHED", targetLocalDate: null, requested: 0, classifications: emptyCounts(), fetchErrorCount: 0, pendingCount: 0,
      sourceMissingSymbols: [], noBarSymbols: [], noTradeSymbols: [], newSymbols: [], changedSymbols: [], unitMismatchSamples: [], priceJumpReviewSamples: [], dbDiscontinuitySamples: [], historyWritten: 0, etfsUpdated: 0, performanceRecomputed: 0, doneForToday: false,
      priorityKind: priority?.kind,
      barCount: 0, quoteFinalCount: 0, noTradeOnTargetCount: 0, sourceSwitches: [], yahooConsistentCount: 0, yahooInconsistentCount: 0, yahooInconsistentSamples: [],
      dbGapCount: dbGapCountByJobId.get(jobId) ?? 0,
    });
  }

  // Core-universe before/after counts per market — read-only reporting pass, cheap (grouped count
  // queries), run once per invocation regardless of which markets actually got a turn above.
  for (const detail of marketDetails) {
    const suffixPatterns = (suffixesByJob.get(detail.jobId) ?? []).map((s) => `%${s}`);
    const fallbackExchanges = fallbackExchangesByJob.get(detail.jobId) ?? [];
    if (suffixPatterns.length === 0 && fallbackExchanges.length === 0) continue;
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; data_source: string }>>(
      `SELECT id, data_source FROM etfs
        WHERE is_active = true AND data_source IS NOT NULL
          AND (data_source LIKE ANY($1) OR (data_source NOT LIKE '%.%' AND exchange = ANY($2)))`,
      suffixPatterns, fallbackExchanges,
    );
    detail.coreUniverseBefore = rows.length;
    detail.coreUniverseAfter = rows.filter((r) => coreUniverseIds.has(r.id) && !isHongKongCurrencyCounter(r.data_source)).length;
  }

  const status = rateLimitStop ? "PARTIAL" : timeBudgetStop ? "PARTIAL" : "COMPLETED";
  const totalRequested = marketDetails.reduce((s, m) => s + m.requested, 0);
  const totalFetchErrors = marketDetails.reduce((s, m) => s + m.fetchErrorCount, 0);
  const totalFailed = marketDetails.reduce((s, m) => s + m.classifications.SOURCE_MISSING + m.classifications.NO_BAR_FOR_TARGET_DATE, 0) + totalFetchErrors;
  // Task P: these were always hardcoded 0 in every prior task — shadow mode never wrote anything.
  // Now they reflect the REAL write counts, which are non-zero only when MARKET_CLOSE_SYNC_WRITE=on
  // actually caused writeBatchIfEnabled to reach the DB — see writeGate.ts/priceWriter.ts.
  const totalHistoryWritten = marketDetails.reduce((s, m) => s + m.historyWritten, 0);
  const totalEtfsUpdated = marketDetails.reduce((s, m) => s + m.etfsUpdated, 0);
  const totalPerformanceRecomputed = marketDetails.reduce((s, m) => s + m.performanceRecomputed, 0);
  const runMode = currentRunMode();
  // Task W6: logs exactly what this invocation itself read for the write switch, and which
  // deployment it ran on — answers "did it actually see MARKET_CLOSE_SYNC_WRITE=on" from the run log
  // alone, without guessing from runMode (which is just isWriteEnabled() restated) or from Vercel's
  // own deploy history.
  const writeEnvDiag = writeEnvDiagnostic();
  await finishRun(runId, JOB, "YAHOO_SPARK", startedMs, {
    status,
    attempted: totalRequested,
    completed: totalRequested - totalFailed,
    inserted: totalHistoryWritten,
    updated: totalEtfsUpdated,
    failed: totalFailed,
    retryableFailures: totalFetchErrors,
    checkpointAfter: null,
    details: {
      time_budget_stop: timeBudgetStop, rate_limit_stop: rateLimitStop, markets: marketDetails,
      unmapped_total: unmappedTotal, unmapped_by_suffix: unmappedBySuffix, core_universe_size: coreUniverseIds.size,
      run_mode: runMode, history_written: totalHistoryWritten, etfs_updated: totalEtfsUpdated, performance_recomputed: totalPerformanceRecomputed,
      write_env_read_exactly_on: writeEnvDiag.readExactlyOn, write_env_var_present: writeEnvDiag.envVarPresent,
      deployment_id: writeEnvDiag.deploymentId, deployment_url: writeEnvDiag.deploymentUrl,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode, timeBudgetStop, rateLimitStop, markets: marketDetails,
    unmappedTotal, unmappedBySuffix, universeTotal, coreUniverseSize: coreUniverseIds.size,
    historyWritten: totalHistoryWritten, etfsUpdated: totalEtfsUpdated, performanceRecomputed: totalPerformanceRecomputed,
  });
}
