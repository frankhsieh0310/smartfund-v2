// ============================================================
// lib/engines/strategyEngine.ts
// SmartMatch Strategy Engine
// 投資策略 = 條件集合，可儲存、載入、執行
// Premium 功能
// ============================================================

import { type FilterCondition, searchAll, type SearchResultItem } from "./filterEngine";

// ── 策略介面 ──────────────────────────────────────────────────
export interface Strategy {
  id:          string;
  name:        string;
  description?: string;
  conditions:  FilterCondition[];
  isPremium:   boolean;   // 是否需要 Premium
  createdAt:   string;    // ISO date string
  updatedAt:   string;
  runCount:    number;    // 執行次數
}

// ── 策略執行結果 ──────────────────────────────────────────────
export interface StrategyResult {
  strategyId:  string;
  strategyName: string;
  results:     SearchResultItem[];
  runAt:       string;
  totalCount:  number;
}

// ── localStorage key ──────────────────────────────────────────
const STORAGE_KEY = "smartmatch_strategies";

// ── 載入策略（從 localStorage）──────────────────────────────
export function loadStrategies(): Strategy[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// ── 儲存策略（Premium 限定最多 20 個，免費最多 1 個）────────
export function saveStrategy(
  strategy: Omit<Strategy, "id" | "createdAt" | "updatedAt" | "runCount">,
  isPremiumUser = false
): { success: boolean; error?: string; strategy?: Strategy } {
  const existing = loadStrategies();

  // 免費會員只能存 1 個策略
  if (!isPremiumUser && existing.length >= 1) {
    return { success: false, error: "免費會員最多儲存 1 個策略，升級 Premium 可儲存無限策略" };
  }
  // Premium 最多 20 個
  if (isPremiumUser && existing.length >= 20) {
    return { success: false, error: "已達策略上限（20個）" };
  }
  // 免費會員最多 3 個條件
  if (!isPremiumUser && strategy.conditions.length > 3) {
    return { success: false, error: "免費會員最多 3 個篩選條件，升級 Premium 可使用最多 20 個條件" };
  }

  const now = new Date().toISOString();
  const newStrategy: Strategy = {
    ...strategy,
    id:        `strategy_${Date.now()}`,
    createdAt: now,
    updatedAt: now,
    runCount:  0,
    isPremium: !isPremiumUser ? false : strategy.isPremium,
  };

  existing.push(newStrategy);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  return { success: true, strategy: newStrategy };
}

// ── 刪除策略 ─────────────────────────────────────────────────
export function deleteStrategy(id: string): boolean {
  const existing = loadStrategies();
  const filtered = existing.filter(s => s.id !== id);
  if (filtered.length === existing.length) return false;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
  return true;
}

// ── 執行策略 ─────────────────────────────────────────────────
export function runStrategy(id: string): StrategyResult | null {
  const strategies = loadStrategies();
  const strategy = strategies.find(s => s.id === id);
  if (!strategy) return null;

  const results = searchAll({ conditions: strategy.conditions, topN: 20 });

  // 更新執行次數
  strategy.runCount += 1;
  strategy.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(strategies));

  return {
    strategyId:   strategy.id,
    strategyName: strategy.name,
    results,
    runAt:        new Date().toISOString(),
    totalCount:   results.length,
  };
}

// ── 預設熱門策略（系統內建，不可刪除）──────────────────────
export const PRESET_STRATEGIES: Omit<Strategy, "id" | "createdAt" | "updatedAt" | "runCount">[] = [
  {
    name: "退休現金流",
    description: "月配息、高殖利率、低波動，適合退休收入規劃",
    isPremium: false,
    conditions: [
      { type: "distribution", operator: "==",  value: "月配" },
      { type: "yield",        operator: ">=",  value: 6 },
      { type: "volatility",   operator: "<=",  value: 15 },
    ],
  },
  {
    name: "亞洲收益",
    description: "亞洲市場高股息，月配息優先",
    isPremium: false,
    conditions: [
      { type: "region",       operator: "==",  value: "亞洲" },
      { type: "yield",        operator: ">=",  value: 5 },
      { type: "distribution", operator: "==",  value: "月配" },
    ],
  },
  {
    name: "科技成長",
    description: "全球科技產業，近1年績效優先",
    isPremium: false,
    conditions: [
      { type: "sector",       operator: "==",  value: "科技" },
      { type: "return",       operator: ">=",  value: 20, period: "1y" },
    ],
  },
  {
    name: "高股息精選",
    description: "殖利率6%以上，含ETF與基金",
    isPremium: false,
    conditions: [
      { type: "yield",        operator: ">=",  value: 6 },
    ],
  },
  {
    name: "AI主題（Premium）",
    description: "AI科技主題，近1年績效30%以上",
    isPremium: true,
    conditions: [
      { type: "sector",       operator: "==",  value: "科技" },
      { type: "return",       operator: ">=",  value: 30, period: "1y" },
      { type: "keyword",      operator: "contains", value: "AI" },
    ],
  },
];