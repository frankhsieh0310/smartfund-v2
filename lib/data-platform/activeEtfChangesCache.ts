// 2026-11-13 使用者回報核實（主動式ETF追蹤頁第一次載入約15秒，目標3秒內）: 原本每次請求都對
// 每一檔「主動」ETF各自呼叫getTwoLatestSnapshots（holdingsHistory.ts的多CTE查詢），ETF檔數一多
// 就慢，之前只加了App端/HTTP層的短效快取，沒有解決「第一次／快取過期後」那一次的根本速度問題。
// 跟screener_preset_cache／reverseLookupCache同一套做法：整個「全部主動ETF」清單只當一筆快取，
// 由既有排程（跟reverseLookupCache同一支stock-yahoo-hk-profile）best-effort附加重算，App端
// 永遠讀快取，快取缺失/過期才退回即時計算，不讓快取本身的問題擋住這個功能。
//
// 需要使用者先手動執行一次schema變更（這支模組本身不會、也不該自己對production跑DDL）：
//   CREATE TABLE IF NOT EXISTS active_etf_daily_changes_cache (
//     id INT PRIMARY KEY DEFAULT 1,
//     computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
//     result JSONB NOT NULL
//   );
import { prisma } from "@/lib/prisma";
import { getTwoLatestSnapshots, coverageDepthOf } from "@/lib/data-platform/holdingsHistory";

const CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export async function computeActiveEtfDailyChanges(codeFilter: string | null) {
  const etfs = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; name: string }>>(
    `SELECT id, code, name FROM etfs WHERE name LIKE '主動%' AND is_active
       AND id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='ETF' AND status='APPROVED')
       ${codeFilter ? "AND code = $1" : ""}
     ORDER BY code`,
    ...(codeFilter ? [codeFilter] : []),
  );

  const results = await Promise.all(
    etfs.map(async (etf) => {
      const diff = await getTwoLatestSnapshots("ETF", etf.id);
      if (!diff.previous) {
        return { id: etf.id, code: etf.code, name: etf.name, hasEnoughHistory: false as const, latestDate: diff.latest || null };
      }
      const prevMap = new Map(diff.previousRows.map((r) => [r.key, r]));
      const latestMap = new Map(diff.latestRows.map((r) => [r.key, r]));
      const allKeys = new Set([...prevMap.keys(), ...latestMap.keys()]);
      const added: Array<{ name: string; ticker: string | null; weightPct: number }> = [];
      const removed: Array<{ name: string; ticker: string | null; weightPct: number }> = [];
      const increased: Array<{ name: string; ticker: string | null; deltaPct: number }> = [];
      const decreased: Array<{ name: string; ticker: string | null; deltaPct: number }> = [];
      for (const key of allKeys) {
        const prev = prevMap.get(key);
        const cur = latestMap.get(key);
        if (!prev && cur) added.push({ name: cur.name, ticker: cur.ticker, weightPct: cur.weightPct });
        else if (prev && !cur) removed.push({ name: prev.name, ticker: prev.ticker, weightPct: prev.weightPct });
        else if (prev && cur) {
          const delta = cur.weightPct - prev.weightPct;
          if (delta > 0.001) increased.push({ name: cur.name, ticker: cur.ticker, deltaPct: delta });
          else if (delta < -0.001) decreased.push({ name: cur.name, ticker: cur.ticker, deltaPct: delta });
        }
      }
      added.sort((a, b) => b.weightPct - a.weightPct);
      removed.sort((a, b) => b.weightPct - a.weightPct);
      increased.sort((a, b) => b.deltaPct - a.deltaPct);
      decreased.sort((a, b) => a.deltaPct - b.deltaPct);
      const latestDepth = coverageDepthOf(diff.latestSource);
      const prevDepth = coverageDepthOf(diff.previousSource);
      return {
        id: etf.id, code: etf.code, name: etf.name, hasEnoughHistory: true as const,
        previousDate: diff.previous, latestDate: diff.latest,
        comparabilityLevel: latestDepth === "FULL" && prevDepth === "FULL" ? "FULL_VS_FULL" as const : "CONSERVATIVE" as const,
        warning: latestDepth === "FULL" && prevDepth === "FULL" ? null : "其中一期不是完整持股，異動比較僅供參考",
        counts: { added: added.length, increased: increased.length, decreased: decreased.length, removed: removed.length },
        added: added.slice(0, 10), removed: removed.slice(0, 10), increased: increased.slice(0, 10), decreased: decreased.slice(0, 10),
      };
    }),
  );

  return { ok: true, count: results.length, results, basisNote: "本程式計算：依既有每日官方持股快照比對前後兩個交易日的持股異動。" };
}

export async function getCachedActiveEtfDailyChanges(): Promise<unknown | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ computed_at: Date; result: unknown }>>(
      `SELECT computed_at, result FROM active_etf_daily_changes_cache WHERE id = 1`,
    );
    const row = rows[0];
    if (!row) return null;
    if (Date.now() - row.computed_at.getTime() > CACHE_FRESHNESS_MS) return null;
    return row.result;
  } catch {
    // 快取表讀取失敗（例如還沒部署這張表）一律視為cache miss，照舊即時查詢，絕不讓快取本身的
    // 問題擋住這個功能。
    return null;
  }
}

/** 由既有排程（跟reverseLookupCache同一套best-effort附加步驟）呼叫，整批重算並覆蓋唯一一筆
 * 快取列。任何錯誤只記錄、不往外丟，絕不影響呼叫端排程本來的主要工作。 */
export async function refreshActiveEtfDailyChangesCache(): Promise<{ ok: boolean; count?: number; error?: string }> {
  try {
    const computed = await computeActiveEtfDailyChanges(null);
    await prisma.$executeRawUnsafe(
      `INSERT INTO active_etf_daily_changes_cache (id, computed_at, result)
       VALUES (1, now(), $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET computed_at = now(), result = EXCLUDED.result`,
      JSON.stringify(computed),
    );
    return { ok: true, count: computed.count };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
