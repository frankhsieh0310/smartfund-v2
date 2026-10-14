// One-time historical gap-fill for TWSE/TPEx ETFs, gated by MARKET_CLOSE_SYNC_BACKFILL_DATES
// (comma-separated YYYY-MM-DD). A no-op whenever that env var is unset or empty -- safe to leave
// deployed and to hit by accident. See lib/market-close-sync/backfillHistory.ts for why this exists
// (33 TPEx ETFs' etfs.data_source was NULL, which silently excluded them from market-close-sync's
// core universe; now fixed, but the daily sync's own gap-repair only ever re-opens the single most
// recent lastDoneDate, never a historical range) and why it uses Yahoo's historical chart API rather
// than TPEx's own page-driven endpoint (confirmed not scriptable from a plain server-side fetch after
// repeated attempts, including cookie-primed ones -- it returns 200 with an empty result, not a
// 401/403/429, so nothing here was blocked by policy; the real browser session evidently sends some
// request shape this never reproduced).
//
// 2026-10-13 correction: the first version counted every configured date as a gap unconditionally.
// Confirmed live: 2026-10-09/10/11 (Fri/Sat/Sun -- Taiwan's 國慶日 fell on a Saturday, making the
// Friday a bridge holiday) have zero Yahoo data for 0050.TW itself -- the market was simply closed,
// not a data gap -- yet every one of the 347 candidates x those 3 dates counted as "missing" forever,
// so alreadyComplete could never become true and the temporary every-30-min cron (vercel.json) would
// never stop. Two fixes, both in lib/market-close-sync/backfillHistory.ts: (1) a date only counts at
// all if 0050.TW's own Yahoo chart has a bar for it (filterTradingDates) -- a live, self-updating
// trading-calendar proxy, consistent with how this whole pipeline already trusts Yahoo as its source
// of truth; (2) a symbol+date Yahoo confirms has no close at all on a genuine trading day (the fund
// didn't trade that day, or -- 00838B -- Yahoo has nothing for the symbol ever) is persisted to a
// checkpoint so later runs never re-ask the same question forever.
//
// Writes ONLY missing (etf_id, date) pairs -- anything already in etf_history for a requested date is
// left untouched, never overwritten, per the operator's explicit requirement. Source tag
// "YAHOO_BACKFILL" distinguishes these rows' provenance from the live daily sync's "BAR"/"QUOTE_FINAL".
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { localDateFromUnix } from "@/lib/market-close-sync/marketTime";
import {
  parseBackfillDates, computeMissingPairs, extractRequestedCloses, filterTradingDates, buildTradingDaySet, computeConfirmedNoData,
} from "@/lib/market-close-sync/backfillHistory";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "MARKET_CLOSE_SYNC_BACKFILL";
const SOURCE = "YAHOO_BACKFILL";
const TIME_BUDGET_MS = 240_000;
const REQUEST_SPACING_MS = 3_000;
const TAIPEI_TZ = "Asia/Taipei"; // TWSE and TPEx share this timezone
const TRADING_CALENDAR_PROXY_SYMBOL = "0050.TW"; // most heavily-traded TW ETF -- stand-in for the exchange calendar
const CONFIRMED_NO_DATA_CHECKPOINT_KEY = "market-close-sync-backfill:confirmed-no-data";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchYahooChartPoints(dataSource: string, dates: string[]): Promise<Array<{ dateKey: string; close: number | null }>> {
  const sorted = [...dates].sort();
  const period1 = Math.floor(new Date(`${sorted[0]}T00:00:00Z`).getTime() / 1000) - 5 * 86400;
  const period2 = Math.floor(new Date(`${sorted[sorted.length - 1]}T00:00:00Z`).getTime() / 1000) + 2 * 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(dataSource)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) return [];
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) return [];
  const timestamps: number[] = result.timestamp ?? [];
  const closes: Array<number | null> = result.indicators?.quote?.[0]?.close ?? [];
  return timestamps.map((t, i) => ({ dateKey: localDateFromUnix(t, TAIPEI_TZ), close: closes[i] ?? null }));
}

async function loadConfirmedNoData(): Promise<Set<string>> {
  const row = await readCheckpoint(CONFIRMED_NO_DATA_CHECKPOINT_KEY);
  if (!row?.lastSymbol) return new Set();
  try {
    const parsed = JSON.parse(row.lastSymbol);
    return new Set(Array.isArray(parsed?.keys) ? parsed.keys : []);
  } catch {
    return new Set();
  }
}

async function saveConfirmedNoData(keys: Set<string>): Promise<void> {
  await writeCheckpoint(JOB, CONFIRMED_NO_DATA_CHECKPOINT_KEY, "confirmed-no-data", {
    lastSymbol: JSON.stringify({ keys: [...keys] }), processed: keys.size, succeeded: keys.size, failed: 0,
  });
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const configuredDates = parseBackfillDates(process.env.MARKET_CLOSE_SYNC_BACKFILL_DATES);
  if (configuredDates.length === 0) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "MARKET_CLOSE_SYNC_BACKFILL_DATES not set" });
  }

  const startedMs = Date.now();
  const runKey = `market-close-sync-backfill:${configuredDates.join("_")}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: SOURCE, runKey, universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present and running", runKey, dates: configuredDates });
  }

  // Trading-calendar proxy: a configured date only counts as a real gap if the market itself was open.
  // See buildTradingDaySet's own header comment for the 2026-10-13 bug this fixed.
  const calendarPoints = await fetchYahooChartPoints(TRADING_CALENDAR_PROXY_SYMBOL, configuredDates);
  const tradingDays = buildTradingDaySet(calendarPoints);
  const dates = filterTradingDates(configuredDates, tradingDays);
  const excludedNonTradingDates = configuredDates.filter((d) => !dates.includes(d));

  const candidates = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; data_source: string }>>(
    `SELECT id, code, data_source FROM etfs WHERE is_active = true AND exchange IN ('TWSE','TPEx') AND data_source IS NOT NULL`,
  );
  const candidateIds = candidates.map((c) => c.id);

  const existingRows = dates.length
    ? await prisma.$queryRawUnsafe<Array<{ etf_id: string; date: Date }>>(
        `SELECT etf_id, date FROM etf_history WHERE etf_id = ANY($1) AND date = ANY($2::date[])`,
        candidateIds, dates,
      )
    : [];
  const existingPairs = new Set(existingRows.map((r) => `${r.etf_id}::${r.date.toISOString().slice(0, 10)}`));
  const confirmedNoData = await loadConfirmedNoData();

  const missing = computeMissingPairs(candidateIds, dates, existingPairs, confirmedNoData);
  const missingByEtf = new Map<string, string[]>();
  for (const pair of missing) missingByEtf.set(pair.etfId, [...(missingByEtf.get(pair.etfId) ?? []), pair.date]);
  const candidateById = new Map(candidates.map((c) => [c.id, c]));

  let symbolsAttempted = 0, symbolsFetchFailed = 0, pairsWritten = 0, etfsPriceUpdated = 0, writeErrorCount = 0;
  const writable: Array<{ etfId: string; date: string; close: number }> = [];
  const newlyConfirmedNoData = new Set<string>();

  for (const [etfId, neededDates] of missingByEtf) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) break;
    const etf = candidateById.get(etfId);
    if (!etf) continue;
    symbolsAttempted++;
    try {
      const points = await fetchYahooChartPoints(etf.data_source, neededDates);
      const closes = extractRequestedCloses(points, neededDates);
      for (const [date, close] of closes) writable.push({ etfId, date, close });
      for (const date of computeConfirmedNoData(neededDates, closes)) newlyConfirmedNoData.add(`${etfId}::${date}`);
    } catch {
      symbolsFetchFailed++;
    }
    await sleep(REQUEST_SPACING_MS);
  }

  if (writable.length > 0) {
    const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);
    try {
      const payload = writable.map((w) => ({ etf_id: w.etfId, date: w.date, close: w.close }));
      const inserted = await query(
        `INSERT INTO etf_history (id, etf_id, date, price, close, source, known_at)
           SELECT gen_random_uuid()::text, x.etf_id, x.date::date, x.close, x.close, $2, NOW()
           FROM jsonb_to_recordset($1::jsonb) AS x(etf_id text, date text, close numeric)
         ON CONFLICT (etf_id, date) DO NOTHING
         RETURNING etf_history.id`,
        [JSON.stringify(payload), SOURCE],
      );
      pairsWritten = inserted.length;

      const updated = await query(
        `UPDATE etfs SET latest_price = x.close, price_updated_at = x.date::timestamptz, updated_at = NOW()
           FROM jsonb_to_recordset($1::jsonb) AS x(etf_id text, date text, close numeric)
          WHERE etfs.id = x.etf_id
            AND (etfs.price_updated_at IS NULL OR x.date::date > etfs.price_updated_at::date)
          RETURNING etfs.id`,
        [JSON.stringify(payload)],
      );
      etfsPriceUpdated = updated.length;
    } catch (e) {
      writeErrorCount = writable.length;
    }
  }

  if (newlyConfirmedNoData.size > 0) {
    const merged = new Set([...confirmedNoData, ...newlyConfirmedNoData]);
    await saveConfirmedNoData(merged);
  }

  // Recompute after this run's writes so alreadyComplete reflects reality at response time, not the
  // stale pre-run snapshot (a chunk written this run should count immediately, not next invocation).
  const stillMissing = missing.length - writable.length - newlyConfirmedNoData.size;
  const alreadyComplete = dates.length > 0 ? stillMissing <= 0 : configuredDates.length === excludedNonTradingDates.length;

  const status = "COMPLETED";
  await finishRun(runId, JOB, SOURCE, startedMs, {
    status, attempted: symbolsAttempted, completed: pairsWritten, inserted: pairsWritten, updated: etfsPriceUpdated,
    failed: symbolsFetchFailed + (writeErrorCount > 0 ? 1 : 0), retryableFailures: 0, checkpointAfter: null,
    details: {
      dates: configuredDates, trading_dates: dates, excluded_non_trading_dates: excludedNonTradingDates,
      candidate_count: candidates.length, missing_pair_count: missing.length, already_complete: alreadyComplete,
      symbols_attempted: symbolsAttempted, symbols_fetch_failed: symbolsFetchFailed,
      pairs_written: pairsWritten, etfs_price_updated: etfsPriceUpdated, write_error_count: writeErrorCount,
      newly_confirmed_no_data: newlyConfirmedNoData.size, confirmed_no_data_total: confirmedNoData.size + newlyConfirmedNoData.size,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, dates: configuredDates, tradingDates: dates, excludedNonTradingDates,
    candidateCount: candidates.length, missingPairCount: missing.length, alreadyComplete,
    symbolsAttempted, symbolsFetchFailed, pairsWritten, etfsPriceUpdated, writeErrorCount,
    newlyConfirmedNoData: newlyConfirmedNoData.size,
  });
}
