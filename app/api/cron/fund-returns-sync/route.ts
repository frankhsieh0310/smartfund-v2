// Domestic + offshore fund period-return sync, sourced from Yahoo奇摩's own fund "績效表現" page
// (lib/yahoo/fundPerformancePage.ts) instead of being self-computed from NAV history -- same
// "照抄 Yahoo奇摩顯示的數值" rule already applied to TW ETFs (etf-returns-sync) and TW ETF day-change
// (tw-etf-day-change). Reuses the SAME two mapping sources as holdings-alt-source-sync (offshore-nav-
// sync's offshore-nav-sync:yahoo-mapping checkpoint + fund_provider_mappings for domestic), since both
// already resolve fundId -> yahooFundId correctly -- no new discovery sweep needed.
//
// SHADOW MODE BY DEFAULT: unless FUND_RETURNS_SYNC_WRITE is exactly "on", fetches and classifies but
// writes nothing -- same pattern as every other sync job in this codebase. Manually cross-checked
// (shadow mode, browser) against 20 funds (15 domestic + 5 offshore) 2026-10-14: 20/20 exact match
// against the live page at request time (see docs/specs/fund-returns-shadow-verification.md).
//
// Writes fund_performances (fundId, date) -- a table nothing else currently populates for these
// domestic/offshore funds (checked: no other route/script inserts into fund_performances), so there
// is no column-ownership conflict to manage here, unlike etf_performances.
//
// Scheduled hourly at :41 (vercel.json) -- user-approved round-4 instruction: 150s time budget per
// invocation, >=3s request spacing, round-robin via the existing cursor (already-processed codes sort
// to the end via `code > afterCode`; wraps to the start once a full pass completes).
import { prisma } from "@/lib/prisma";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";
import { loadDomesticYahooMapping } from "@/lib/holdings-alt-source/domesticYahooMapping";
import { fetchYahooFundPerformance, YahooFundRateLimitedError } from "@/lib/yahoo/fundPerformancePage";
import { loadExchangeCalendarRegistry } from "@/lib/market-close-sync/marketConfig";
import { mostRecentTradingDay } from "@/lib/market-close-sync/marketTime";

export const runtime = "nodejs";
export const maxDuration = 290;
export const dynamic = "force-dynamic";

const JOB = "FUND_RETURNS_SYNC";
const CHECKPOINT_KEY = "fund-returns-sync:cursor";
const REQUEST_DELAY_MS = 3_200;
// Raised from 150s to 270s this round (audit found the 2,168-fund universe was taking ~4 days/pass
// at the old budget + hourly cadence): maxDuration=290s gives 20s margin. REQUEST_DELAY_MS is left
// untouched — that's the anti-scraping-pace rule, not the lever to pull. vercel.json also now
// triggers this route twice/hour (:11 and :41) instead of once, so the combined fix is budget x2
// AND frequency x2, comfortably covering the universe within a day.
const TIME_BUDGET_MS = 270_000;
const query = (sql: string, params: any[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function isWriteEnabled(): boolean {
  return process.env.FUND_RETURNS_SYNC_WRITE === "on";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabled = isWriteEnabled();
  // 2026-10-18 root-cause fix: previously wrote `today` (execution day) directly as the `date`
  // column, including on weekends (this route runs hourly, no weekday restriction) -- VERIFIED this
  // stamped non-trading-day dates onto real performance figures. These are TW-focused domestic +
  // offshore fund pages (Yahoo奇摩), so the TWSE calendar is the right one: reuse the exact registry
  // market-close-sync already maintains (config/production-yahoo-daily-jobs.json) rather than
  // inventing a second calendar.
  const registry = await loadExchangeCalendarRegistry();
  const twseJob = registry.jobs.find((j) => j.id === "twse-yahoo-daily")!;
  const today = mostRecentTradingDay(twseJob, new Date().toISOString().slice(0, 10));

  const [offshoreMapping, domesticMapping] = await Promise.all([loadMapping(query), loadDomesticYahooMapping(query)]);
  const combined = [...offshoreMapping, ...domesticMapping].sort((a, b) => a.code.localeCompare(b.code));

  const checkpoint = await readCheckpoint(CHECKPOINT_KEY);
  const afterCode = checkpoint?.lastSymbol ?? null;
  const startIndex = afterCode ? combined.findIndex((m) => m.code > afterCode) : 0;
  const batch = startIndex === -1 ? [] : combined.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + 200);

  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_FUND_PERFORMANCE_PAGE", runKey: `${JOB}:${today}:${afterCode ?? "start"}`,
    universeCount: combined.length, batchSize: batch.length, checkpointBefore: checkpoint,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey: afterCode });

  let attempted = 0, written = 0, noData = 0, failed = 0;
  let lastCode: string | null = afterCode;
  let rateLimitStop = false;
  let timeBudgetStop = false;

  for (const entry of batch) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    attempted++;
    try {
      const perf = await fetchYahooFundPerformance(entry.yahooFundId);
      if (perf) {
        if (writeEnabled) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO fund_performances (id, fund_id, date, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y, return_10y, created_at)
             VALUES (gen_random_uuid()::text, $1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
             ON CONFLICT (fund_id, date) DO UPDATE SET
               return_1m = EXCLUDED.return_1m, return_3m = EXCLUDED.return_3m, return_6m = EXCLUDED.return_6m,
               return_ytd = EXCLUDED.return_ytd, return_1y = EXCLUDED.return_1y, return_3y = EXCLUDED.return_3y,
               return_5y = EXCLUDED.return_5y, return_10y = EXCLUDED.return_10y`,
            entry.fundId, today, perf.m1, perf.m3, perf.m6, perf.ytd, perf.y1, perf.y3, perf.y5, perf.y10,
          );
        }
        written++;
      } else {
        noData++;
      }
    } catch (e) {
      if (e instanceof YahooFundRateLimitedError) { rateLimitStop = true; break; }
      failed++;
    }
    lastCode = entry.code;
    await sleep(REQUEST_DELAY_MS);
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: rateLimitStop || timeBudgetStop || batch.length === 200 ? lastCode : null, // null = wrap to start next time
    processed: attempted, succeeded: written, failed: noData + failed,
  });

  const status = rateLimitStop || timeBudgetStop ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, "YAHOO_FUND_PERFORMANCE_PAGE", startedMs, {
    status, attempted, completed: written, inserted: written, updated: 0, failed: noData + failed, retryableFailures: 0,
    checkpointAfter: null,
    details: { writeEnabled, rateLimitStop, timeBudgetStop, lastCode, universeCount: combined.length },
  });

  return Response.json({ ok: true, job: JOB, runId, status, attempted, written, noData, failed, writeEnabled, lastCode, universeCount: combined.length });
}
