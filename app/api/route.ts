route.ts
// app/api/review/route.ts
// Serves review.json at /api/review

import { NextResponse } from "next/server";

const reviewData = {
  version: "3.4",
  updated: "2026-06-27",
  project: "SmartMatch",
  repo: "frankhsieh0310/smartfund-v2",
  deploy: "smartfund-v2.vercel.app",

  home: {
    path: "/",
    sections: ["Hero", "InvestmentCriteriaBuilder", "MockDashboard", "Comparison", "WhyCriteria", "MarketOverview", "Ranking", "Footer"],
    hero: {
      title: "打造屬於你的投資儀表板",
      subtitle: "掌握市場資訊、追蹤關注商品、建立自己的投資資料庫",
      cta_primary: "開始打造我的投資首頁 →",
      background: "金融商辦大樓 overlay rgba(#020817, 50%/20%)"
    },
    criteriaBuilder: {
      title: "建立你的投資條件",
      engine: "lib/query/queryBuilder → lib/engines/filterEngine",
      logic: "同一分類 OR，跨分類 AND",
      free_limit: 3,
      premium_limit: 20,
      live_count: true,
      categories: ["資產類型", "投資區域", "商品類型", "配息頻率", "殖利率", "近1年績效", "近3年績效", "年化波動度"],
      examples: ["退休現金流", "亞洲股票基金", "科技成長", "低波動收益", "高股息ETF"]
    },
    mockDashboard: {
      title: "登入後，你的首頁會長這樣",
      criteria: [
        { name: "退休現金流", etf: 8, fund: 17 },
        { name: "亞洲收益", etf: 5, fund: 12 },
        { name: "科技成長", etf: 11, fund: 6 },
        { name: "美元收益", etf: 3, fund: 18 }
      ]
    }
  },

  etf: {
    path: "/etf",
    data_count: 94,
    ranking_tabs: ["近1年績效", "近30日熱門", "近3個月熱門", "殖利率最高", "低波動"],
    sortable_columns: ["每單位配息", "殖利率", "今年以來", "近1月", "近3月", "近6月", "近1年", "近3年", "波動度"],
    action_buttons: ["⭐收藏", "👀觀察", "📊比較"],
    ranking_style: "Card Layout with 🥇🥈🥉 badges"
  },

  funds: {
    path: "/funds",
    data_count: 138,
    companies: ["野村", "富邦", "國泰", "元大", "安聯", "聯博", "摩根", "貝萊德", "霸菱", "施羅德"],
    ranking_tabs: ["近1年績效", "近30日熱門", "近3個月熱門", "月配息率", "年化配息率", "低波動"],
    sortable_columns: ["月配息率", "年化配息率", "今年以來", "近1月", "近3月", "近6月", "近1年", "近3年", "波動度"],
    action_buttons: ["⭐收藏", "👀觀察", "📊比較"],
    ranking_style: "Card Layout with 🥇🥈🥉 badges"
  },

  architecture: {
    "lib/data": ["etfData.ts (94筆)", "fundData.ts (138筆)", "marketData.ts"],
    "lib/engines": ["rankingEngine.ts", "filterEngine.ts", "holdingsEngine.ts", "strategyEngine.ts", "recommendationEngine.ts"],
    "lib/query": ["queryBuilder.ts (OR/AND logic layer)"],
    "lib/hooks": ["useWatchlist.ts (shared favorites/watchlist/compareList across all pages)"],
    "lib/services": ["rankingService.ts"]
  },

  compliance: {
    forbidden_words: ["推薦", "建議", "最適合", "最佳", "永久免費", "無需信用卡"],
    required_disclaimers: ["非投資建議", "示意資料・非即時行情"],
    positioning: "Data + Tools + CRM（不是投顧）"
  },

  phases_complete: ["Phase 1: Data Foundation", "Phase 2: Ranking Engine", "Phase 3: Engine Layer", "Phase 3A: Homepage Experience", "Phase 3B: UX Refinement"],
  phases_next: ["Phase 4: Auth + Save Criteria", "Phase 5: Holdings Engine UI", "Phase 6: Natural Language Search"]
};

export async function GET() {
  return NextResponse.json(reviewData, {
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}