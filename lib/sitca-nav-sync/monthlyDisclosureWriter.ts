import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { fetchFeeDisclosureAllCompanies, fetchAumDisclosureAllCompanies } from "./monthlyDisclosureFetch";
import { isFeeDisclosureWriteEnabled, isAumDisclosureWriteEnabled } from "./monthlyDisclosureWriteGate";

const FEE_JOB = "SITCA_FEE_DISCLOSURE_MONTHLY";
const AUM_JOB = "SITCA_AUM_DISCLOSURE_MONTHLY";

function isWithinForbiddenTaipeiWindow(now: Date): boolean {
  const taipeiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  return taipeiMinutes >= 60 && taipeiMinutes < 330; // 01:00-05:30
}

type FeeResult = { ok: boolean; skipped: boolean; reason?: string; yearMonth?: string; rowCount?: number; matchedFundCount?: number; written?: number };
type AumResult = { ok: boolean; skipped: boolean; reason?: string; yearMonth?: string; rowCount?: number; matchedFundCount?: number; written?: number };

// Both the fee-disclosure (IN2211) and AUM-disclosure (IN2201) pages publish once a month (every
// month's 10th business day, per SITCA's own stated update cadence) — so this is gated to run at most
// once per calendar month via its own run_key, independent of the daily NAV sync it's appended after.
export async function runMonthlyFeeDisclosure(): Promise<FeeResult> {
  const now = new Date();
  if (isWithinForbiddenTaipeiWindow(now)) {
    return { ok: true, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)" };
  }
  const writeEnabled = isFeeDisclosureWriteEnabled();
  const runKey = `sitca-fee-disclosure-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const { runId, skipped } = await beginRun({
    jobName: FEE_JOB, provider: "SITCA_FEE_DISCLOSURE_IN2211", runKey, universeCount: 0, batchSize: 2000, checkpointBefore: null,
  });
  if (skipped) return { ok: true, skipped: true, reason: "run_key already present this month" };

  const startedMs = Date.now();
  try {
    const { yearMonth, rows } = await fetchFeeDisclosureAllCompanies();

    const fundRows = await prisma.$queryRawUnsafe<{ id: string; code: string }[]>(
      `SELECT id, code FROM funds WHERE code IS NOT NULL
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
  const runKey = `sitca-aum-disclosure-${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const { runId, skipped } = await beginRun({
    jobName: AUM_JOB, provider: "SITCA_AUM_DISCLOSURE_IN2201", runKey, universeCount: 0, batchSize: 5000, checkpointBefore: null,
  });
  if (skipped) return { ok: true, skipped: true, reason: "run_key already present this month" };

  const startedMs = Date.now();
  try {
    const { yearMonth, rows } = await fetchAumDisclosureAllCompanies();

    const fundRows = await prisma.$queryRawUnsafe<{ id: string; code: string }[]>(
      `SELECT id, code FROM funds WHERE code IS NOT NULL
         AND id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)
         AND id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`,
    );
    // AUM disclosure is share-class-level — exact funds.code match, no base-code stripping.
    const fundIdByExactCode = new Map(fundRows.map((f) => [f.code, f.id]));

    let written = 0;
    let matchedFundCount = 0;
    if (writeEnabled) {
      for (const row of rows) {
        const fundId = fundIdByExactCode.get(row.classCode);
        if (!fundId) continue;
        matchedFundCount++;
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
        written++;
      }
    } else {
      matchedFundCount = rows.filter((r) => fundIdByExactCode.has(r.classCode)).length;
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
