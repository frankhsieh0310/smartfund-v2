// ============================================================
// lib/services/rankingService.ts
// SmartMatch Ranking Engine
//
// 架構設計：可替換 Data Provider
// 目前使用本地靜態資料（lib/data/）
// 未來只需替換 getEtfDataProvider() / getFundDataProvider()
// 所有頁面無需修改
// ============================================================

import { ETF_LIST, type Etf } from "@/lib/data/etfData";
import { FUND_LIST, type Fund } from "@/lib/data/fundData";

// ── Data Provider 介面（未來可替換為 API / DB）────────────────
function getEtfDataProvider(): Etf[] {
  return ETF_LIST;
}

function getFundDataProvider(): Fund[] {
  return FUND_LIST;
}

// ── ETF 排行類型 ──────────────────────────────────────────────
export type EtfRankType =
  | "hot30"      // 近30日熱門（以 return1m 排序）
  | "hot90"      // 近3個月熱門（以 return3m 排序）
  | "best1y"     // 近1年績效最佳
  | "yield"      // 殖利率最高
  | "lowvol";    // 低波動（以 volatility 升序）

// ── 基金排行類型 ──────────────────────────────────────────────
export type FundRankType =
  | "hot30"      // 近30日熱門
  | "hot90"      // 近3個月熱門
  | "best1y"     // 近1年績效最佳
  | "yieldM"     // 月配息率最高
  | "yieldA"     // 年化配息率最高
  | "lowvol";    // 低波動

// ── ETF 排行 ─────────────────────────────────────────────────
export function getTopEtfs(type: EtfRankType, topN = 10): Etf[] {
  const list = [...getEtfDataProvider()];

  switch (type) {
    case "hot30":
      return list.sort((a, b) => b.return1m - a.return1m).slice(0, topN);
    case "hot90":
      return list.sort((a, b) => b.return3m - a.return3m).slice(0, topN);
    case "best1y":
      return list.sort((a, b) => b.return1y - a.return1y).slice(0, topN);
    case "yield":
      return list
        .filter(e => e.dividendYield > 0)
        .sort((a, b) => b.dividendYield - a.dividendYield)
        .slice(0, topN);
    case "lowvol":
      return list
        .filter(e => e.volatility > 0)
        .sort((a, b) => a.volatility - b.volatility)
        .slice(0, topN);
    default:
      return list.sort((a, b) => b.return1y - a.return1y).slice(0, topN);
  }
}

// ── 基金排行 ─────────────────────────────────────────────────
export function getTopFunds(type: FundRankType, topN = 10): Fund[] {
  const list = [...getFundDataProvider()];

  switch (type) {
    case "hot30":
      return list.sort((a, b) => b.return1m - a.return1m).slice(0, topN);
    case "hot90":
      return list.sort((a, b) => b.return3m - a.return3m).slice(0, topN);
    case "best1y":
      return list.sort((a, b) => b.return1y - a.return1y).slice(0, topN);
    case "yieldM":
      return list
        .filter(f => f.dividendYieldM > 0)
        .sort((a, b) => b.dividendYieldM - a.dividendYieldM)
        .slice(0, topN);
    case "yieldA":
      return list
        .filter(f => f.dividendYieldA > 0)
        .sort((a, b) => b.dividendYieldA - a.dividendYieldA)
        .slice(0, topN);
    case "lowvol":
      return list
        .filter(f => f.volatility > 0)
        .sort((a, b) => a.volatility - b.volatility)
        .slice(0, topN);
    default:
      return list.sort((a, b) => b.return1y - a.return1y).slice(0, topN);
  }
}

// ── 首頁快捷：熱門 ETF Top5 / 基金 Top5 ─────────────────────
export function getHomeTopEtfs(): Etf[]  { return getTopEtfs("best1y", 5); }
export function getHomeTopFunds(): Fund[] { return getTopFunds("best1y", 5); }