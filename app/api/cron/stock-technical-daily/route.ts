// Daily incremental refresh for stock_technical (TW scope only this round -- see
// lib/cron/stockTechnicalDaily.ts for why this is a separate job from the existing backfill
// script and why other markets aren't covered yet). Shadow mode by default
// (STOCK_TECHNICAL_SYNC_WRITE), left off until the final consolidated deploy per instruction.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { findStaleTwStocks, refreshStockTechnical } from "@/lib/cron/stockTechnicalDaily";
import { isStockTechnicalSyncWriteEnabled } from "@/lib/cron/stockTechnicalWriteGate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const BATCH_SIZE = 100;
const TIME_BUDGET_MS = 250_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const JOB = "STOCK_TECHNICAL_DAILY_TW";
  // 2026-11-05 VERIFIED（修正根因，不是改排程）: 這支route從來沒有真的讀/寫checkpoint
  // （下面beginRun固定傳checkpointBefore:null，finishRun固定傳checkpointAfter:null）——每次呼叫
  // 永遠從cursor=null（ticker最前面）開始掃「目前還落後」的股票，250秒時間預算每次只夠處理
  // 1,500~1,900檔，剩下排在後面（數字較大的ticker，例如8104~8937這個興櫃/其他板區段）的股票，
  // 只有當某一天剛好跑得夠快、一次就把全部落後股票掃完時才會被處理到——10/28剛好是那種幸運的
  // 一天（cursor跑到8937），10/29起每天都因為同一批股票又變成落後（當天新價格一來，全部都要重算）
  // 而來不及在250秒內再掃到那麼後面，造成8104~8937這109檔技術指標卡在10/28沒再更新過，一卡就是
  // 8天。修正：用跟sitca-nav-sync/etf-official-holdings同一套checkpoint機制，讓cursor在同一個
  // Taipei日曆日內的多次呼叫之間延續（不是每次都從頭來），真正掃完一輪（stale.length<BATCH_SIZE）
  // 才清空cursor讓明天從頭開始。
  const checkpointKey = "stock-technical-daily-tw";
  const taipeiToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const runKey = `stock-technical-daily-tw:${taipeiToday}:${Math.floor(started / 60_000)}`;
  const before = await readCheckpoint(checkpointKey);
  const isFromToday = before?.updatedAt
    ? new Date(new Date(before.updatedAt).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) === taipeiToday
    : false;
  const effectiveCheckpoint = isFromToday ? before : null;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "INTERNAL_COMPUTE", runKey, universeCount: 0, batchSize: BATCH_SIZE, checkpointBefore: effectiveCheckpoint });
  if (skipped) return Response.json({ ok: true, task: "stock-technical-daily", skipped: true });

  const writeEnabled = isStockTechnicalSyncWriteEnabled();
  let cursor: string | null = effectiveCheckpoint?.lastSymbol ?? null;
  let totalStale = 0, totalWritten = 0, totalChecked = 0;
  let reachedEnd = false;
  const failed: { ticker: string; reason: string }[] = [];
  try {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const stale = await findStaleTwStocks(BATCH_SIZE, cursor);
      if (stale.length === 0) { reachedEnd = true; break; }
      for (const s of stale) {
        totalChecked++;
        try {
          const r = await refreshStockTechnical(s.id, s.latestTechnicalDate, writeEnabled);
          totalStale += r.rowsComputed > 0 ? 1 : 0;
          totalWritten += r.rowsWritten;
        } catch (e) {
          failed.push({ ticker: s.ticker, reason: (e as Error).message });
        }
      }
      cursor = stale[stale.length - 1].ticker;
      if (stale.length < BATCH_SIZE) { reachedEnd = true; break; } // reached the end of TW universe this pass
      if (Date.now() - started >= TIME_BUDGET_MS) break;
    }
    await writeCheckpoint(JOB, checkpointKey, runId, {
      lastSymbol: reachedEnd ? null : cursor,
      processed: (isFromToday ? effectiveCheckpoint?.processed ?? 0 : 0) + totalChecked,
      succeeded: (isFromToday ? effectiveCheckpoint?.succeeded ?? 0 : 0) + totalStale,
      failed: (isFromToday ? effectiveCheckpoint?.failed ?? 0 : 0) + failed.length,
    });
    await finishRun(runId, JOB, "INTERNAL_COMPUTE", started, {
      status: failed.length > 0 && totalWritten === 0 ? "PARTIAL" : "COMPLETED",
      attempted: totalChecked, completed: totalStale, inserted: totalWritten, updated: 0,
      failed: failed.length, retryableFailures: failed.length, checkpointAfter: null,
      details: { writeEnabled, cursor, reachedEnd },
    });
    return Response.json({ ok: true, task: "stock-technical-daily", writeEnabled, totalChecked, totalStale, totalWritten, failed, cursor, reachedEnd });
  } catch (e) {
    await finishRun(runId, JOB, "INTERNAL_COMPUTE", started, { status: "FAILED", attempted: totalChecked, completed: 0, inserted: totalWritten, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, task: "stock-technical-daily", error: (e as Error).message }, { status: 500 });
  }
}
