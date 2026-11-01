import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { fetchTdccOffshoreScale } from "./fetch";
import { isOffshoreScaleWriteEnabled } from "./writeGate";

const JOB = "OFFSHORE_SCALE_TDCC_SYNC";

function isWithinForbiddenTaipeiWindow(now: Date): boolean {
  const taipeiMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 8 * 60) % (24 * 60);
  return taipeiMinutes >= 60 && taipeiMinutes < 330;
}

export type OffshoreScaleResult = { ok: boolean; skipped: boolean; reason?: string; rowCount?: number; matchedFundCount?: number; written?: number };

// 境外基金全球規模(TDCC opendata 3-2)，每天最多查一次(比對DB現有最新日期是否落後CSV本身的
// 基金規模日期——跟SITCA那套"check latest, only fetch if DB behind"同一慣例)。
export async function runOffshoreScaleSync(): Promise<OffshoreScaleResult> {
  const now = new Date();
  if (isWithinForbiddenTaipeiWindow(now)) {
    return { ok: true, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北01:00-05:30不執行)" };
  }
  const dayKey = now.toISOString().slice(0, 10).replace(/-/g, "");
  const runKey = `offshore-scale-tdcc-sync-daily-${dayKey}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "TDCC_OPENDATA_3-2", runKey, universeCount: 0, batchSize: 5000, checkpointBefore: null });
  if (skipped) return { ok: true, skipped: true, reason: "already attempted today" };

  const startedMs = Date.now();
  try {
    const writeEnabled = isOffshoreScaleWriteEnabled();
    const rows = await fetchTdccOffshoreScale();

    const fundRows = await prisma.$queryRawUnsafe<{ id: string; isin: string }[]>(
      `SELECT id, isin FROM funds WHERE isin IS NOT NULL
         AND id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)
         AND id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`,
    );
    // 2026-11-01（使用者核准，根因修正）：原本是 isin -> 單一fund_id 的Map，同一個ISIN對到多個
    // fund_id時後面的會覆蓋前面的——VERIFIED「新加坡大華新加坡增長基金(星幣/USGFSG)」跟它的
    // 美元級別(USGFUS)在TDCC 3-2資料裡共用同一個ISIN，覆蓋的結果是星幣那檔永遠拿不到規模資料。
    // 規模本來就是基金層級(全級別合計)的數字，同一個ISIN對到的每個fund_id都該寫入同一筆規模，
    // 改成 isin -> fund_id[] 的一對多映射。
    const fundIdsByIsin = new Map<string, string[]>();
    for (const f of fundRows) {
      const list = fundIdsByIsin.get(f.isin);
      if (list) list.push(f.id);
      else fundIdsByIsin.set(f.isin, [f.id]);
    }

    let written = 0;
    let matchedFundCount = 0;
    for (const row of rows) {
      const fundIds = fundIdsByIsin.get(row.isin);
      if (!fundIds) continue;
      for (const fundId of fundIds) {
        matchedFundCount++;
        if (writeEnabled) {
          await prisma.$executeRawUnsafe(
            `INSERT INTO fund_offshore_scale_tdcc (fund_id, scale_amount_millions, scale_currency, scale_as_of_date, source, fetched_at)
             VALUES ($1, $2, $3, $4::date, 'TDCC_OPENDATA_3-2', now())
             ON CONFLICT (fund_id) DO UPDATE SET
               scale_amount_millions = EXCLUDED.scale_amount_millions, scale_currency = EXCLUDED.scale_currency,
               scale_as_of_date = EXCLUDED.scale_as_of_date, fetched_at = now()`,
            fundId, row.scaleAmountMillions, row.scaleCurrency, row.scaleAsOfDate,
          );
          written++;
        }
      }
    }
    if (!writeEnabled) {
      matchedFundCount = rows.reduce((sum, r) => sum + (fundIdsByIsin.get(r.isin)?.length ?? 0), 0);
    }

    await finishRun(runId, JOB, "TDCC_OPENDATA_3-2", startedMs, {
      status: "COMPLETED", attempted: rows.length, completed: written, inserted: written, updated: 0, failed: 0,
      retryableFailures: 0, checkpointAfter: null,
      details: { write_enabled: writeEnabled, row_count: rows.length, matched_fund_count: matchedFundCount, written },
    });
    return { ok: true, skipped: false, rowCount: rows.length, matchedFundCount, written };
  } catch (e: any) {
    const blocked = e?.blocked === true;
    await finishRun(runId, JOB, "TDCC_OPENDATA_3-2", startedMs, {
      status: blocked ? "PARTIAL" : "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0,
      retryableFailures: 0, error: String(e?.message ?? e), checkpointAfter: null,
      details: { blocked, httpStatus: e?.httpStatus ?? null },
    });
    return { ok: false, skipped: false, reason: String(e?.message ?? e) };
  }
}
