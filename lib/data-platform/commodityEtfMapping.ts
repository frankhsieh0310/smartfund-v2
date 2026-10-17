// 商品反查 (item 3, ETF-direct-holding side only). VERIFIED this round: there is NO foreign key or
// shared id space linking futures_product_roots/commodity_identities to etf_holdings/holdings — a
// naive symbol join produces false positives (e.g. "RY" matches both a futures root and Royal Bank
// of Canada stock). The only TW-listed ETFs that give DIRECT commodity exposure are identified by
// their own name (TWSE/TPEx commodity-futures-ETF naming always states the tracked commodity and
// any leverage/inverse direction) — this is reading already-true facts off the product's own name,
// not inventing a mapping.
//
// 2026-10-17 (item 1, part of the commodity-side technical screener): re-ran the same live-SELECT
// verification against `etfs.name` for every other commodity now covered by
// futures_technical_analytics (lib/cron/commodityTechnicalUpdate.ts) -- platinum/palladium/corn/
// wheat/soybean oil/soybean meal/coffee/cocoa/sugar/cotton/cattle/hogs/natgas/heating oil/
// gasoline/rice/orange juice all came back with ZERO matching TW-listed ETFs (genuinely don't
// exist, not a search-term miss -- tried both the commodity name and common alternate Chinese
// terms). Only two more were found and added below: Copper (00763U) and Soybeans (00693U). The
// other 15 commodities remain screenable by technical condition (see the commodity-screener API)
// but honestly report "no TW-listed direct ETF" rather than being force-fit into this mapping.
//
// Scope explicitly NOT covered (disclosed, not built this round): indirect commodity exposure
// through equity holdings (e.g. mining/energy-company stocks inside a broader equity ETF) — that
// would require a stock-level commodity-exposure tag that doesn't exist anywhere in this schema
// (VERIFIED 2026-10-17: stocks.sector/industry is NULL even for famous gold miners like Newmont/
// Barrick, holdings.sector is a bond-only taxonomy, and industry_chain_nodes is a Taiwan tech-
// manufacturing supply-chain taxonomy unrelated to global commodity-linked equities).

export type CommodityKey = "GOLD" | "SILVER" | "WTI_CRUDE" | "BRENT_CRUDE" | "COPPER" | "SOYBEANS";

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
  { code: "00763U", name: "期街口道瓊銅", commodity: "COPPER", direction: "LONG", leverage: 1 },
  { code: "00693U", name: "期街口S&P黃豆", commodity: "SOYBEANS", direction: "LONG", leverage: 1 },
];

export function etfsForCommodity(commodity: CommodityKey): CommodityEtfMappingEntry[] {
  return COMMODITY_ETF_MAPPING.filter((e) => e.commodity === commodity);
}

export const COMMODITY_KEYS: CommodityKey[] = ["GOLD", "SILVER", "WTI_CRUDE", "BRENT_CRUDE", "COPPER", "SOYBEANS"];

// 間接曝險（追加這輪）：國內可買、以黃金/能源/原物料為主題的基金（非直接持有商品期貨，而是投資
// 該產業股票/債券的主題型基金）。VERIFIED via a live SELECT this round: 5 active, TW-coded funds
// match a commodity/energy keyword in `funds.name`. 複委託可買的海外商品ETF（如SPDR Gold Shares等）
// 不在我們資料庫裡（沒有「複委託可交易」這個旗標或清單），這部分誠實標示做不到，不是忘記做。
export type ThematicFundEntry = { code: string; name: string; theme: "GOLD" | "ENERGY" | "BROAD_COMMODITY" };

export const THEMATIC_COMMODITY_FUNDS: ThematicFundEntry[] = [
  { code: "88251656", name: "富蘭克林華美全球潔淨能源ETF基金", theme: "ENERGY" },
  { code: "73688977", name: "復華15年期以上能源業債券ETF基金", theme: "ENERGY" },
  { code: "25676249", name: "復華全球原物料基金", theme: "BROAD_COMMODITY" },
  { code: "99632577", name: "德銀遠東DWS全球原物料能源基金", theme: "BROAD_COMMODITY" },
  { code: "26318517", name: "統一新亞洲科技能源基金", theme: "ENERGY" },
];
