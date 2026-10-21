// 2026-10-21（14點任務第2項，使用者核准）: M&G基金68個股份級別分屬10個不同的實際產品
// （fund_master 分組本身是對的，VERIFIED：巴黎協議全球永續 vs 巴黎協議泛歐永續等各自獨立分組，
// 從未被錯誤合併成一個產品），但網站/App的基金列表完全沒有用上這個分組——每個級別各自顯示
// 成一筆，導致同一產品重複出現好幾次（這就是盤點報告寫的「M&G基金7個級別未合併顯示」）。
// 這裡只做「列表顯示去重」：同一個 fund_master 只顯示 representative_fund_id 那一筆，
// 並附上總級別數，不去重的基金（沒有 fund_share_classes 記錄的）維持原樣顯示。
// fund_master / fund_share_classes.master_fund_id 是既有的 raw-SQL 資料表（不在 Prisma schema
// 裡，但 Phase 1 已經套用到正式環境——見 CLAUDE.md），所以這裡用 $queryRawUnsafe 直接查。
import { prisma } from "../../prisma.ts";

interface GroupingRow {
  fund_id: string;
  representative_fund_id: string;
  class_count: number;
}

interface GroupingCache {
  nonRepresentativeFundIds: Set<string>;
  shareClassCountByRepresentativeId: Map<string, number>;
  fetchedAt: number;
}

let cache: GroupingCache | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loadGrouping(): Promise<GroupingCache> {
  const rows = await prisma.$queryRawUnsafe<GroupingRow[]>(
    `SELECT fsc.fund_id, fm.representative_fund_id,
            count(*) OVER (PARTITION BY fm.id)::int AS class_count
     FROM fund_share_classes fsc
     JOIN public.fund_master fm ON fm.id = fsc.master_fund_id`,
  );
  const nonRepresentativeFundIds = new Set(rows.filter((r) => r.fund_id !== r.representative_fund_id).map((r) => r.fund_id));
  const shareClassCountByRepresentativeId = new Map<string, number>();
  for (const row of rows) {
    if (row.fund_id === row.representative_fund_id) shareClassCountByRepresentativeId.set(row.fund_id, row.class_count);
  }
  return { nonRepresentativeFundIds, shareClassCountByRepresentativeId, fetchedAt: Date.now() };
}

async function getGrouping(): Promise<GroupingCache> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;
  cache = await loadGrouping();
  return cache;
}

// 這些 fund.id 在列表上「應該被隱藏」，因為它們是某個多級別基金裡非代表級別的那一筆。
// 沒有分組記錄的基金完全不會出現在這個集合裡（維持原樣顯示，不受影響）。
export async function getNonRepresentativeShareClassFundIds(): Promise<Set<string>> {
  return (await getGrouping()).nonRepresentativeFundIds;
}

// key 是代表級別（representative_fund_id）的 fund.id；沒有分組的基金不會出現在這裡，查詢端應
// 預設視為 1（即 map.get(id) ?? 1）。
export async function getShareClassCountMap(): Promise<Map<string, number>> {
  return (await getGrouping()).shareClassCountByRepresentativeId;
}
