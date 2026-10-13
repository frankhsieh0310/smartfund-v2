// Dedicated job for TW-listed ETF day-change (etf_performances.return_1d), sourced from Yahoo奇摩's
// own quote page (lib/yahoo/twQuotePage.ts) instead of being self-computed. Kept SEPARATE from
// cloud-etf-price (which owns return_1d for every OTHER ETF, self-computed, since Yahoo奇摩 has no
// page for non-TW tickers) so that route's existing batch size/time budget for price-history syncing
// isn't slowed down by this courtesy-paced (3.2s+) Yahoo奇摩 fetch, which only ~400 TW ETFs need.
//
// SHADOW MODE BY DEFAULT: unless TW_ETF_DAY_CHANGE_WRITE is exactly "on", fetches and classifies but
// writes nothing — same pattern as etf-returns-sync's writeGate.
//
// NOT added to vercel.json yet — this is a new job, scheduling it is a separate decision for the user.
// Suggested schedule once approved: once daily, shortly after TWSE/TPEx close (e.g. "45 7 * * 1-5" UTC
// = 15:45 Taipei, 15 min after the 14:30 close) — day-change only needs to be correct once prices stop
// moving for the day, per the user's own framing when asking for this fix.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { fetchYahooTwDayChange, YahooTwQuoteRateLimitedError } from "@/lib/yahoo/twQuotePage";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 290;
export const dynamic = "force-dynamic";

const JOB = "TW_ETF_DAY_CHANGE";
const CHECKPOINT_KEY = "tw-etf-day-change:cursor";
const REQUEST_DELAY_MS = 3_200;
const TIME_BUDGET_MS = 260_000;

function isWriteEnabled(): boolean {
  return process.env.TW_ETF_DAY_CHANGE_WRITE === "on";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabled = isWriteEnabled();
  const today = new Date().toISOString().slice(0, 10);

  const checkpoint = await readCheckpoint(CHECKPOINT_KEY);
  const afterCode = checkpoint?.lastSymbol ?? null;

  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_TW_QUOTE_PAGE", runKey: `${JOB}:${today}:${afterCode ?? "start"}`,
    universeCount: 0, batchSize: 0, checkpointBefore: checkpoint,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey: afterCode });

  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; data_source: string }>>(
    `SELECT id, code, data_source FROM etfs
     WHERE is_active = true AND data_source ~ '\\.(TW|TWO)$' ${afterCode ? "AND code > $1" : ""}
     ORDER BY code LIMIT 200`,
    ...(afterCode ? [afterCode] : []),
  );

  let attempted = 0, written = 0, noData = 0, failed = 0;
  let lastCode: string | null = afterCode;
  let rateLimitStop = false;
  let timeBudgetStop = false;

  for (const row of rows) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    attempted++;
    try {
      const change = await fetchYahooTwDayChange(row.data_source);
      if (change) {
        if (writeEnabled) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO etf_performances (id, etf_id, date, return_1d, created_at)
             VALUES (gen_random_uuid()::text, $1, $2::date, $3, NOW())
             ON CONFLICT (etf_id, date) DO UPDATE SET return_1d = EXCLUDED.return_1d`,
            row.id, today, change.changePercent,
          );
        }
        written++;
      } else {
        noData++;
      }
    } catch (e) {
      if (e instanceof YahooTwQuoteRateLimitedError) { rateLimitStop = true; break; }
      failed++;
    }
    lastCode = row.code;
    await sleep(REQUEST_DELAY_MS);
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: rateLimitStop || timeBudgetStop || rows.length === 200 ? lastCode : null, // null = wrap to start next time (full pass done)
    processed: attempted, succeeded: written, failed: noData + failed,
  });

  const status = rateLimitStop || timeBudgetStop ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, "YAHOO_TW_QUOTE_PAGE", startedMs, {
    status, attempted, completed: written, inserted: written, updated: 0, failed: noData + failed, retryableFailures: 0,
    checkpointAfter: null,
    details: { writeEnabled, rateLimitStop, timeBudgetStop, lastCode },
  });

  return Response.json({ ok: true, job: JOB, runId, status, attempted, written, noData, failed, writeEnabled, lastCode });
}
