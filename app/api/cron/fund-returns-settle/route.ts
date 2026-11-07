// 2026-11-08（使用者核准，第38輪指令第一點乙）: 每晚結算排程——fund-returns-sync白天抓到的
// 「pending_settle=true」資料（Yahoo奇摩頁面淨值日期標籤已經跳到當天，但績效數字還沒跟上）
// 台北時間晚上九點半以後重新抓一次，這時Yahoo自己應該已經把當天數字算完，數字照抄寫入正式
// 資料（同一天直接覆蓋），並清除pending_settle旗標。跟fund-returns-sync一樣分批＋時間預算，
// 凌晨01:00-05:30不跑（沿用CLAUDE.md「資料庫維護窗口」慣例）。
import { prisma } from "@/lib/prisma";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";
import { loadDomesticYahooMapping } from "@/lib/holdings-alt-source/domesticYahooMapping";
import { fetchYahooFundPerformance, YahooFundRateLimitedError } from "@/lib/yahoo/fundPerformancePage";

export const runtime = "nodejs";
export const maxDuration = 290;
export const dynamic = "force-dynamic";

const JOB = "FUND_RETURNS_SETTLE";
const CHECKPOINT_KEY = "fund-returns-settle:cursor";
const REQUEST_DELAY_MS = 3_200;
const TIME_BUDGET_MS = 260_000;
const query = (sql: string, params: any[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function isWriteEnabled(): boolean {
  return process.env.FUND_RETURNS_SETTLE_WRITE?.trim() === "on";
}
function isWithinMaintenanceBlackout(now: Date): boolean {
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const minutesOfDay = utcH * 60 + utcM;
  return minutesOfDay >= 17 * 60 && minutesOfDay <= 21 * 60 + 30; // 01:00-05:30 台北 = UTC 17:00-21:30
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  if (isWithinMaintenanceBlackout(new Date())) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "MAINTENANCE_BLACKOUT_0100_0530_TAIPEI" });
  }

  const startedMs = Date.now();
  const writeEnabled = isWriteEnabled();

  const pendingRows = await prisma.$queryRawUnsafe<Array<{ fund_id: string; date: string }>>(
    `SELECT fund_id, date::text AS date FROM fund_performances WHERE pending_settle = TRUE ORDER BY fund_id`,
  );
  if (!pendingRows.length) {
    return Response.json({ ok: true, job: JOB, attempted: 0, written: 0, noData: 0, failed: 0, note: "NO_PENDING_ROWS" });
  }

  const [offshoreMapping, domesticMapping] = await Promise.all([loadMapping(query), loadDomesticYahooMapping(query)]);
  const yahooIdByFundId = new Map<string, string>();
  for (const m of [...offshoreMapping, ...domesticMapping]) yahooIdByFundId.set(m.fundId, m.yahooFundId);

  const checkpoint = await readCheckpoint(CHECKPOINT_KEY);
  const afterFundId = checkpoint?.lastSymbol ?? null;
  const sortedPending = [...pendingRows].sort((a, b) => a.fund_id.localeCompare(b.fund_id));
  const startIndex = afterFundId ? sortedPending.findIndex((r) => r.fund_id > afterFundId) : 0;
  const batch = startIndex === -1 ? [] : sortedPending.slice(Math.max(startIndex, 0));

  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_FUND_PERFORMANCE_PAGE", runKey: `${JOB}:${new Date().toISOString().slice(0, 10)}:${afterFundId ?? "start"}`,
    universeCount: pendingRows.length, batchSize: batch.length, checkpointBefore: checkpoint,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey: afterFundId });

  let attempted = 0, written = 0, noData = 0, failed = 0;
  let lastFundId: string | null = afterFundId;
  let rateLimitStop = false;
  let timeBudgetStop = false;

  for (const row of batch) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    const yahooFundId = yahooIdByFundId.get(row.fund_id);
    if (!yahooFundId) {
      // 找不到mapping，無法重抓——放棄這一列的結算（清掉pending避免永遠卡住），不動既有數字。
      if (writeEnabled) await prisma.$executeRawUnsafe(`UPDATE fund_performances SET pending_settle = FALSE WHERE fund_id = $1 AND date = $2::date`, row.fund_id, row.date);
      noData++;
      lastFundId = row.fund_id;
      continue;
    }
    attempted++;
    try {
      const perf = await fetchYahooFundPerformance(yahooFundId);
      if (perf && perf.asOfDate) {
        if (writeEnabled) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO fund_performances (id, fund_id, date, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y, return_10y, created_at, pending_settle, suspect_unsettled)
             VALUES (gen_random_uuid()::text, $1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), FALSE, FALSE)
             ON CONFLICT (fund_id, date) DO UPDATE SET
               return_1m = EXCLUDED.return_1m, return_3m = EXCLUDED.return_3m, return_6m = EXCLUDED.return_6m,
               return_ytd = EXCLUDED.return_ytd, return_1y = EXCLUDED.return_1y, return_3y = EXCLUDED.return_3y,
               return_5y = EXCLUDED.return_5y, return_10y = EXCLUDED.return_10y,
               pending_settle = FALSE, suspect_unsettled = FALSE`,
            row.fund_id, perf.asOfDate, perf.m1, perf.m3, perf.m6, perf.ytd, perf.y1, perf.y3, perf.y5, perf.y10,
          );
          // 原本那一列（白天抓的、可能是不同日期鍵）也一併清掉pending，避免同一基金殘留兩筆
          // 都標pending的情況。
          await prisma.$executeRawUnsafe(`UPDATE fund_performances SET pending_settle = FALSE WHERE fund_id = $1 AND date = $2::date AND date <> $3::date`, row.fund_id, row.date, perf.asOfDate);
        }
        written++;
      } else {
        if (writeEnabled) await prisma.$executeRawUnsafe(`UPDATE fund_performances SET pending_settle = FALSE WHERE fund_id = $1 AND date = $2::date`, row.fund_id, row.date);
        noData++;
      }
    } catch (e) {
      if (e instanceof YahooFundRateLimitedError) { rateLimitStop = true; break; }
      failed++;
    }
    lastFundId = row.fund_id;
    await sleep(REQUEST_DELAY_MS);
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: rateLimitStop || timeBudgetStop ? lastFundId : null,
    processed: attempted, succeeded: written, failed: noData + failed,
  });

  const status = rateLimitStop || timeBudgetStop ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, "YAHOO_FUND_PERFORMANCE_PAGE", startedMs, {
    status, attempted, completed: written, inserted: written, updated: 0, failed: noData + failed, retryableFailures: 0,
    checkpointAfter: null,
    details: { writeEnabled, rateLimitStop, timeBudgetStop, lastFundId, pendingUniverseCount: pendingRows.length },
  });

  return Response.json({ ok: true, job: JOB, runId, status, attempted, written, noData, failed, writeEnabled, lastFundId, pendingUniverseCount: pendingRows.length });
}
