// 2026-11-03（使用者核准）: funds.company 的回補，併進既有的 sitca-nav-sync cron，不另外新增
// cron。沿用這支cron同一次已經抓到的 fetchSitcaRows()（基金統編==funds.code，VERIFIED 95.4%）
// 結果，不再另外發一次SITCA請求。只補 company 是 NULL 或空字串的，不覆蓋既有值；taxId對不上任何
// funds.code的行直接略過，不猜。
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import type { SitcaRawRow } from "./matching";

const JOB = "FUND_COMPANY_BACKFILL";

export function isFundCompanyBackfillWriteEnabled(): boolean {
  return process.env.FUND_COMPANY_BACKFILL_WRITE?.trim() === "on";
}

export type CompanyBackfillResult = {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  candidateCount?: number;
  written?: number;
  sampleDryRun?: Array<{ code: string; name: string; company: string }>;
};

export async function runFundCompanyBackfill(rows: SitcaRawRow[]): Promise<CompanyBackfillResult> {
  const writeEnabled = isFundCompanyBackfillWriteEnabled();
  const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const runKey = `fund-company-backfill-daily-${dayKey}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV", runKey, universeCount: 0, batchSize: 2000, checkpointBefore: null,
  });
  if (skipped) return { ok: true, skipped: true, reason: "already attempted today" };

  const startedMs = Date.now();
  try {
    const companyByTaxId = new Map<string, string>();
    for (const r of rows) {
      if (r.company) companyByTaxId.set(r.taxId, r.company);
    }

    const blankFunds = await prisma.$queryRawUnsafe<{ id: string; code: string; name: string }[]>(
      `SELECT id, code, name FROM funds WHERE COALESCE(company, '') = ''`,
    );

    const candidates: Array<{ id: string; code: string; name: string; company: string }> = [];
    for (const f of blankFunds) {
      const company = companyByTaxId.get(f.code);
      if (company) candidates.push({ id: f.id, code: f.code, name: f.name, company });
    }

    let written = 0;
    if (writeEnabled) {
      for (const c of candidates) {
        await prisma.$executeRawUnsafe(
          `UPDATE funds SET company = $1 WHERE id = $2 AND COALESCE(company, '') = ''`,
          c.company, c.id,
        );
        written++;
      }
    }

    const sampleDryRun = candidates.slice(0, 10).map((c) => ({ code: c.code, name: c.name, company: c.company }));

    await finishRun(runId, JOB, "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV", startedMs, {
      status: "COMPLETED", attempted: blankFunds.length, completed: written, inserted: written, updated: 0, failed: 0,
      retryableFailures: 0, checkpointAfter: null,
      details: { write_enabled: writeEnabled, blank_count: blankFunds.length, candidate_count: candidates.length, written, sample_dry_run: sampleDryRun },
    });
    return { ok: true, skipped: false, candidateCount: candidates.length, written, sampleDryRun };
  } catch (e: any) {
    await finishRun(runId, JOB, "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV", startedMs, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      error: String(e?.message ?? e), checkpointAfter: null, details: {},
    });
    return { ok: false, skipped: false, reason: String(e?.message ?? e) };
  }
}
