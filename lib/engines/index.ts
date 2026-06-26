// ============================================================
// lib/engines/index.ts
// SmartMatch Engine 統一入口
// ============================================================

export * from "./rankingEngine";
export * from "./filterEngine";
export * from "./holdingsEngine";
export * from "./recommendationEngine";

// strategyEngine 單獨引入避免命名衝突
export type { Strategy, StrategyResult } from "./strategyEngine";
export {
  loadStrategies,
  saveStrategy,
  deleteStrategy,
  runStrategy,
  PRESET_STRATEGIES,
} from "./strategyEngine";