// Canonical primary-listing aliases for stock search. Many primary listings store the company name
// in its local language (e.g. 005930.KS = "삼성전자(주)"), so a name search like "Samsung" or "三星"
// can only ever match secondary/foreign listings. Each entry maps well-known search terms to the
// company's real primary listing symbol; search injects and ranks that symbol first.
// Terms are compared after NFKC + lowercase + whitespace removal. Ticker searches are unaffected.
export const PRIMARY_LISTING_ALIASES: ReadonlyArray<{ symbol: string; terms: readonly string[] }> = [
  { symbol: "005930.KS", terms: ["samsung", "samsungelectronics", "三星", "三星電子", "삼성전자"] },
  { symbol: "000660.KS", terms: ["skhynix", "hynix", "海力士", "sk海力士"] },
  { symbol: "6758.T", terms: ["sony", "sonygroup", "索尼", "ソニー"] },
  { symbol: "7203.T", terms: ["toyota", "豐田", "トヨタ"] },
  { symbol: "0700.HK", terms: ["tencent", "騰訊", "腾讯", "騰訊控股"] },
  { symbol: "9988.HK", terms: ["alibaba", "阿里巴巴", "阿里"] },
  { symbol: "ASML.AS", terms: ["asml", "asmlholding", "艾司摩爾"] },
  { symbol: "2330.TW", terms: ["台積電", "台灣積體電路", "tsmc"] },
];

const key = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/g, "");

export function primaryListingSymbolsFor(query: string): string[] {
  const term = key(query);
  if (!term) return [];
  return PRIMARY_LISTING_ALIASES.filter((entry) => entry.terms.some((alias) => key(alias) === term)).map((entry) => entry.symbol);
}
