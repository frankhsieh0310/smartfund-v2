// 選股反查：Yahoo基本面同步 cron（2026-10-24，使用者核准定案）。全球股票（台股＋美股，country
// 不限定）本益比/股價淨值比/殖利率/ROE/ROA/營收成長率/盈餘成長率/毛利率/淨利率一律照抄Yahoo
// quoteSummary，不自己算——見lib/cron/yahooFundamentalsSync.ts。Shadow mode by default
// (YAHOO_FUNDAMENTALS_SYNC_WRITE)，同一套慣例：run_key/production_scheduler_runs/checkpoint，
// 0筆且應該有新資料時回報SKIPPED/PARTIAL不是COMPLETED，401/403/429由fetchQuoteSummary既有的
// crumb重試/backoff處理，連續失敗會反映在run的failed計數，不會被吃掉。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, hourBucketKey, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { findStaleFundamentalStocks, syncOneStockFundamentals } from "@/lib/cron/yahooFundamentalsSync";
import { isYahooFundamentalsSyncWriteEnabled } from "@/lib/cron/yahooFundamentalsWriteGate";
import { newRateStats, sleep } from "@/lib/yahoo/productSession";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_YAHOO_FUNDAMENTALS_REFRESH";
const PROVIDER = "YAHOO_QUOTE_SUMMARY";
const CHECKPOINT_KEY = "cloud-yahoo-fundamentals-refresh:ROLLING";
const BATCH_SIZE = 50;
const TIME_BUDGET_MS = 250_000;
const PACE_MS = 500; // 介於呼叫之間的間隔，避免一次性打爆429

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const writeEnabled = isYahooFundamentalsSyncWriteEnabled();
  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = hourBucketKey("cloud-yahoo-fundamentals-refresh"); // 每小時一個run_key，單次跑不完整個全球股票清單是預期行為，靠下一個小時的run接著cursor繼續
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: BATCH_SIZE, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  const stats = newRateStats();
  let cursor = before?.lastSymbol ?? null;
  let attempted = 0, succeeded = 0, factsWritten = 0, failed = 0;
  const failureReasons: Record<string, number> = {};
  let exhaustedUniverse = false;

  try {
    while (Date.now() - started < TIME_BUDGET_MS) {
      const batch = await findStaleFundamentalStocks(BATCH_SIZE, cursor);
      if (batch.length === 0) {
        if (cursor === null) break; // 真的沒有任何股票（不應該發生，universe為0）
        cursor = null; // 這一輪已經跑到清單尾端，繞回開頭，讓新的一天／新一輪重新覆蓋最舊的資料
        exhaustedUniverse = true;
        continue;
      }
      for (const stock of batch) {
        if (Date.now() - started >= TIME_BUDGET_MS) break;
        attempted++;
        const result = await syncOneStockFundamentals(stock, writeEnabled, stats);
        if (result.ok) { succeeded++; factsWritten += result.written; }
        else { failed++; failureReasons[result.failureReason ?? "UNKNOWN"] = (failureReasons[result.failureReason ?? "UNKNOWN"] ?? 0) + 1; }
        cursor = stock.ticker;
        await sleep(PACE_MS);
      }
      if (batch.length < BATCH_SIZE && !exhaustedUniverse) { cursor = null; exhaustedUniverse = true; }
    }

    const after = { lastSymbol: cursor, processed: (before?.processed ?? 0) + attempted, succeeded: (before?.succeeded ?? 0) + succeeded, failed: (before?.failed ?? 0) + failed, updatedAt: new Date().toISOString() };
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: after.lastSymbol, processed: after.processed, succeeded: after.succeeded, failed: after.failed });

    // 跟cloud-tw-fundamentals-refresh同一套規則：0筆嘗試或全部失敗都不能算COMPLETED。
    const status: "FAILED" | "PARTIAL" | "SKIPPED" | "COMPLETED" =
      attempted === 0 ? "SKIPPED"
      : failed === attempted ? "FAILED"
      : failed > 0 ? "PARTIAL"
      : "COMPLETED";
    await finishRun(runId, JOB, PROVIDER, started, {
      status, attempted, completed: succeeded, inserted: factsWritten, updated: 0, failed,
      retryableFailures: failed, checkpointAfter: after,
      error: failed ? JSON.stringify(failureReasons) : null,
      details: { writeEnabled, rateStats: stats, failureReasons, cursor: after.lastSymbol },
    });
    return Response.json({ ok: status !== "FAILED", job: JOB, writeEnabled, attempted, succeeded, factsWritten, failed, failureReasons, status, runtimeMs: Date.now() - started });
  } catch (e) {
    await finishRun(runId, JOB, PROVIDER, started, { status: "FAILED", attempted, completed: succeeded, inserted: factsWritten, updated: 0, failed: failed + 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
