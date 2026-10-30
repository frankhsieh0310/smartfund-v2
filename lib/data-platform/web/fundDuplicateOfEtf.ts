// 2026-10-30（使用者核准，funds表10檔掛牌ETF重複紀錄）: 原本打算改
// tw_purchasable_classification.status，使用者要求先檢查全專案讀取這個欄位的地方，VERIFIED
// 兩個會出問題：(1) app/api/cron/out-of-scope-purge/route.ts 把「不是APPROVED」的fund直接當
// 「範圍外」刪掉（連funds本體都刪）——改status會讓這10筆下一次排程就被整個刪除，跟使用者「只
// 標記、不刪除」的要求正相反。(2) lib/tw-purchasable/classify.ts 的 upsertApproved() 每天重新
// 分類時，只要fund.code還在SITCA官方清單裡就會把status無條件蓋回'APPROVED'（這10檔本來就是
// 真的、合法的SITCA境內基金，一定會重新命中），下一次排程就把標記蓋掉。
//
// 改用一張全新的獨立表 fund_duplicate_of_etf，不碰 funds/tw_purchasable_classification 任何
// 既有欄位或表——跟 fund_master/fund_share_classes（lib/data-platform/web/
// fundShareClassGrouping.ts）同一個模式：只在「列表/搜尋顯示去重」這一層讀取，不影響purge、
// classify、reverseHoldings、持股反查、組合穿透，也不影響funds本體任何查詢。
import { prisma } from "../../prisma.ts";

interface DuplicateRow {
  fund_id: string;
}

let cache: { ids: Set<string>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getFundIdsDuplicateOfListedEtf(): Promise<Set<string>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.ids;
  // 這張表要等使用者在Supabase執行過migration SQL才會存在——部署時機可能早於使用者執行SQL，
  // 查不到表就當作「還沒有任何重複紀錄」，不讓整個基金列表頁因為一張選用表還沒建好而壞掉。
  try {
    const rows = await prisma.$queryRawUnsafe<DuplicateRow[]>(`SELECT fund_id FROM fund_duplicate_of_etf`);
    const ids = new Set(rows.map((r) => r.fund_id));
    cache = { ids, fetchedAt: Date.now() };
    return ids;
  } catch {
    return new Set();
  }
}
