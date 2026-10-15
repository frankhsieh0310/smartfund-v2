// 商品反查 (item 3, ETF-direct-holding side only). VERIFIED this round: there is NO foreign key or
// shared id space linking futures_product_roots/commodity_identities to etf_holdings/holdings — a
// naive symbol join produces false positives (e.g. "RY" matches both a futures root and Royal Bank
// of Canada stock). The only TW-listed ETFs that give DIRECT commodity exposure are these 7,
// identified by their own name (TWSE/TPEx commodity-futures-ETF naming always states the tracked
// commodity and any leverage/inverse direction) — this is reading already-true facts off the
// product's own name, not inventing a mapping. Confirmed via live SELECT: exactly 7 active,
// Chinese-named ETFs match a commodity keyword in `etfs.name`, and all 7 are below.
//
// Scope explicitly NOT covered (disclosed, not built this round): indirect commodity exposure
// through equity holdings (e.g. mining/energy-company stocks inside a broader equity ETF) — that
// would require a stock-level commodity-exposure tag that doesn't exist anywhere in this schema.

export type CommodityKey = "GOLD" | "SILVER" | "WTI_CRUDE" | "BRENT_CRUDE";

export type CommodityEtfMappingEntry = {
  code: string;
  name: string;
  commodity: CommodityKey;
  direction: "LONG" | "INVERSE";
  leverage: 1 | 2;
};

export const COMMODITY_ETF_MAPPING: CommodityEtfMappingEntry[] = [
  { code: "00635U", name: "期元大S&P黃金", commodity: "GOLD", direction: "LONG", leverage: 1 },
  { code: "00674R", name: "期元大S&P黃金反1", commodity: "GOLD", direction: "INVERSE", leverage: 1 },
  { code: "00708L", name: "期元大S&P黃金正2", commodity: "GOLD", direction: "LONG", leverage: 2 },
  { code: "00738U", name: "期元大道瓊白銀", commodity: "SILVER", direction: "LONG", leverage: 1 },
  { code: "00642U", name: "期元大S&P石油", commodity: "WTI_CRUDE", direction: "LONG", leverage: 1 },
  { code: "00673R", name: "期元大S&P原油反1", commodity: "WTI_CRUDE", direction: "INVERSE", leverage: 1 },
  { code: "00715L", name: "期街口布蘭特正2", commodity: "BRENT_CRUDE", direction: "LONG", leverage: 2 },
];

export function etfsForCommodity(commodity: CommodityKey): CommodityEtfMappingEntry[] {
  return COMMODITY_ETF_MAPPING.filter((e) => e.commodity === commodity);
}

export const COMMODITY_KEYS: CommodityKey[] = ["GOLD", "SILVER", "WTI_CRUDE", "BRENT_CRUDE"];
