// 2026-10-31（使用者核准，SITCA基金統編換成帶字母字尾代碼問題）: SITCA有時會把一個基金統編
// 拆成帶字母字尾的子類型代碼（例如00968493 -> 00968493A累積型/00968493B TISA類型）。
// newFundListingDetection.ts已經會幫新字尾代碼建立新的funds列，但舊的無字尾列從此永遠比對不到
// SITCA CSV——不能用NOT_APPROVED標記（out-of-scope-purge會把它連同可能還有價值的fund_history
// 一起刪掉），改用跟 fund_duplicate_of_etf 完全同一個模式：獨立表只在「列表/搜尋顯示去重」這一層
// 讀取，不碰funds/tw_purchasable_classification任何既有欄位，不影響purge、classify本身的
// APPROVED/NOT_APPROVED判斷、reverseHoldings、持股反查、組合穿透。
import { prisma } from "../../prisma.ts";

interface SupersededRow {
  old_fund_id: string;
}

let cache: { ids: Set<string>; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function getFundIdsSupersededByNewCode(): Promise<Set<string>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.ids;
  // 這張表要等SQL先在Supabase執行過才會存在——部署時機可能早於SQL執行，查不到表就當作「還沒有
  // 任何取代紀錄」，不讓整個基金列表頁因為一張選用表還沒建好而壞掉。
  try {
    const rows = await prisma.$queryRawUnsafe<SupersededRow[]>(`SELECT old_fund_id FROM fund_superseded_by_code`);
    const ids = new Set(rows.map((r) => r.old_fund_id));
    cache = { ids, fetchedAt: Date.now() };
    return ids;
  } catch {
    return new Set();
  }
}
