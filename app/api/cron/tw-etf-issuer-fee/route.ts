// 2026-10-31（使用者核准，006208過期費率事故後定案）: 台股ETF經理費/保管費/收益分配一律以
// 發行投信官網商品頁為準，見 lib/tw-etf-fee-classify/issuerFeeReaders.ts 開頭說明。
//
// 這輪只VERIFIED並實作了元大(yuantaetfs.com)、富邦(websys.fsit.com.tw)兩家的讀取函式——這兩家
// 各自的官網結構差異很大(連URL host都不同)，而且請求節奏/429-403判斷必須各自獨立處理，所以沒有
// 塞進既有的 yahoo-etf-full-sweep（那支只認Yahoo單一資料源、concurrency=1 400ms節奏，混進不同
// host的台股官網請求會打亂它既有的節奏與checkpoint語意），改成比照 tw-etf-day-change 同一套
// 既有慣例（checkpoint cursor + shadow mode by default + rate-limit即停）另開一支TW專屬job——
// 跟tw-etf-day-change同屬「台股ETF專屬資料源」這個既有排程家族，不是另外發明一套新框架。
//
// SHADOW MODE BY DEFAULT: 除非 TW_ETF_FEE_ISSUER_WRITE 精確等於 "on"，只讀取、分類、記錄，不寫入。
// 01:00-05:30(台北)不執行；429/403立即停止這次invocation（不重試、不切換host硬闖）。

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import {
  readYuantaFee, readFubonFee, readCathayFee, readFhtFee, readCapitalFee, readCtbcFeeViaYahoo,
  IssuerSiteRateLimitedError, type IssuerFeeResult,
} from "@/lib/tw-etf-fee-classify/issuerFeeReaders";
import { isTwEtfFeeIssuerWriteEnabled } from "@/lib/tw-etf-fee-classify/writeGate";

export const runtime = "nodejs";
export const maxDuration = 290;
export const dynamic = "force-dynamic";

const JOB = "TW_ETF_ISSUER_FEE";
const CHECKPOINT_KEY = "tw-etf-issuer-fee:cursor";
const REQUEST_DELAY_MS = 2_500;
const TIME_BUDGET_MS = 260_000;
// 2026-11-01（使用者核正）：data_source 欄位是價格排程拿來當Yahoo ticker symbol用的，
// 絕對不能寫中文說明進去（這支cron之前的版本誤寫過，已移除）。費率來源說明改存
// expense_ratio_tier_text / expense_ratio_checked_at 這兩個新欄位（需先核准ALTER TABLE）。
// 2026-11-01（使用者核准）：中信(ctbcinvestments.com.tw)的商品頁資料需要先走一次token驗證
// 流程才能呼叫API，仍然不繞過這個認證——改用readCtbcFeeViaYahoo當備援(Yahoo欄位+TPEx費率
// 調整公告日期比對，見該函式註解)。VERIFIED Yahoo對中信發行的ETF完全沒有費率欄位(8檔樣本測試
// 全部回傳空物件)，這條備援路徑目前實際上會對每一檔回報notFound，不是"沒接上"而是"接上了，
// 來源本身沒有資料"。
const SUPPORTED_ISSUERS: Record<string, (code: string) => Promise<IssuerFeeResult>> = {
  "元大證券投資信託股份有限公司": readYuantaFee,
  "富邦證券投資信託股份有限公司": readFubonFee,
  "國泰證券投資信託股份有限公司": readCathayFee,
  "復華證券投資信託股份有限公司": readFhtFee,
  "群益證券投資信託股份有限公司": readCapitalFee,
  "中國信託證券投資信託股份有限公司": readCtbcFeeViaYahoo,
};

function isWithinForbiddenTaipeiWindow(now: Date): boolean {
  const taipeiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  return taipeiMinutes >= 60 && taipeiMinutes < 330;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  if (isWithinForbiddenTaipeiWindow(new Date())) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)" });
  }
  const writeEnabled = isTwEtfFeeIssuerWriteEnabled();

  const checkpoint = await readCheckpoint(CHECKPOINT_KEY);
  const afterId = checkpoint?.lastSymbol ?? null;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "TW_ETF_ISSUER_SITE", runKey: `${JOB}:${startedMs}`,
    universeCount: 0, batchSize: 0, checkpointBefore: checkpoint,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true });

  const providerList = Object.keys(SUPPORTED_ISSUERS);
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; provider: string }>>(
    `SELECT e.id, e.code, e.provider FROM etfs e
      JOIN tw_purchasable_classification cl ON cl.asset_id = e.id AND cl.asset_type = 'ETF'
     WHERE cl.status = 'APPROVED' AND e.exchange IN ('TWSE', 'TPEx') AND e.provider = ANY($1)
       ${afterId ? "AND e.id > $2" : ""}
     ORDER BY e.id LIMIT 60`,
    providerList, ...(afterId ? [afterId] : []),
  );

  let attempted = 0, written = 0, needsManualBlend = 0, notFound = 0, failed = 0;
  let lastId: string | null = afterId;
  let rateLimitStop = false, timeBudgetStop = false;
  const manualBlendDetails: Array<{ code: string; issuer: string; management: string; custody: string }> = [];

  for (const row of rows) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    attempted++;
    lastId = row.id;
    const reader = SUPPORTED_ISSUERS[row.provider];
    try {
      const result = await reader(row.code);
      if (result.notFound) { notFound++; continue; }
      if (result.needsManualBlend) {
        needsManualBlend++;
        manualBlendDetails.push({ code: row.code, issuer: row.provider, management: result.rawFeeText.management, custody: result.rawFeeText.custody });
      }
      if (writeEnabled) {
        // data_source 絕不寫入（它是價格排程的Yahoo ticker欄位，見本檔頂部註解）。
        if (result.totalExpenseRatioPct != null) {
          // 只有官網給的是單一數字（非級距/非區間）才寫 expense_ratio；同時清掉舊的級距文字欄位。
          await prisma.$executeRawUnsafe(
            `UPDATE etfs SET expense_ratio = $2, expense_ratio_tier_text = NULL, expense_ratio_checked_at = NOW(), updated_at = NOW() WHERE id = $1`,
            row.id, result.totalExpenseRatioPct / 100,
          );
        } else if (result.needsManualBlend) {
          // 官網是級距表/區間：expense_ratio 維持原值不動（不猜、不清空既有可能正確的數字），
          // 只照抄原文存進 expense_ratio_tier_text，供畫面顯示「本App未計算，照抄官網級距」。
          const tierText = `${row.provider}官網商品頁(資料日期:${result.fetchDate}) 經理費:${result.rawFeeText.management || "—"}｜保管費:${result.rawFeeText.custody || "—"}`;
          await prisma.$executeRawUnsafe(
            `UPDATE etfs SET expense_ratio_tier_text = $2, expense_ratio_checked_at = NOW(), updated_at = NOW() WHERE id = $1`,
            row.id, tierText,
          );
        }
        if (result.distributionFreq != null) {
          await prisma.$executeRawUnsafe(
            `UPDATE etfs SET distribution_freq = $2, distribution_checked_at = NOW() WHERE id = $1`,
            row.id, result.distributionFreq,
          );
        }
        written++;
      }
    } catch (e) {
      if (e instanceof IssuerSiteRateLimitedError) { rateLimitStop = true; break; }
      failed++;
    }
    await sleep(REQUEST_DELAY_MS);
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: rateLimitStop || timeBudgetStop || rows.length === 60 ? lastId : null,
    processed: attempted, succeeded: written, failed,
  });

  const status = rateLimitStop || timeBudgetStop ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, "TW_ETF_ISSUER_SITE", startedMs, {
    status, attempted, completed: written, inserted: 0, updated: written, failed, retryableFailures: 0,
    checkpointAfter: null,
    details: { writeEnabled, rateLimitStop, timeBudgetStop, needsManualBlend, notFound, manualBlendDetails },
  });

  return Response.json({ ok: true, job: JOB, runId, status, attempted, written, needsManualBlend, notFound, failed, writeEnabled, manualBlendDetails });
}
