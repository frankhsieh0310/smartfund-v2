// ============================================================
// lib/engines/filterEngine.ts
// SmartMatch Filter Engine
// Smart Search 核心，所有搜尋全部走此引擎
// ============================================================

import { ETF_LIST, type Etf } from "@/lib/data/etfData";
import { FUND_LIST, type Fund } from "@/lib/data/fundData";

// ── 篩選條件型別 ──────────────────────────────────────────────
export type FilterOperator = ">=" | "<=" | "==" | "!=" | "contains";
export type AssetType = "ETF" | "基金" | "all";

export interface FilterCondition {
  type:
    | "assetType"    // ETF / 基金 / all
    | "region"       // 台灣 / 美國 / 亞洲 / 全球 / 日本 / 中國 / 印度 / 歐洲 / 新興市場
    | "sector"       // 高股息 / 科技 / 市值型 / 債券 / 半導體...（ETF）
    | "category"     // 股票型 / 債券型 / 平衡型 / 貨幣型（基金）
    | "distribution" // 月配 / 季配 / 年配 / 不配息
    | "yield"        // 殖利率 / 月配息率 / 年化配息率
    | "return"       // 近1月 / 近3月 / 近6月 / 近1年 / 近3年
    | "volatility"   // 波動度
    | "morningstar"  // 晨星評等（基金）
    | "keyword";     // 商品名稱關鍵字
  operator: FilterOperator;
  value: string | number;
  period?: "1m" | "3m" | "6m" | "1y" | "3y"; // 用於 return 條件
}

// ── 搜尋請求 ──────────────────────────────────────────────────
export interface SearchRequest {
  conditions: FilterCondition[];  // 全部 AND
  assetType?: AssetType;
  topN?: number;
  sortBy?: "return1y" | "dividendYield" | "volatility" | "morningstar";
  sortDir?: "desc" | "asc";
}

// ── 搜尋結果統一格式 ──────────────────────────────────────────
export interface SearchResultItem {
  id:           string;
  code:         string;
  name:         string;
  type:         "ETF" | "基金";
  company?:     string;
  region:       string;
  sector?:      string;
  category?:    string;
  dividendYield: number;
  dividendFreq?: string;
  return1m:     number;
  return1y:     number;
  return3y:     number;
  volatility:   number;
  morningstar?: number;
}

// ── ETF 條件篩選 ──────────────────────────────────────────────
function matchEtf(etf: Etf, cond: FilterCondition): boolean {
  switch (cond.type) {
    case "assetType":
      return cond.value === "all" || cond.value === "ETF";
    case "region":
      return etf.region.includes(String(cond.value));
    case "sector":
      return etf.sector.includes(String(cond.value));
    case "distribution": {
      const freq = String(cond.value);
      if (freq === "月配") return etf.dividendFreq === "月配";
      if (freq === "季配") return etf.dividendFreq === "季配";
      if (freq === "不配息") return etf.dividendFreq === "不配息";
      return etf.dividendFreq.includes(freq);
    }
    case "yield":
      return applyOp(etf.dividendYield, cond.operator, Number(cond.value));
    case "return": {
      const periodMap: Record<string, keyof Etf> = {
        "1m": "return1m", "3m": "return3m",
        "6m": "return6m", "1y": "return1y", "3y": "return3y",
      };
      const key = periodMap[cond.period ?? "1y"] ?? "return1y";
      return applyOp(etf[key] as number, cond.operator, Number(cond.value));
    }
    case "volatility":
      return applyOp(etf.volatility, cond.operator, Number(cond.value));
    case "keyword":
      return etf.name.includes(String(cond.value)) || etf.code.includes(String(cond.value));
    default:
      return true;
  }
}

// ── 基金條件篩選 ──────────────────────────────────────────────
function matchFund(fund: Fund, cond: FilterCondition): boolean {
  switch (cond.type) {
    case "assetType":
      return cond.value === "all" || cond.value === "基金";
    case "region":
      return fund.region.includes(String(cond.value));
    case "category":
      return fund.category === String(cond.value);
    case "sector":
      return fund.category.includes(String(cond.value)); // 基金以 category 對應
    case "distribution": {
      const freq = String(cond.value);
      if (freq === "月配") return fund.dividendFreq === "月配";
      if (freq === "不配息") return fund.dividendFreq === "不配息";
      return fund.dividendFreq.includes(freq);
    }
    case "yield":
      return applyOp(fund.dividendYieldA, cond.operator, Number(cond.value));
    case "return": {
      const periodMap: Record<string, keyof Fund> = {
        "1m": "return1m", "3m": "return3m",
        "6m": "return6m", "1y": "return1y", "3y": "return3y",
      };
      const key = periodMap[cond.period ?? "1y"] ?? "return1y";
      return applyOp(fund[key] as number, cond.operator, Number(cond.value));
    }
    case "volatility":
      return applyOp(fund.volatility, cond.operator, Number(cond.value));
    case "morningstar":
      return applyOp(fund.morningstar, cond.operator, Number(cond.value));
    case "keyword":
      return fund.name.includes(String(cond.value)) || fund.company.includes(String(cond.value));
    default:
      return true;
  }
}

// ── 數值運算子 ────────────────────────────────────────────────
function applyOp(val: number, op: FilterOperator, target: number): boolean {
  switch (op) {
    case ">=": return val >= target;
    case "<=": return val <= target;
    case "==": return val === target;
    case "!=": return val !== target;
    default:   return true;
  }
}

// ── 轉換為統一格式 ────────────────────────────────────────────
function etfToResult(e: Etf): SearchResultItem {
  return {
    id: e.code, code: e.code, name: e.name, type: "ETF",
    region: e.region, sector: e.sector,
    dividendYield: e.dividendYield, dividendFreq: e.dividendFreq,
    return1m: e.return1m, return1y: e.return1y, return3y: e.return3y,
    volatility: e.volatility,
  };
}

function fundToResult(f: Fund): SearchResultItem {
  return {
    id: f.id, code: f.id, name: f.name, type: "基金",
    company: f.company, region: f.region, category: f.category,
    dividendYield: f.dividendYieldA, dividendFreq: f.dividendFreq,
    return1m: f.return1m, return1y: f.return1y, return3y: f.return3y,
    volatility: f.volatility, morningstar: f.morningstar,
  };
}

// ── 公開 API ─────────────────────────────────────────────────

export function searchEtfs(req: SearchRequest): Etf[] {
  const conds = req.conditions.filter(c => c.type !== "assetType" && c.type !== "category" && c.type !== "morningstar");
  let results = ETF_LIST.filter(e => conds.every(c => matchEtf(e, c)));
  results = sortResults(results, req) as Etf[];
  return results.slice(0, req.topN ?? 20);
}

export function searchFunds(req: SearchRequest): Fund[] {
  const conds = req.conditions.filter(c => c.type !== "assetType" && c.type !== "sector");
  // map "sector" condition to "category" for funds
  const sectorConds = req.conditions.filter(c => c.type === "sector").map(c => ({ ...c, type: "category" as const }));
  const allConds = [...conds, ...sectorConds];
  let results = FUND_LIST.filter(f => allConds.every(c => matchFund(f, c)));
  results = sortResults(results, req) as Fund[];
  return results.slice(0, req.topN ?? 20);
}

export function searchAll(req: SearchRequest): SearchResultItem[] {
  const assetTypeCond = req.conditions.find(c => c.type === "assetType");
  const assetType = (assetTypeCond?.value as AssetType) ?? "all";

  const results: SearchResultItem[] = [];

  if (assetType === "all" || assetType === "ETF") {
    searchEtfs(req).forEach(e => results.push(etfToResult(e)));
  }
  if (assetType === "all" || assetType === "基金") {
    searchFunds(req).forEach(f => results.push(fundToResult(f)));
  }

  // 統一排序
  const dir = req.sortDir ?? "desc";
  const by  = req.sortBy ?? "return1y";
  results.sort((a, b) => {
    const va = (a[by as keyof SearchResultItem] as number) ?? 0;
    const vb = (b[by as keyof SearchResultItem] as number) ?? 0;
    return dir === "desc" ? vb - va : va - vb;
  });

  return results.slice(0, req.topN ?? 20);
}

// ── 內部排序 ─────────────────────────────────────────────────
function sortResults<T extends Record<string, unknown>>(list: T[], req: SearchRequest): T[] {
  const by  = req.sortBy ?? "return1y";
  const dir = req.sortDir ?? "desc";
  return list.sort((a, b) => {
    const va = (a[by] as number) ?? 0;
    const vb = (b[by] as number) ?? 0;
    return dir === "desc" ? vb - va : va - vb;
  });
}

// ── 自然語言解析（給首頁 SmartSearch 用）─────────────────────
export function parseNaturalQuery(raw: string): FilterCondition[] {
  const q = raw.toLowerCase().replace(/，/g, ",").replace(/、/g, " ");
  const conditions: FilterCondition[] = [];

  // 殖利率/配息
  const yieldMatch = q.match(/(?:配息|殖利率)\s*(\d+(?:\.\d+)?)\s*%?\s*以上/) ||
                     q.match(/(\d+(?:\.\d+)?)\s*%?\s*(?:以上)?\s*(?:配息|殖利率)/);
  if (yieldMatch) conditions.push({ type: "yield", operator: ">=", value: parseFloat(yieldMatch[1]) });

  // 近一年績效
  const r1yMatch = q.match(/近一年\s*(\d+(?:\.\d+)?)\s*%?\s*以上/) ||
                   q.match(/(?:績效|漲幅)\s*(\d+(?:\.\d+)?)\s*%?\s*以上/);
  if (r1yMatch) conditions.push({ type: "return", operator: ">=", value: parseFloat(r1yMatch[1]), period: "1y" });

  // 月配息
  if (q.includes("月配息") || q.includes("月配")) conditions.push({ type: "distribution", operator: "==", value: "月配" });

  // 地區
  const regionMap: [string[], string][] = [
    [["台灣","台股"],       "台灣"],
    [["美國","美股"],       "美國"],
    [["全球","global"],     "全球"],
    [["亞洲","亞太"],       "亞洲"],
    [["日本"],              "日本"],
    [["中國","大陸"],       "中國"],
    [["印度"],              "印度"],
    [["歐洲"],              "歐洲"],
    [["新興市場","新興"],   "新興市場"],
  ];
  for (const [keys, region] of regionMap) {
    if (keys.some(k => q.includes(k))) { conditions.push({ type: "region", operator: "==", value: region }); break; }
  }

  // 基金類別
  if (q.includes("股票型"))      conditions.push({ type: "category", operator: "==", value: "股票型" });
  else if (q.includes("債券型")) conditions.push({ type: "category", operator: "==", value: "債券型" });
  else if (q.includes("平衡型")) conditions.push({ type: "category", operator: "==", value: "平衡型" });

  // ETF Sector
  const sectorMap: [string[], string][] = [
    [["高股息"],            "高股息"],
    [["科技"],              "科技"],
    [["半導體"],            "半導體"],
    [["市值型"],            "市值型"],
    [["債券"],              "債券"],
    [["ai","人工智慧","人工智能"], "科技"],
    [["低波動"],            "市值型"],
  ];
  for (const [keys, sector] of sectorMap) {
    if (keys.some(k => q.includes(k))) { conditions.push({ type: "sector", operator: "==", value: sector }); break; }
  }

  // 資產類型
  if (q.includes("etf") && !q.includes("基金"))      conditions.push({ type: "assetType", operator: "==", value: "ETF" });
  else if (q.includes("基金") && !q.includes("etf")) conditions.push({ type: "assetType", operator: "==", value: "基金" });

  return conditions;
}