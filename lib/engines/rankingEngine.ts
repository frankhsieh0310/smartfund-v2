// ============================================================
// lib/engines/rankingEngine.ts
// SmartMatch Ranking Engine
// 所有排行榜共用，Data Source 可替換
// ============================================================

import { ETF_LIST, type Etf } from "@/lib/data/etfData";
import { FUND_LIST, type Fund } from "@/lib/data/fundData";
import { MARKET_GROUPS, type MarketGroup } from "@/lib/data/marketData";

// ── Data Provider（未來替換為 API / DB 只需改這裡）────────────
function etfProvider(): Etf[]         { return ETF_LIST; }
function fundProvider(): Fund[]       { return FUND_LIST; }
function marketProvider(): MarketGroup[] { return MARKET_GROUPS; }

// ── 排行期間 ──────────────────────────────────────────────────
export type RankPeriod = "30d" | "90d" | "1y" | "all";

// ── ETF 排行指標 ──────────────────────────────────────────────
export type EtfRankMetric =
  | "hot"       // 熱門（依期間績效）
  | "return"    // 績效最佳
  | "yield"     // 殖利率最高
  | "lowvol";   // 低波動

// ── 基金排行指標 ──────────────────────────────────────────────
export type FundRankMetric =
  | "hot"
  | "return"
  | "yieldM"    // 月配息率
  | "yieldA"    // 年化配息率
  | "lowvol";

// ── ETF 排行 ─────────────────────────────────────────────────
export function getTopEtfs(
  metric: EtfRankMetric = "return",
  period: RankPeriod = "1y",
  topN = 10,
  source?: "fia" | "smartmatch" | "bank" | "broker"  // 預留 source 參數
): Etf[] {
  void source; // 目前未使用，未來接不同資料源
  const list = [...etfProvider()];

  if (metric === "yield")  return list.filter(e => e.dividendYield > 0).sort((a, b) => b.dividendYield - a.dividendYield).slice(0, topN);
  if (metric === "lowvol") return list.filter(e => e.volatility > 0).sort((a, b) => a.volatility - b.volatility).slice(0, topN);

  // hot / return — 依期間
  const sortKey: Record<RankPeriod, keyof Etf> = {
    "30d": "return1m",
    "90d": "return3m",
    "1y":  "return1y",
    "all": "return3y",
  };
  const key = sortKey[period];
  return list.sort((a, b) => (b[key] as number) - (a[key] as number)).slice(0, topN);
}

// ── 基金排行 ─────────────────────────────────────────────────
export function getTopFunds(
  metric: FundRankMetric = "return",
  period: RankPeriod = "1y",
  topN = 10,
  source?: "fia" | "smartmatch" | "bank" | "broker"
): Fund[] {
  void source;
  const list = [...fundProvider()];

  if (metric === "yieldM")  return list.filter(f => f.dividendYieldM > 0).sort((a, b) => b.dividendYieldM - a.dividendYieldM).slice(0, topN);
  if (metric === "yieldA")  return list.filter(f => f.dividendYieldA > 0).sort((a, b) => b.dividendYieldA - a.dividendYieldA).slice(0, topN);
  if (metric === "lowvol")  return list.filter(f => f.volatility > 0).sort((a, b) => a.volatility - b.volatility).slice(0, topN);

  const sortKey: Record<RankPeriod, keyof Fund> = {
    "30d": "return1m",
    "90d": "return3m",
    "1y":  "return1y",
    "all": "return3y",
  };
  const key = sortKey[period];
  return list.sort((a, b) => (b[key] as number) - (a[key] as number)).slice(0, topN);
}

// ── 熱門市場 ─────────────────────────────────────────────────
export function getTopMarkets(): MarketGroup[] {
  return marketProvider();
}

// ── 首頁快捷 ─────────────────────────────────────────────────
export function getHomeTopEtfs(topN = 5):  Etf[]  { return getTopEtfs("return", "1y", topN); }
export function getHomeTopFunds(topN = 5): Fund[] { return getTopFunds("return", "1y", topN); }

// ── 熱門搜尋策略（未來從 DB 讀取）───────────────────────────
export interface TrendingStrategy {
  id:    string;
  name:  string;
  tags:  string[];
  count: number;  // 搜尋次數
}

export function getTrendingStrategies(): TrendingStrategy[] {
  return [
    { id: "retirement",  name: "退休現金流",  tags: ["月配息", "殖利率>8%", "低波動"], count: 842 },
    { id: "asia-income", name: "亞洲收益",    tags: ["亞洲", "高股息", "月配息"],      count: 624 },
    { id: "tech-growth", name: "科技成長",     tags: ["科技", "近1年>20%", "全球"],    count: 518 },
    { id: "high-yield",  name: "高股息",       tags: ["高股息", "殖利率>6%"],           count: 496 },
    { id: "monthly-div", name: "月配息優選",   tags: ["月配息", "殖利率>5%"],           count: 384 },
    { id: "ai-theme",    name: "AI主題",       tags: ["科技", "AI", "近1年>30%"],      count: 312 },
  ];
}