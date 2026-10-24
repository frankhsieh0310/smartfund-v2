// 債券反查「用國家」查詢的國家名稱對照表（2026-10-25，使用者核准定案）。只收錄「能確定對應」
// 的國家：每一筆都已對照fund_source_allocation_observations(domain='REGION_ALLOCATION')真實
// 出現過的raw_category字串，只取「精確等於該國家」的寫法，不包含「不含日本」「除外」這種排除式
// 寫法、也不包含像「美國公債」「日本股市」這種可能混了資產類別的子分類——避免誤把「排除該國」
// 或「該國某個資產子類」的列當成「該國整體配置比例」。不確定的國家/寫法不加，查不到就回報
// 找不到對應，不猜。
export type CountryAlias = {
  aliases: string[];
  displayNameZh: string;
  rawCategories: string[]; // fund_source_allocation_observations.raw_category 精確比對用（IN清單）
};

export const COUNTRY_ALLOCATION_ALIASES: CountryAlias[] = [
  { aliases: ["美國", "US", "USA", "UNITED STATES"], displayNameZh: "美國", rawCategories: ["美國"] },
  { aliases: ["日本", "JAPAN"], displayNameZh: "日本", rawCategories: ["日本"] },
  // 台灣基金揭露有時用「台灣」有時用官方全名「中華民國」——VERIFIED兩者都在真實資料裡精確
  // 出現過，同一檔基金只會用其中一種寫法揭露，不是兩個不同國家，收進同一個國家查詢。
  { aliases: ["台灣", "TAIWAN", "中華民國"], displayNameZh: "台灣", rawCategories: ["台灣", "中華民國"] },
];

export function resolveCountryAlias(query: string): CountryAlias | null {
  const normalized = query.trim().toUpperCase();
  if (!normalized) return null;
  return COUNTRY_ALLOCATION_ALIASES.find((entry) => entry.aliases.some((a) => a.toUpperCase() === normalized)) ?? null;
}
