// 2026-11-10（模擬器實測第3項，使用者核准定案）: 選股反查畫面只曝露5組固定的熱門範本按鈕
// （SCREENER_PRESETS，跟手機端TECHNICAL_PRESETS同一份），沒有自由輸入條件的UI——實際流量幾乎
// 全部落在「5組範本 × TW/US兩個市場」這10種組合。量測發現技術選股冷啟動最差可以到60秒+，但
// 同一組條件暖機只要0.2~0.5秒，瓶頸主要是每次都即時掃全市場技術指標+基本面LATERAL join，不是
// 固定的5組範本本身真的那麼重。改成每日收盤後既有的stock-technical-daily／-us排程算完技術指標
// 後，順便把這5組範本的結果存進screener_preset_cache這張新表（不新增排程，併入既有排程最後一步，
// best-effort、失敗不影響該排程本來的主要工作）；/api/screener/technical在請求條件剛好完全匹配
// 某個範本時直接讀快取，不匹配（理論上UI不會送，但保留防呆）才照舊即時查詢。
import { prisma } from "@/lib/prisma";
import { SCREENER_PRESETS } from "@/lib/payments/plans";
import {
  parseScreenerConditions, runStockScreenerQuery, countStockScreenerMatches,
  type ScreenerCondition, type ScreenerRow,
} from "./stockScreener";

// 跟使用者畫面上能看到的免費/付費上限一致（SCREENER_PAID_MAX_HOLDINGS_PER_STOCK等不相關，這裡
// 只是快取的原始候選池上限）——比對過lib/payments/plans.ts的SCREENER_FREE_MAX_RESULTS=20，
// 付費version限制是route.ts自己的limit參數（最多50）。快取存50筆，讀取時再依免費/付費裁切，
// 跟原本即時查詢limit+1的做法語意一致（50已經遠大於免費20筆，足夠覆蓋付費端的limit<=50）。
const CACHE_ROW_LIMIT = 50;
// 排程大約每小時跑一次（stock-technical-daily是0 8-14 * * 1-5，TWT 16:00-22:00），24小時內的
// 快取都算新鮮——比「今天」這種日曆判斷寬鬆，避開時區邊界問題，過舊就直接 fallback 回即時查詢，
// 不會讓使用者看到真正的舊資料卻不知道。
const CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

function canonicalize(conditions: ScreenerCondition[]): string {
  return JSON.stringify([...conditions].sort((a, b) => `${a.field}:${a.op}`.localeCompare(`${b.field}:${b.op}`)));
}

const PRESET_SIGNATURE_BY_CANONICAL = new Map<string, string>(
  SCREENER_PRESETS.map((p) => [canonicalize(parseScreenerConditions(new URLSearchParams(p.query))), p.key]),
);

export function matchPresetKey(conditions: ScreenerCondition[]): string | null {
  return PRESET_SIGNATURE_BY_CANONICAL.get(canonicalize(conditions)) ?? null;
}

export type CachedPresetResult = { rows: ScreenerRow[]; total: number; computedAt: string };

export async function getCachedPresetResult(presetKey: string, market: "TW" | "US"): Promise<CachedPresetResult | null> {
  try {
    const result = await prisma.$queryRawUnsafe<Array<{ computed_at: Date; total: number; rows: ScreenerRow[] }>>(
      `SELECT computed_at, total, rows FROM screener_preset_cache WHERE preset_key = $1 AND market = $2`,
      presetKey, market,
    );
    const row = result[0];
    if (!row) return null;
    if (Date.now() - row.computed_at.getTime() > CACHE_FRESHNESS_MS) return null;
    return { rows: row.rows, total: row.total, computedAt: row.computed_at.toISOString() };
  } catch {
    // 快取表讀取失敗（例如還沒部署這張表、連線問題）一律視為cache miss，照舊即時查詢，絕不讓
    // 快取本身的問題擋住選股反查整支功能。
    return null;
  }
}

/** 由 stock-technical-daily / stock-technical-daily-us 排程在算完當天技術指標後呼叫，best-effort
 * ——任何一步失敗只記錄、不往外丟，絕不影響呼叫端排程本來的主要工作。 */
export async function refreshPresetCacheForMarket(market: "TW" | "US"): Promise<{ refreshed: string[]; failed: string[] }> {
  const refreshed: string[] = [];
  const failed: string[] = [];
  for (const preset of SCREENER_PRESETS) {
    try {
      const conditions = parseScreenerConditions(new URLSearchParams(preset.query));
      const [rows, total] = await Promise.all([
        runStockScreenerQuery(conditions, market, CACHE_ROW_LIMIT),
        countStockScreenerMatches(conditions, market),
      ]);
      await prisma.$executeRawUnsafe(
        `INSERT INTO screener_preset_cache (preset_key, market, computed_at, total, rows)
         VALUES ($1, $2, NOW(), $3, $4::jsonb)
         ON CONFLICT (preset_key, market) DO UPDATE SET computed_at = EXCLUDED.computed_at, total = EXCLUDED.total, rows = EXCLUDED.rows`,
        preset.key, market, total, JSON.stringify(rows),
      );
      refreshed.push(preset.key);
    } catch (e) {
      failed.push(`${preset.key}:${(e as Error).message}`);
    }
  }
  return { refreshed, failed };
}
