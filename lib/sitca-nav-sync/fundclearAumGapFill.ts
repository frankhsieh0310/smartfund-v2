import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";

const JOB = "FUNDCLEAR_AUM_GAP_FILL";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const URL = "https://www.fundclear.com.tw/api/onshore/fund-basic/query-fund-report";
const REQUEST_DELAY_MS = 1_800;
const MAX_CODES_PER_RUN = 15;

function isWithinForbiddenTaipeiWindow(now: Date): boolean {
  const taipeiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  return taipeiMinutes >= 60 && taipeiMinutes < 330;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FundclearRateLimitedError extends Error {}

async function fetchFundReport(fundCode: string): Promise<{ aumTwd: number; subscriptionTwd: number; redemptionTwd: number; yearMonth: string } | null> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ fundCode }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403 || res.status === 429) throw new FundclearRateLimitedError();
  if (!res.ok) return null;
  const json = (await res.json()) as { basicData?: Record<string, string> };
  const b = json.basicData;
  if (!b?.fundGlobalScope || !b?.monthYM) return null;
  const scope = Number(b.fundGlobalScope);
  if (!Number.isFinite(scope)) return null;
  return {
    aumTwd: scope * 1_000_000,
    subscriptionTwd: Number(b.monthAppAmt ?? "0") * 1_000_000,
    redemptionTwd: Number(b.monthBuyAmt ?? "0") * 1_000_000,
    yearMonth: `${b.monthYM.slice(0, 4)}-${b.monthYM.slice(4, 6)}`,
  };
}

export type FundclearAumGapFillResult = { ok: boolean; skipped: boolean; reason?: string; attempted?: number; written?: number };

// 2026-10-31（使用者核准，野村鴻運規模缺口即時補）: SITCA規模報表(IN2201)這個月用「00968493」
// 無字尾基金代碼報，但funds.code已經拆成00968493A/B兩個級別，exact match對不上(月度寫入端已經
// 修好base-code fallback，但要等下個月SITCA重新公布才會觸發)。這裡用FundClear自己的
// query-fund-report(基金代碼，分不出級別)當補充來源，只補「APPROVED境內基金裡，這個月SITCA
// 完全沒有任何級別寫入規模資料」的基金，來源標成FUNDCLEAR_QUERY_FUND_REPORT，跟SITCA本身的
// fund_aum_disclosure_monthly共用同一張表(該表本來就有source欄位)。VERIFIED 00968493一檔：
// FundClear顯示21414(百萬元)跟網頁逐欄一致(申購3074/買回650/淨申贖2424，皆百萬元)。
export async function runFundclearAumGapFill(): Promise<FundclearAumGapFillResult> {
  const now = new Date();
  if (isWithinForbiddenTaipeiWindow(now)) {
    return { ok: true, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)" };
  }
  const dayKey = now.toISOString().slice(0, 10).replace(/-/g, "");
  const runKey = `fundclear-aum-gap-fill-daily-${dayKey}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "FUNDCLEAR_QUERY_FUND_REPORT", runKey, universeCount: 0, batchSize: MAX_CODES_PER_RUN, checkpointBefore: null,
  });
  if (skipped) return { ok: true, skipped: true, reason: "already attempted today" };

  const startedMs = Date.now();
  try {
    const gaps = await prisma.$queryRawUnsafe<{ base_code: string }[]>(
      `SELECT DISTINCT substring(f.code from '^[0-9]{8}') AS base_code
         FROM funds f
         JOIN tw_purchasable_classification c ON c.asset_type = 'FUND' AND c.asset_id = f.id AND c.status = 'APPROVED'
        WHERE f.code ~ '^[0-9]{8}[A-Za-z]*$'
          AND f.id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)
          AND f.id NOT IN (SELECT fund_id FROM fund_aum_disclosure_monthly)
        LIMIT ${MAX_CODES_PER_RUN}`,
    );

    let attempted = 0, written = 0;
    for (const { base_code } of gaps) {
      attempted++;
      let report;
      try {
        report = await fetchFundReport(base_code);
      } catch (e) {
        if (e instanceof FundclearRateLimitedError) break;
        continue;
      }
      await sleep(REQUEST_DELAY_MS);
      if (!report) continue;
      const siblingFunds = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT f.id FROM funds f
           JOIN tw_purchasable_classification c ON c.asset_type = 'FUND' AND c.asset_id = f.id AND c.status = 'APPROVED'
          WHERE f.code ~ ('^' || $1 || '[A-Za-z]*$')
            AND f.id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)`,
        base_code,
      );
      for (const { id } of siblingFunds) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO fund_aum_disclosure_monthly
             (fund_id, year_month, aum_twd, subscription_twd, redemption_twd, source, fetched_at)
           VALUES ($1, $2, $3, $4, $5, 'FUNDCLEAR_QUERY_FUND_REPORT', now())
           ON CONFLICT (fund_id, year_month) DO UPDATE SET
             aum_twd = EXCLUDED.aum_twd, subscription_twd = EXCLUDED.subscription_twd,
             redemption_twd = EXCLUDED.redemption_twd, source = EXCLUDED.source, fetched_at = now()`,
          id, report.yearMonth, report.aumTwd, report.subscriptionTwd, report.redemptionTwd,
        );
        written++;
      }
    }

    await finishRun(runId, JOB, "FUNDCLEAR_QUERY_FUND_REPORT", startedMs, {
      status: "COMPLETED", attempted, completed: written, inserted: written, updated: 0, failed: 0,
      retryableFailures: 0, checkpointAfter: null, details: { attempted, written },
    });
    return { ok: true, skipped: false, attempted, written };
  } catch (e: any) {
    await finishRun(runId, JOB, "FUNDCLEAR_QUERY_FUND_REPORT", startedMs, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0,
      retryableFailures: 0, error: String(e?.message ?? e), checkpointAfter: null,
    });
    return { ok: false, skipped: false, reason: String(e?.message ?? e) };
  }
}
