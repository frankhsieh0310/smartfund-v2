// 2026-10-19（使用者商品範圍規則，最高層）: 網站與 App 只能顯示/排程更新「台灣買得到」的
// 四類商品——tw_purchasable_classification 裡 status='APPROVED' 的 ETF（現行掛牌台股 + 美股）跟
// FUND（SITCA 國內基金 + TDCC 3-2 境內核備境外基金）。這裡是唯一的共用判斷依據，不要在個別
// 查詢裡各自重寫這段 SQL/filter，以免以後定義跑掉。
//
// 例外（使用者明確規則）：組合穿透功能顯示「一檔核心商品本身持有的成分股/成分 ETF」時，不套用
// 這個過濾——過濾只套用在「使用者挑選商品」這一層，不套用在「商品本身揭露的持股內容」。
export const CORE_UNIVERSE_ETF_SQL_FILTER = `id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'ETF' AND status = 'APPROVED')`;
export const CORE_UNIVERSE_FUND_SQL_FILTER = `id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`;

import { prisma } from "@/lib/prisma";

let etfIdCache: { ids: Set<string>; fetchedAt: number } | null = null;
let fundIdCache: { ids: Set<string>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分鐘快取，避免每個請求都重查整張分類表

export async function getCoreUniverseEtfIds(): Promise<Set<string>> {
  if (etfIdCache && Date.now() - etfIdCache.fetchedAt < CACHE_TTL_MS) return etfIdCache.ids;
  const rows = await prisma.$queryRawUnsafe<{ asset_id: string }[]>(
    `SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'ETF' AND status = 'APPROVED'`,
  );
  const ids = new Set(rows.map((r) => r.asset_id));
  etfIdCache = { ids, fetchedAt: Date.now() };
  return ids;
}

export async function getCoreUniverseFundIds(): Promise<Set<string>> {
  if (fundIdCache && Date.now() - fundIdCache.fetchedAt < CACHE_TTL_MS) return fundIdCache.ids;
  const rows = await prisma.$queryRawUnsafe<{ asset_id: string }[]>(
    `SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED'`,
  );
  const ids = new Set(rows.map((r) => r.asset_id));
  fundIdCache = { ids, fetchedAt: Date.now() };
  return ids;
}
