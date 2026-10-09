// Market-close-sync — SHADOW MODE ONLY. Confirms, per eligible closed market, what Yahoo Spark would
// write vs what etf_history/etfs already have — and logs the comparison. Writes NOTHING to
// etf_history, etf_performance, or etfs. The only writes anywhere in this route are the existing
// run-log/checkpoint tables via beginRun/finishRun/writeCheckpoint (lib/cloud-ingestion/runContext),
// reused unmodified.
//
// ETF-only, per task scope. No stock/fund handling here.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { loadExchangeCalendarRegistry, ETF_EXCHANGE_TO_JOB_ID, jobForEtfExchange } from "@/lib/market-close-sync/marketConfig";
import { marketCloseEligibility, pickClosedCandle } from "@/lib/market-close-sync/marketTime";
import { fetchSparkBatch, SPARK_MAX_SYMBOLS_PER_BATCH } from "@/lib/market-close-sync/sparkClient";
import { classify } from "@/lib/market-close-sync/shadowCompare";
import type { ExchangeCalendarJob, ShadowClassification } from "@/lib/market-close-sync/types";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "MARKET_CLOSE_SYNC_SHADOW";
const TIME_BUDGET_MS = 240_000;
const REQUEST_DELAY_MS = 300;

type Cursor = { date: string; etfId: string; done: boolean };

function parseCursor(lastSymbol: string | null): Cursor {
  if (!lastSymbol) return { date: "", etfId: "", done: false };
  const [date, rest] = lastSymbol.split("|");
  if (rest === "DONE") return { date, etfId: "", done: true };
  return { date, etfId: rest ?? "", done: false };
}
function encodeCursor(c: Cursor): string {
  return `${c.date}|${c.done ? "DONE" : c.etfId}`;
}

type MarketDetail = {
  jobId: string;
  eligible: boolean;
  targetLocalDate: string | null;
  requested: number;
  classifications: Record<ShadowClassification, number>;
  sourceMissingSymbols: string[];
  doneForToday: boolean;
};

const emptyCounts = (): Record<ShadowClassification, number> => ({ NEW: 0, CHANGED: 0, SAME: 0, SOURCE_MISSING: 0, DB_NEWER: 0 });

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const now = new Date();
  const registry = await loadExchangeCalendarRegistry();

  // Reverse-map config jobs -> the ETF exchange string(s) that resolve to them, so each eligible job
  // is only queried once even if multiple etfs.exchange values map onto it.
  const jobIdToEtfExchanges = new Map<string, string[]>();
  for (const [etfExchange, jobId] of Object.entries(ETF_EXCHANGE_TO_JOB_ID)) {
    jobIdToEtfExchanges.set(jobId, [...(jobIdToEtfExchanges.get(jobId) ?? []), etfExchange]);
  }

  const marketDetails: MarketDetail[] = [];
  let timeBudgetStop = false;
  let rateLimitStop = false;
  const runKey = hourBucketKey("market-close-sync");
  const { runId, skipped } = await beginRun({
    jobName: JOB,
    provider: "YAHOO_SPARK",
    runKey,
    universeCount: 0,
    batchSize: SPARK_MAX_SYMBOLS_PER_BATCH,
    checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey });
  }

  const consideredJobIds = [...new Set(Object.values(ETF_EXCHANGE_TO_JOB_ID))];
  for (const jobId of consideredJobIds) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    if (rateLimitStop) break;

    const job = jobForEtfExchange(registry, Object.keys(ETF_EXCHANGE_TO_JOB_ID).find((k) => ETF_EXCHANGE_TO_JOB_ID[k] === jobId) ?? "");
    if (!job) continue; // schedulerEnabled=false or job id not found in current config

    const eligibility = marketCloseEligibility(job, now);
    if (!eligibility) {
      marketDetails.push({ jobId, eligible: false, targetLocalDate: null, requested: 0, classifications: emptyCounts(), sourceMissingSymbols: [], doneForToday: false });
      continue;
    }
    const { targetLocalDate } = eligibility;

    const checkpointKey = `market-close-sync:${jobId}`;
    const before = await readCheckpoint(checkpointKey);
    let cursor = parseCursor(before?.lastSymbol ?? null);
    if (cursor.date !== targetLocalDate) cursor = { date: targetLocalDate, etfId: "", done: false }; // new trading day — reset

    if (cursor.done) {
      marketDetails.push({ jobId, eligible: true, targetLocalDate, requested: 0, classifications: emptyCounts(), sourceMissingSymbols: [], doneForToday: true });
      continue;
    }

    const etfExchanges = jobIdToEtfExchanges.get(jobId) ?? [];
    const counts = emptyCounts();
    const sourceMissingSymbols: string[] = [];
    let requested = 0;
    let marketDone = false;

    while (Date.now() - startedMs <= TIME_BUDGET_MS) {
      const candidates = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; exchange: string; data_source: string; price_updated_at: Date | null; latest_price: unknown }>>(
        `SELECT id, code, exchange, data_source, price_updated_at, latest_price
           FROM etfs
          WHERE is_active = true AND data_source IS NOT NULL AND exchange = ANY($1) AND id > $2
          ORDER BY id ASC LIMIT $3`,
        etfExchanges, cursor.etfId, SPARK_MAX_SYMBOLS_PER_BATCH,
      );
      if (candidates.length === 0) { marketDone = true; break; }

      await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
      const batch = await fetchSparkBatch(candidates.map((c) => c.data_source));
      if (batch.rateLimited) { rateLimitStop = true; break; }

      const bySymbol = new Map(batch.candles.map((c) => [c.symbol, c.points]));
      for (const etf of candidates) {
        requested++;
        const points = bySymbol.get(etf.data_source) ?? [];
        const picked = pickClosedCandle(points, job, targetLocalDate, now);
        const dbDate = etf.price_updated_at ? new Date(etf.price_updated_at).toISOString().slice(0, 10) : null;
        const dbClose = etf.latest_price != null ? Number(etf.latest_price) : null;
        const sparkDate = picked ? targetLocalDate : null;
        const sparkClose = picked?.close ?? null;
        const c = classify({ dbDate, dbClose, sparkDate, sparkClose });
        counts[c]++;
        if (c === "SOURCE_MISSING" && sourceMissingSymbols.length < 20) sourceMissingSymbols.push(etf.data_source);
      }
      cursor = { date: targetLocalDate, etfId: candidates[candidates.length - 1].id, done: false };
      await writeCheckpoint(JOB, checkpointKey, runId, { lastSymbol: encodeCursor(cursor), processed: requested, succeeded: counts.SAME + counts.CHANGED + counts.NEW, failed: counts.SOURCE_MISSING });
      if (candidates.length < SPARK_MAX_SYMBOLS_PER_BATCH) { marketDone = true; break; }
    }

    if (marketDone) {
      cursor = { date: targetLocalDate, etfId: "", done: true };
      await writeCheckpoint(JOB, checkpointKey, runId, { lastSymbol: encodeCursor(cursor), processed: requested, succeeded: counts.SAME + counts.CHANGED + counts.NEW, failed: counts.SOURCE_MISSING });
    }

    marketDetails.push({ jobId, eligible: true, targetLocalDate, requested, classifications: counts, sourceMissingSymbols, doneForToday: marketDone });
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
  }

  const status = rateLimitStop ? "PARTIAL" : timeBudgetStop ? "PARTIAL" : "COMPLETED";
  const totalRequested = marketDetails.reduce((s, m) => s + m.requested, 0);
  const totalSourceMissing = marketDetails.reduce((s, m) => s + m.classifications.SOURCE_MISSING, 0);
  await finishRun(runId, JOB, "YAHOO_SPARK", startedMs, {
    status,
    attempted: totalRequested,
    completed: totalRequested - totalSourceMissing,
    inserted: 0, // shadow mode — never writes price rows
    updated: 0, // shadow mode — never writes price rows
    failed: totalSourceMissing,
    retryableFailures: 0,
    checkpointAfter: null,
    details: { time_budget_stop: timeBudgetStop, rate_limit_stop: rateLimitStop, markets: marketDetails },
  });

  return Response.json({ ok: true, job: JOB, runId, status, timeBudgetStop, rateLimitStop, markets: marketDetails });
}
