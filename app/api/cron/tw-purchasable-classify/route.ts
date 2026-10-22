// Daily "台灣買得到" classification against the official SITCA/TDCC/TWSE/TPEx lists + the US-ETF
// database-state rule (see lib/tw-purchasable/classify.ts for the full per-category rationale).
// Writes ONLY tw_purchasable_classification (APPROVED rows) -- never touches funds/etfs rows
// themselves, never removes a row. SHADOW MODE BY DEFAULT: unless TW_PURCHASABLE_CLASSIFY_WRITE is
// exactly "on" (lib/tw-purchasable/writeGate.ts), this route classifies but writes nothing.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { classifyTwPurchasable } from "@/lib/tw-purchasable/classify";
import { isTwPurchasableClassifyWriteEnabled } from "@/lib/tw-purchasable/writeGate";

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
      details: { writeEnabled, result },
    });
    return Response.json({ ok: true, task: "tw-purchasable-classify", writeEnabled, result });
  } catch (e) {
    await finishRun(runId, JOB, "SITCA_TDCC_TWSE_TPEX", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, task: "tw-purchasable-classify", error: (e as Error).message }, { status: 500 });
  }
}
