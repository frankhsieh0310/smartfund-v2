// Daily "台灣買得到" classification against the official SITCA/TDCC/TWSE/TPEx lists + the US-ETF
// database-state rule (see lib/tw-purchasable/classify.ts for the full per-category rationale).
// Writes ONLY tw_purchasable_classification (APPROVED rows) -- never touches funds/etfs rows
// themselves, never removes a row. SHADOW MODE BY DEFAULT: unless TW_PURCHASABLE_CLASSIFY_WRITE is
// exactly "on" (lib/tw-purchasable/writeGate.ts), this route classifies but writes nothing.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { classifyTwPurchasable } from "@/lib/tw-purchasable/classify";
import { isTwPurchasableClassifyWriteEnabled } from "@/lib/tw-purchasable/writeGate";
import { findLiveListMismatches } from "@/lib/tw-purchasable/liveListCrossCheck";
import { classifyUsEtfNoDividend } from "@/lib/us-etf-no-dividend/classify";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const JOB = "TW_PURCHASABLE_CLASSIFY";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const started = Date.now();
  const runKey = `tw-purchasable-classify:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "SITCA_TDCC_TWSE_TPEX", runKey, universeCount: 0, batchSize: 1, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, task: "tw-purchasable-classify", skipped: true });

  const writeEnabled = isTwPurchasableClassifyWriteEnabled();
  try {
    const result = await classifyTwPurchasable(writeEnabled);
    const totalMatched = result.domesticFund.matched + result.offshoreFund.matched + result.etf.matched + result.usEtf.matched;
    // 2026-11-01（使用者核准）：額外跟交易所自己的現行上市清單唯讀比對，只記錄發現了幾檔落差、
    // 不自動變更任何分類狀態（t187ap47彙總表本身可能還沒移除已經不在現行清單上的ETF，見0060案例）。
    // 只讀查詢失敗（例如TWSE暫時連不上）不讓整支分類排程失敗，記成一個欄位讓人回頭看。
    const liveListCheck = await findLiveListMismatches((sql) => prisma.$queryRawUnsafe<Array<{ code: string; name: string; exchange: string; provider: string }>>(sql)).catch((e) => ({ error: (e as Error).message }));
    // 2026-11-01（使用者核准）：美股ETF「近12個月未配息」分類，同樣只是額外讀寫步驟（自己的
    // write gate US_ETF_NO_DIVIDEND_WRITE獨立控制），併進這支每日排程，不新增cron
    // （理由同上面liveListCheck：vercel.json剛好卡在100個cron上限）。
    const usEtfNoDividend = await classifyUsEtfNoDividend().catch((e) => ({ error: (e as Error).message }));
    // 2026-10-22（使用者核准，三.三稽核發現）: 之前不論totalMatched掉到0或write gate狀態都無條件
    // 回報COMPLETED。
    const status = writeEnabled && totalMatched === 0 ? "PARTIAL" : "COMPLETED";
    await finishRun(runId, JOB, "SITCA_TDCC_TWSE_TPEX", started, {
      status,
      attempted: result.domesticFund.officialCount + result.offshoreFund.officialCount + result.etf.officialCount + result.usEtf.candidateCount,
      completed: totalMatched,
      inserted: writeEnabled ? totalMatched : 0,
      updated: 0,
      failed: 0,
      retryableFailures: 0,
      checkpointAfter: null,
      details: { writeEnabled, result, liveListCheck, usEtfNoDividend },
    });
    return Response.json({ ok: true, task: "tw-purchasable-classify", writeEnabled, result, liveListCheck, usEtfNoDividend });
  } catch (e) {
    await finishRun(runId, JOB, "SITCA_TDCC_TWSE_TPEX", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, task: "tw-purchasable-classify", error: (e as Error).message }, { status: 500 });
  }
}
