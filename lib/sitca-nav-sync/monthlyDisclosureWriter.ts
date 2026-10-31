import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { fetchFeeDisclosureAllCompanies, fetchAumDisclosureAllCompanies, peekFeeLatestYearMonth, peekAumLatestYearMonth } from "./monthlyDisclosureFetch";
import { isFeeDisclosureWriteEnabled, isAumDisclosureWriteEnabled } from "./monthlyDisclosureWriteGate";

const FEE_JOB = "SITCA_FEE_DISCLOSURE_MONTHLY";
const AUM_JOB = "SITCA_AUM_DISCLOSURE_MONTHLY";

function isWithinForbiddenTaipeiWindow(now: Date): boolean {
  const taipeiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  return taipeiMinutes >= 60 && taipeiMinutes < 330; // 01:00-05:30
}

type FeeResult = { ok: boolean; skipped: boolean; reason?: string; yearMonth?: string; rowCount?: number; matchedFundCount?: number; written?: number };
type AumResult = { ok: boolean; skipped: boolean; reason?: string; yearMonth?: string; rowCount?: number; matchedFundCount?: number; written?: number };

// 2026-10-31（使用者核准，修正觸發條件）: 原本「每月第一次執行」的run_key邏輯在月初第一次跑完
// 之後，整個月都不會再檢查——如果那一次SITCA還沒公布當月資料，就要等到下個月才會再試。改成
// 「資料庫裡還沒有SITCA目前公布的最新月份，就抓」：每次用一次廉價的GET（peekXxxLatestYearMonth，
// 不做完整POST抓全市場表）取得SITCA目前預設選中的最新年月，跟DB現有的MAX(year_month)比較，
// 只有在DB落後時才真正付出完整POST的成本去抓、寫入。run_key改成每天一個，確保同一天不會重複
// 嘗試（即使DB已經是最新，也不用每小時都去GET一次SITCA）。
export async function runMonthlyFeeDisclosure(): Promise<FeeResult> {
  const now = new Date();
  if (isWithinForbiddenTaipeiWindow(now)) {
    return { ok: true, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)" };
  }
  const writeEnabled = isFeeDisclosureWriteEnabled();
  const dayKey = now.toISOString().slice(0, 10).replace(/-/g, "");
  const runKey = `sitca-fee-disclosure-daily-${dayKey}`;
  const { runId, skipped } = await beginRun({
    jobName: FEE_JOB, provider: "SITCA_FEE_DISCLOSURE_IN2211", runKey, universeCount: 0, batchSize: 2000, checkpointBefore: null,
  });
  if (skipped) return { ok: true, skipped: true, reason: "already attempted today" };

  const startedMs = Date.now();
  try {
    const latestYearMonth = await peekFeeLatestYearMonth();
    const dbLatest = await prisma.$queryRawUnsafe<{ max: string | null }[]>(
      `SELECT max(year_month) AS max FROM fund_fee_disclosure_monthly`,
    );
    if (dbLatest[0]?.max && dbLatest[0].max >= latestYearMonth) {
      await finishRun(runId, FEE_JOB, "SITCA_FEE_DISCLOSURE_IN2211", startedMs, {
        status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0,
        retryableFailures: 0, checkpointAfter: null,
        details: { write_enabled: writeEnabled, skipped_reason: "DB_ALREADY_HAS_LATEST_MONTH", db_latest: dbLatest[0].max, source_latest: latestYearMonth },
      });
      return { ok: true, skipped: true, reason: `DB已有最新月份 ${dbLatest[0].max}`, yearMonth: dbLatest[0].max };
    }
    const { yearMonth, rows } = await fetchFeeDisclosureAllCompanies();

    const fundRows = await prisma.$queryRawUnsafe<{ id: string; code: string }[]>(
      `SELECT id, code FROM funds WHERE code ~ '^[0-9]{8}[A-Za-z]*$'
         AND id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)
         AND id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`,
    );
    // Fee disclosure is fund-level (shared by every share class of the same base code).
    const fundIdsByBaseCode = new Map<string, string[]>();
    for (const f of fundRows) {
      const base = f.code.replace(/[A-Za-z]+$/, "");
      if (!fundIdsByBaseCode.has(base)) fundIdsByBaseCode.set(base, []);
      fundIdsByBaseCode.get(base)!.push(f.id);
    }

    let written = 0;
    let matchedFundCount = 0;
    if (writeEnabled) {
      for (const row of rows) {
        const fundIds = fundIdsByBaseCode.get(row.baseFundCode);
        if (!fundIds || fundIds.length === 0) continue;
        matchedFundCount++;
        for (const fundId of fundIds) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO fund_fee_disclosure_monthly
               (fund_id, year_month, mgmt_fee_amount, mgmt_fee_pct, custodian_fee_amount, custodian_fee_pct,
                other_fee_amount, other_fee_pct, total_fee_amount, total_fee_pct, source, fetched_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SITCA_IN2211', now())
             ON CONFLICT (fund_id, year_month) DO UPDATE SET
               mgmt_fee_amount = EXCLUDED.mgmt_fee_amount, mgmt_fee_pct = EXCLUDED.mgmt_fee_pct,
               custodian_fee_amount = EXCLUDED.custodian_fee_amount, custodian_fee_pct = EXCLUDED.custodian_fee_pct,
               other_fee_amount = EXCLUDED.other_fee_amount, other_fee_pct = EXCLUDED.other_fee_pct,
               total_fee_amount = EXCLUDED.total_fee_amount, total_fee_pct = EXCLUDED.total_fee_pct,
               fetched_at = now()`,
            fundId, yearMonth, row.mgmtFeeAmount, row.mgmtFeePct, row.custodianFeeAmount, row.custodianFeePct,
            row.otherFeeAmount, row.otherFeePct, row.totalFeeAmount, row.totalFeePct,
          );
          written++;
        }
      }
    } else {
      matchedFundCount = rows.filter((r) => fundIdsByBaseCode.has(r.baseFundCode)).length;
    }

    await finishRun(runId, FEE_JOB, "SITCA_FEE_DISCLOSURE_IN2211", startedMs, {
      status: "COMPLETED", attempted: rows.length, completed: written, inserted: written, updated: 0, failed: 0,
      retryableFailures: 0, checkpointAfter: null,
      details: { write_enabled: writeEnabled, year_month: yearMonth, row_count: rows.length, matched_fund_count: matchedFundCount, written },
    });
    return { ok: true, skipped: false, yearMonth, rowCount: rows.length, matchedFundCount, written };
  } catch (e: any) {
    const blocked = e?.blocked === true;
    await finishRun(runId, FEE_JOB, "SITCA_FEE_DISCLOSURE_IN2211", startedMs, {
      status: blocked ? "PARTIAL" : "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0,
      retryableFailures: 0, error: String(e?.message ?? e), checkpointAfter: null,
      details: { blocked, httpStatus: e?.httpStatus ?? null },
    });
    return { ok: false, skipped: false, reason: String(e?.message ?? e) };
  }
}

export async function runMonthlyAumDisclosure(): Promise<AumResult> {
  const now = new Date();
  if (isWithinForbiddenTaipeiWindow(now)) {
    return { ok: true, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)" };
  }
  const writeEnabled = isAumDisclosureWriteEnabled();
  const dayKey = now.toISOString().slice(0, 10).replace(/-/g, "");
  const runKey = `sitca-aum-disclosure-daily-${dayKey}`;
  const { runId, skipped } = await beginRun({
    jobName: AUM_JOB, provider: "SITCA_AUM_DISCLOSURE_IN2201", runKey, universeCount: 0, batchSize: 5000, checkpointBefore: null,
  });
  if (skipped) return { ok: true, skipped: true, reason: "already attempted today" };

  const startedMs = Date.now();
  try {
    const latestYearMonth = await peekAumLatestYearMonth();
    const dbLatest = await prisma.$queryRawUnsafe<{ max: string | null }[]>(
      `SELECT max(year_month) AS max FROM fund_aum_disclosure_monthly`,
    );
    if (dbLatest[0]?.max && dbLatest[0].max >= latestYearMonth) {
      await finishRun(runId, AUM_JOB, "SITCA_AUM_DISCLOSURE_IN2201", startedMs, {
        status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0,
        retryableFailures: 0, checkpointAfter: null,
        details: { write_enabled: writeEnabled, skipped_reason: "DB_ALREADY_HAS_LATEST_MONTH", db_latest: dbLatest[0].max, source_latest: latestYearMonth },
      });
      return { ok: true, skipped: true, reason: `DB已有最新月份 ${dbLatest[0].max}`, yearMonth: dbLatest[0].max };
    }
    const { yearMonth, rows } = await fetchAumDisclosureAllCompanies();

    const fundRows = await prisma.$queryRawUnsafe<{ id: string; code: string }[]>(
      `SELECT id, code FROM funds WHERE code ~ '^[0-9]{8}[A-Za-z]*$'
         AND id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)
         AND id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`,
    );
    // AUM disclosure is normally share-class-level — exact funds.code match. But some older funds
    // (VERIFIED 2026-10-31, 野村鴻運基金/00968493) are reported by SITCA under the bare base code
    // with NO letter suffix at all even though funds.code already split them into 00968493A/B share
    // classes — an exact match against those share-class codes then silently finds nothing, even
    // though the fund's AUM genuinely was published this month. Fallback: when a row's own classCode
    // is a bare 8-digit base code (no letter) and has no exact match, write it to every APPROVED
    // sibling share class of that base code that didn't already get an exact-matched row this run
    // (mirrors how fee disclosure already treats itself as fund-level, shared across share classes).
    const fundIdByExactCode = new Map(fundRows.map((f) => [f.code, f.id]));
    const fundIdsByBaseCode = new Map<string, string[]>();
    for (const f of fundRows) {
      const base = f.code.replace(/[A-Za-z]+$/, "");
      if (!fundIdsByBaseCode.has(base)) fundIdsByBaseCode.set(base, []);
      fundIdsByBaseCode.get(base)!.push(f.id);
    }

    let written = 0;
    let matchedFundCount = 0;
    const exactMatchedFundIdsThisRun = new Set<string>();
    for (const row of rows) {
      if (fundIdByExactCode.has(row.classCode)) exactMatchedFundIdsThisRun.add(fundIdByExactCode.get(row.classCode)!);
    }
    async function writeAumRow(fundId: string, row: typeof rows[number]) {
      if (!writeEnabled) return;
      await prisma.$executeRawUnsafe(
        `INSERT INTO fund_aum_disclosure_monthly
           (fund_id, year_month, aum_twd, nav_twd, units_outstanding, natural_person_holders,
            institutional_holders, total_holders, subscription_twd, redemption_twd, source, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SITCA_IN2201', now())
         ON CONFLICT (fund_id, year_month) DO UPDATE SET
           aum_twd = EXCLUDED.aum_twd, nav_twd = EXCLUDED.nav_twd, units_outstanding = EXCLUDED.units_outstanding,
           natural_person_holders = EXCLUDED.natural_person_holders, institutional_holders = EXCLUDED.institutional_holders,
           total_holders = EXCLUDED.total_holders, subscription_twd = EXCLUDED.subscription_twd,
           redemption_twd = EXCLUDED.redemption_twd, fetched_at = now()`,
        fundId, yearMonth, row.aumTwd, row.navTwd, row.unitsOutstanding, row.naturalPersonHolders,
        row.institutionalHolders, row.totalHolders, row.subscriptionTwd, row.redemptionTwd,
      );
    }
    for (const row of rows) {
      const exactFundId = fundIdByExactCode.get(row.classCode);
      if (exactFundId) {
        matchedFundCount++;
        await writeAumRow(exactFundId, row);
        if (writeEnabled) written++;
        continue;
      }
      if (/^[0-9]{8}$/.test(row.classCode)) {
        const siblings = (fundIdsByBaseCode.get(row.classCode) ?? []).filter((id) => !exactMatchedFundIdsThisRun.has(id));
        if (siblings.length === 0) continue;
        matchedFundCount++;
        for (const siblingId of siblings) {
          await writeAumRow(siblingId, row);
          if (writeEnabled) written++;
        }
      }
    }

    await finishRun(runId, AUM_JOB, "SITCA_AUM_DISCLOSURE_IN2201", startedMs, {
      status: "COMPLETED", attempted: rows.length, completed: written, inserted: written, updated: 0, failed: 0,
      retryableFailures: 0, checkpointAfter: null,
      details: { write_enabled: writeEnabled, year_month: yearMonth, row_count: rows.length, matched_fund_count: matchedFundCount, written },
    });
    return { ok: true, skipped: false, yearMonth, rowCount: rows.length, matchedFundCount, written };
  } catch (e: any) {
    const blocked = e?.blocked === true;
    await finishRun(runId, AUM_JOB, "SITCA_AUM_DISCLOSURE_IN2201", startedMs, {
      status: blocked ? "PARTIAL" : "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0,
      retryableFailures: 0, error: String(e?.message ?? e), checkpointAfter: null,
      details: { blocked, httpStatus: e?.httpStatus ?? null },
    });
    return { ok: false, skipped: false, reason: String(e?.message ?? e) };
  }
}
