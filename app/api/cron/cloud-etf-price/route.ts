// Cloud ETF price worker — bounded, idempotent, resumable via DB checkpoint.
//
// Reuses the existing YAHOO_CHART path (lib/services/dataProviders/yahoo/yahooClient) and the
// same etfHistory / etfPerformance / etf write shape as lib/cron/priceUpdate.ts. No new parser.
//
// Trigger: GitHub Actions schedule -> GET with `Authorization: Bearer <CRON_SECRET>`.
// One invocation: read ROLLING checkpoint -> take <=BATCH ETFs by id -> fetch -> upsert ->
// advance checkpoint -> write run log -> return. No loop. Wraps to the start of the universe
// once the id cursor passes the end.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { fetchYahooChartPeriod } from "@/lib/services/dataProviders/yahoo/yahooClient";
import {
  beginRun,
  finishRun,
  hourBucketKey,
  readCheckpoint,
  writeCheckpoint,
  type CheckpointRow,
} from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_ETF_PRICE";
const PROVIDER = "YAHOO_CHART";
const CHECKPOINT_KEY = "cloud-etf-price:ROLLING";
const DEFAULT_BATCH = 1000;
const MAX_BATCH = 1500;
const DAY = 86_400_000;
// Bounds re-checking an ETF to roughly this route's own existing cadence (hourly), so a same-day
// Yahoo close revision gets picked up on the next natural cycle instead of being permanently
// skipped for the rest of the UTC calendar day. This is not a new schedule — it's the same
// checkpoint/batch loop revisiting sooner. See freshness gate below.
const FRESHNESS_WINDOW_MS = 55 * 60_000;

const dateKey = (value: Date) => value.toISOString().slice(0, 10);
const utcDate = (value: Date) => new Date(`${dateKey(value)}T00:00:00.000Z`);

function periodReturn(rows: Array<{ date: Date; price: number }>, days: number): number | null {
  const latest = rows.at(-1);
  if (!latest) return null;
  const target = latest.date.getTime() - days * DAY;
  const base = [...rows].reverse().find((row) => row.date.getTime() <= target);
  return base?.price ? ((latest.price / base.price) - 1) * 100 : null;
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const url = new URL(request.url);
  const batch = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("batch") ?? DEFAULT_BATCH)));
  const startedMs = Date.now();

  const universeCount = await prisma.etf.count({ where: { isActive: true, dataSource: { not: null } } });
  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = hourBucketKey("cloud-etf-price");
  const { runId, skipped } = await beginRun({
    jobName: JOB,
    provider: PROVIDER,
    runKey,
    universeCount,
    batchSize: batch,
    checkpointBefore: before,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey });
  }

  let cursor = before?.lastSymbol ?? "";
  let wrapped = false;

  // Take the next id-window; if empty, the cursor is past the end -> wrap once.
  let candidates = await prisma.etf.findMany({
    where: { isActive: true, dataSource: { not: null }, id: { gt: cursor } },
    orderBy: { id: "asc" },
    take: batch,
    select: { id: true, dataSource: true, priceUpdatedAt: true, latestPrice: true },
  });
  if (candidates.length === 0 && cursor !== "") {
    wrapped = true;
    cursor = "";
    candidates = await prisma.etf.findMany({
      where: { isActive: true, dataSource: { not: null } },
      orderBy: { id: "asc" },
      take: batch,
      select: { id: true, dataSource: true, priceUpdatedAt: true, latestPrice: true },
    });
  }

  let attempted = 0;
  let inserted = 0;
  let updatedMaster = 0;
  let failed = 0;
  let retryable = 0;
  let freshSkipped = 0;
  let staleSkipped = 0;
  let http5xx = 0;
  const failures: Array<{ id: string; symbol: string; reason: string }> = [];
  let lastId = cursor;

  for (const etf of candidates) {
    lastId = etf.id;
    // Recency skip only — NOT "already updated today". A same-UTC-day gate would permanently miss
    // a Yahoo close revision published after this ETF's first update of the day; bounding by a
    // short recency window instead lets the next natural cycle re-check it.
    if (etf.priceUpdatedAt && Date.now() - etf.priceUpdatedAt.getTime() < FRESHNESS_WINDOW_MS) {
      freshSkipped++;
      continue;
    }
    attempted++;
    const symbol = etf.dataSource!;
    try {
      const from = etf.priceUpdatedAt ?? new Date(Date.now() - 1100 * DAY);
      const response = await fetchYahooChartPeriod(
        symbol,
        Math.floor((from.getTime() - 3 * DAY) / 1000),
        Math.floor((Date.now() + DAY) / 1000),
      );
      // Provider failure/no-data: never delete or overwrite existing rows — count as retryable.
      if (!response) {
        failed++;
        retryable++;
        http5xx++;
        failures.push({ id: etf.id, symbol, reason: "YAHOO_CHART_NULL" });
        continue;
      }
      const candles = response.candles.filter((row) => row.close != null && row.close > 0);
      const rawLatest = candles.at(-1);
      if (!rawLatest) {
        // valid empty series (delisted / no trading) — not a failure, leave existing row intact
        staleSkipped++;
        continue;
      }
      // Yahoo appends a live/in-progress candle for the session that's still open before it
      // closes. Only trust the most recent candle as a genuinely completed close once Yahoo's own
      // session-end timestamp has passed; otherwise treat it as still-forming and fall back to the
      // previous (always-final) candle for canonical writes. Everything strictly before that is
      // already-settled history regardless.
      const sourceDayCompleted = response.regularSessionEndsAt
        ? Date.now() >= response.regularSessionEndsAt.getTime()
        : utcDate(rawLatest.date).getTime() < utcDate(new Date()).getTime();
      const writableCandles = sourceDayCompleted ? candles : candles.slice(0, -1);
      const latest = writableCandles.at(-1);
      if (!latest) {
        // only an in-progress candle is available this cycle — nothing safe to write yet
        staleSkipped++;
        continue;
      }
      for (const row of writableCandles) {
        await prisma.etfHistory.upsert({
          where: { etfId_date: { etfId: etf.id, date: utcDate(row.date) } },
          create: {
            etfId: etf.id,
            date: utcDate(row.date),
            price: row.close,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            adjustedClose: row.adjClose,
            volume: row.volume,
            source: "YAHOO",
            sourceUrl: symbol,
            knownAt: new Date(),
          },
          update: {
            price: row.close,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            adjustedClose: row.adjClose,
            volume: row.volume,
            knownAt: new Date(),
          },
        });
      }
      const history = (
        await prisma.etfHistory.findMany({
          where: { etfId: etf.id, price: { not: null } },
          orderBy: { date: "desc" },
          take: 1100,
          select: { date: true, price: true },
        })
      ).reverse();
      const points = history
        .filter((x) => x.price != null)
        .map((x) => ({ date: x.date, price: Number(x.price) }));
      await prisma.etfPerformance.upsert({
        where: { etfId_date: { etfId: etf.id, date: utcDate(latest.date) } },
        create: {
          etfId: etf.id,
          date: utcDate(latest.date),
          price: latest.close,
          return1d: periodReturn(points, 1),
          return1m: periodReturn(points, 30),
          return3m: periodReturn(points, 91),
          return6m: periodReturn(points, 183),
          return1y: periodReturn(points, 365),
          return3y: periodReturn(points, 1096),
        },
        update: {
          price: latest.close,
          return1d: periodReturn(points, 1),
          return1m: periodReturn(points, 30),
          return3m: periodReturn(points, 91),
          return6m: periodReturn(points, 183),
          return1y: periodReturn(points, 365),
          return3y: periodReturn(points, 1096),
        },
      });
      inserted += writableCandles.length;

      // Master row: advance to a newer completed day, OR — Yahoo is the source of truth — accept
      // a same-day revision when the completed close for the SAME date actually changed. Never
      // overwrite with a stale/earlier provider date.
      const providerDate = utcDate(latest.date);
      const priorPrice = etf.latestPrice != null ? Number(etf.latestPrice) : null;
      const isNewerDay = !etf.priceUpdatedAt || providerDate.getTime() > utcDate(etf.priceUpdatedAt).getTime();
      const isSameDayRevision =
        !!etf.priceUpdatedAt &&
        providerDate.getTime() === utcDate(etf.priceUpdatedAt).getTime() &&
        priorPrice !== null &&
        latest.close !== priorPrice;
      if (isNewerDay || isSameDayRevision) {
        await prisma.etf.update({
          where: { id: etf.id },
          data: { latestPrice: latest.close, priceUpdatedAt: providerDate },
        });
        updatedMaster++;
      } else {
        staleSkipped++;
      }
    } catch (error) {
      failed++;
      retryable++;
      failures.push({ id: etf.id, symbol, reason: String(error).slice(0, 300) });
    }
  }

  // If we returned a short window (< batch) we reached the tail — wrap next run.
  const reachedEnd = candidates.length < batch;
  const nextCursor = reachedEnd ? "" : lastId;
  const after: CheckpointRow = {
    lastSymbol: nextCursor,
    processed: (before?.processed ?? 0) + attempted,
    succeeded: (before?.succeeded ?? 0) + updatedMaster,
    failed: (before?.failed ?? 0) + failed,
    updatedAt: new Date().toISOString(),
  };
  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: nextCursor,
    processed: after.processed,
    succeeded: after.succeeded,
    failed: after.failed,
  });

  const status = failed > 0 && inserted === 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status,
    attempted,
    completed: attempted - failed,
    inserted,
    updated: updatedMaster,
    failed,
    retryableFailures: retryable,
    checkpointAfter: after,
    error: failures.length ? `${failures.length} failures; e.g. ${failures[0]?.reason}` : null,
    details: {
      checkpoint_before: before,
      batch_size: batch,
      wrapped,
      reached_end: reachedEnd,
      window_size: candidates.length,
      fresh_skipped: freshSkipped,
      stale_skipped: staleSkipped,
      http_5xx: http5xx,
      http_403: 0,
      http_429: 0,
      sample_failures: failures.slice(0, 5),
    },
  });

  return Response.json({
    ok: true,
    job: JOB,
    runId,
    httpStatus: 200,
    checked: attempted,
    updated: updatedMaster,
    historyRowsUpserted: inserted,
    failed,
    retryableFailures: retryable,
    freshSkipped,
    staleSkipped,
    checkpointBefore: before?.lastSymbol ?? null,
    checkpointAfter: nextCursor || "(wrapped to start)",
    wrapped,
    reachedEnd,
    universeCount,
    runtimeMs: Date.now() - startedMs,
    status,
  });
}
