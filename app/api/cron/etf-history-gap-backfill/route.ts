// Targeted gap-backfill for etf_history. Separate from cloud-etf-price's hourly rolling cursor
// (which only reaches ~500 of the 6,100+ core-universe ETFs per run, so any one ETF can go many
// hours between refreshes) -- this route finds ETFs that are BEHIND THEIR OWN EXCHANGE PEERS'
// latest history date and retries exactly those, so a lag self-heals in minutes instead of
// waiting for the rolling cursor's turn.
//
// 2026-10-24 root-cause finding (VERIFIED live): the symptom that triggered this route -- 0050 and
// 534 other core ETFs' detail pages 404ing -- was NOT one root cause. Two different things were
// mixed together:
//   1. 359 of them are TWSE/TPEx-listed. VERIFIED both exchanges' own official feeds -- not just
//      the "latest" feeds but date-explicit queries for 2026-10-23 specifically (TWSE STOCK_DAY,
//      STOCK_DAY_AVG_ALL, and MI_INDEX; TPEx's otc/afterTrading endpoint, which came back
//      "stat":"ok","totalCount":0, a clean non-error response) -- show ZERO trading records for
//      that date on either exchange. VERIFIED separately against TWSE's own published annual
//      holiday calendar (twse.com.tw holidaySchedule, now at
//      lib/market-calendar/twseHolidayCalendar.ts) that 2026-10-23 is NOT a listed holiday --
//      October only has 10/9 (National Day makeup) and 10/26 (Taiwan Retrocession Day makeup).
//      So this was a genuine trading day on the calendar with no data published by either
//      exchange -- exact cause UNKNOWN (a same-week ad-hoc closure, e.g. typhoon, is plausible
//      but no suspension-announcement endpoint was found to confirm it; no fetch error on our
//      side either). There is nothing to backfill FOR THESE SPECIFIC ETFs from any source, since
//      the exchanges' own systems have nothing to serve -- daily-health-report's
//      TW_EXCHANGE_WIDE_DATA_GAP check (cross-referencing the same holiday calendar) is what
//      surfaces this class of problem going forward instead of requiring another by-hand
//      investigation. The ETF detail-page bug (treating "not fresh" as "404") was real and is
//      fixed separately in app/etf/[code]/page.tsx regardless of which of these two explanations
//      turns out to be true for any given gap.
//   2. 175 of them are US-exchange-listed (NYSEArca/NasdaqGM/Cboe US/etc). VERIFIED live via
//      Yahoo's own chart API that most of these (4 of 5 spot-checked) already HAVE a real Friday
//      close available upstream -- our own pipeline just hadn't reached them yet this cycle. THIS
//      is the part this route targets: close the gap between "Yahoo already has it" and "our DB
//      has it" fast, instead of waiting out the hourly rolling cursor.
// Per CLAUDE.md's Yahoo-priority rule for non-core-market data, this route uses Yahoo for every
// exchange (including TW) as the single refetch source -- it does NOT call the TWSE/TPEx APIs to
// write data, only used them once, manually, to diagnose the TW side above. If Yahoo itself has no
// close for the gap date, nothing is written (same safe behavior as cloud-etf-price) and that ETF
// stays correctly flagged by the health-report check (lib/daily-health-report) instead of being
// silently dropped or backfilled with a guess.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { fetchYahooChartPeriod } from "@/lib/services/dataProviders/yahoo/yahooClient";
import { getCoreUniverseEtfIds } from "@/lib/tw-purchasable/coreUniverseFilter";
import { beginRun, finishRun, hourBucketKey } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "ETF_HISTORY_GAP_BACKFILL";
const PROVIDER = "YAHOO_CHART";
const TIME_BUDGET_MS = 240_000;
const MAX_LAG_DAYS = 5; // ignore ETFs more than this far behind peers -- those are a different, deeper problem, not a same-day catch-up case this route should touch
const MAX_ITEMS_PER_RUN = 300;
const DAY = 86_400_000;

const dateKey = (value: Date) => value.toISOString().slice(0, 10);
const utcDate = (value: Date) => new Date(`${dateKey(value)}T00:00:00.000Z`);

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const coreIds = Array.from(await getCoreUniverseEtfIds());
  const runKey = hourBucketKey("etf-history-gap-backfill");
  const { runId, skipped } = await beginRun({
    jobName: JOB,
    provider: PROVIDER,
    runKey,
    universeCount: coreIds.length,
    batchSize: MAX_ITEMS_PER_RUN,
    checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey });

  // Peer-max per exchange: the latest etf_history date actually reached by ANY core-universe ETF
  // on that exchange right now. An ETF behind its own exchange's peer-max is a real gap; an ETF
  // whose whole exchange shares the same max (e.g. every TWSE/TPEx ETF on a non-trading day) is
  // not -- this sidesteps needing an exchange holiday calendar entirely.
  const peerMaxRows = await prisma.$queryRawUnsafe<{ exchange: string | null; max_date: Date | null }[]>(
    `SELECT e.exchange, MAX(h.date) AS max_date
     FROM etfs e JOIN etf_history h ON h.etf_id = e.id
     WHERE e.id = ANY($1::text[]) AND h.price IS NOT NULL
     GROUP BY e.exchange`,
    coreIds,
  );
  const peerMaxByExchange = new Map(peerMaxRows.filter((r) => r.max_date).map((r) => [r.exchange, r.max_date as Date]));

  const gapRows = await prisma.$queryRawUnsafe<{ id: string; code: string; exchange: string | null; data_source: string | null; latest_history: Date | null }[]>(
    `SELECT e.id, e.code, e.exchange, e.data_source,
            (SELECT MAX(h.date) FROM etf_history h WHERE h.etf_id = e.id AND h.price IS NOT NULL) AS latest_history
     FROM etfs e WHERE e.id = ANY($1::text[]) AND e.is_active = true AND e.data_source IS NOT NULL`,
    coreIds,
  );

  const candidates = gapRows.filter((row) => {
    const peerMax = peerMaxByExchange.get(row.exchange);
    if (!peerMax) return false;
    if (!row.latest_history) return true;
    const lagDays = (peerMax.getTime() - utcDate(row.latest_history).getTime()) / DAY;
    return lagDays > 0 && lagDays <= MAX_LAG_DAYS;
  }).slice(0, MAX_ITEMS_PER_RUN);

  let attempted = 0, inserted = 0, failed = 0, noNewData = 0;
  const failures: Array<{ code: string; reason: string }> = [];
  const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,15}$/;

  for (const row of candidates) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) break;
    const hasSuffix = /\.(TW|TWO)$/.test(row.data_source!);
    const suffix = row.exchange === "TWSE" ? ".TW" : row.exchange === "TPEx" ? ".TWO" : null;
    const symbol = hasSuffix ? row.data_source! : suffix ? `${row.data_source}${suffix}` : row.data_source!;
    if (!SYMBOL_RE.test(symbol)) { failed++; failures.push({ code: row.code, reason: "INVALID_SYMBOL" }); continue; }
    attempted++;
    try {
      const from = row.latest_history ? utcDate(row.latest_history) : new Date(Date.now() - 10 * DAY);
      const response = await fetchYahooChartPeriod(symbol, Math.floor((from.getTime() - 2 * DAY) / 1000), Math.floor((Date.now() + DAY) / 1000));
      if (!response) { failed++; failures.push({ code: row.code, reason: "YAHOO_CHART_NULL" }); continue; }
      const newCandles = response.candles.filter((c) => c.close != null && c.close > 0 && (!row.latest_history || utcDate(c.date).getTime() > utcDate(row.latest_history).getTime()));
      if (newCandles.length === 0) { noNewData++; continue; }
      for (const candle of newCandles) {
        await prisma.etfHistory.upsert({
          where: { etfId_date: { etfId: row.id, date: utcDate(candle.date) } },
          create: { etfId: row.id, date: utcDate(candle.date), price: candle.close, open: candle.open, high: candle.high, low: candle.low, close: candle.close, adjustedClose: candle.adjClose, volume: candle.volume, source: "YAHOO", sourceUrl: symbol, knownAt: new Date() },
          update: { price: candle.close, open: candle.open, high: candle.high, low: candle.low, close: candle.close, adjustedClose: candle.adjClose, volume: candle.volume, knownAt: new Date() },
        });
      }
      inserted += newCandles.length;
      const latestCandle = newCandles.at(-1)!;
      const providerDate = utcDate(latestCandle.date);
      const etfRow = await prisma.etf.findUnique({ where: { id: row.id }, select: { priceUpdatedAt: true } });
      if (!etfRow?.priceUpdatedAt || providerDate.getTime() > utcDate(etfRow.priceUpdatedAt).getTime()) {
        await prisma.etf.update({ where: { id: row.id }, data: { latestPrice: latestCandle.close, priceUpdatedAt: providerDate } });
      }
    } catch (error) {
      failed++;
      failures.push({ code: row.code, reason: String(error).slice(0, 300) });
    }
  }

  const status = failed > 0 && inserted === 0 && attempted > 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status,
    attempted,
    completed: attempted - failed,
    inserted,
    updated: 0,
    failed,
    retryableFailures: failed,
    checkpointAfter: null,
    error: failures.length ? `${failures.length} failures; e.g. ${failures[0]?.reason}` : null,
    details: { gapCandidatesFound: candidates.length, noNewData, sampleFailures: failures.slice(0, 10) },
  });

  return Response.json({ ok: true, job: JOB, gapCandidatesFound: candidates.length, attempted, inserted, noNewData, failed });
}
