// 債券反查「依發行機構」查詢的中英文名稱對照表（2026-10-24，使用者核准定案）。
// 只收錄「能確定對應」的發行機構：每一筆都已對照真實的holdings.holding_name資料（確認
// normalizeIssuer()套用後產生的issuerKey跟真實資料裡出現的一致），不是憑空造的別名。
// stockTicker（若有）則是已在stocks表核對過的美股ticker，用來額外查「持有該公司股票的
// 基金與ETF」——同一間公司，股票跟債券是兩種不同的持有標的，分開列。
// 不確定的發行機構不加在這裡，查詢找不到別名時回報「找不到對應」，不猜。
export type BondIssuerAlias = {
  aliases: string[]; // 中文/英文/簡稱，比對時全部轉大寫比較
  issuerKey: string; // normalizeIssuer()後，holdings.holding_name真實資料驗證過的鍵值
  displayNameZh: string;
  displayNameEn: string;
  stockTicker: string | null; // 已在stocks表核對過的ticker，country='US'
};

// 2026-10-24 VERIFIED against live holdings.holding_name samples:
// - "CITIGROUP INC" / "CITIGROUP" -> normalizeIssuer -> "CITIGROUP"
// - "JPMORGAN CHASE & CO" -> normalizeIssuer -> "JPMORGAN CHASE"
// stocks表: C -> Citigroup, Inc. Common Stock; JPM -> JP Morgan Chase & Co. Common Stock
export const BOND_ISSUER_ALIASES: BondIssuerAlias[] = [
  { aliases: ["花旗", "花旗集團", "CITIGROUP", "CITI"], issuerKey: "CITIGROUP", displayNameZh: "花旗集團", displayNameEn: "Citigroup", stockTicker: "C" },
  { aliases: ["摩根大通", "JPMORGAN", "JP MORGAN", "JPMORGAN CHASE", "CHASE"], issuerKey: "JPMORGAN CHASE", displayNameZh: "摩根大通", displayNameEn: "JPMorgan Chase", stockTicker: "JPM" },
];

export function resolveBondIssuerAlias(query: string): BondIssuerAlias | null {
  const normalized = query.trim().toUpperCase();
  if (!normalized) return null;
  return BOND_ISSUER_ALIASES.find((entry) => entry.aliases.some((a) => a.toUpperCase() === normalized)) ?? null;
}
