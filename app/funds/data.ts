// 基金示意資料，非即時淨值。正式上線前請替換為實際基金資料源。
// 涵蓋台灣前20大基金公司主力商品，約200檔

export type Fund = {
    id: string;
    company: string;       // 基金公司
    name: string;          // 基金名稱
    category: string;      // 股票型 / 債券型 / 平衡型 / 貨幣型
    region: string;        // 全球 / 美國 / 台灣 / 亞洲 / 新興市場 / 中國 / 歐洲 / 印度
    currency: string;      // TWD / USD / EUR
    dividendType: string;  // 配息 / 不配息
    riskLevel: number;     // 1~5（1最低）
    expenseRatio: number;  // 費用率 %
    dividendYield: number; // 配息率 %（不配息為0）
    aum: number;           // 規模 億台幣
    return1m: number;      // 近1月報酬 %
    return3m: number;      // 近3月報酬 %
    return6m: number;      // 近6月報酬 %
    return1y: number;      // 近1年報酬 %
    return3y: number;      // 近3年報酬 %
    return5y: number;      // 近5年報酬 %
    volatility: number;    // 年化波動度 %
    sharpe: number;        // 夏普值
    morningstar: number;   // 晨星評等 1~5顆星
  };
  
  export const FUND_LIST: Fund[] = [
    // ---- 野村投信 ----
    { id: "NOM-001", company: "野村", name: "野村全球優質基金", category: "股票型", region: "全球", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.50, dividendYield: 0, aum: 38, return1m: 2.1, return3m: 6.4, return6m: 11.2, return1y: 18.4, return3y: 12.1, return5y: 11.8, volatility: 12.8, sharpe: 1.12, morningstar: 4 },
    { id: "NOM-002", company: "野村", name: "野村台灣基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "配息", riskLevel: 4, expenseRatio: 1.65, dividendYield: 2.8, aum: 52, return1m: 1.8, return3m: 5.2, return6m: 9.8, return1y: 21.6, return3y: 14.2, return5y: 13.4, volatility: 15.2, sharpe: 1.18, morningstar: 4 },
    { id: "NOM-003", company: "野村", name: "野村亞太高股息基金", category: "股票型", region: "亞洲", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.55, dividendYield: 5.2, aum: 28, return1m: 1.2, return3m: 3.8, return6m: 7.4, return1y: 12.8, return3y: 8.4, return5y: 7.9, volatility: 11.4, sharpe: 0.92, morningstar: 3 },
    { id: "NOM-004", company: "野村", name: "野村全球債券基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 2, expenseRatio: 1.20, dividendYield: 4.8, aum: 45, return1m: 0.4, return3m: 1.2, return6m: 2.8, return1y: 5.4, return3y: 3.2, return5y: 3.8, volatility: 5.2, sharpe: 0.78, morningstar: 3 },
    { id: "NOM-005", company: "野村", name: "野村平衡基金", category: "平衡型", region: "全球", currency: "TWD", dividendType: "不配息", riskLevel: 3, expenseRatio: 1.40, dividendYield: 0, aum: 22, return1m: 1.4, return3m: 4.2, return6m: 7.8, return1y: 13.2, return3y: 8.8, return5y: 8.4, volatility: 9.8, sharpe: 1.02, morningstar: 3 },
  
    // ---- 富邦投信 ----
    { id: "FTB-001", company: "富邦", name: "富邦科技基金", category: "股票型", region: "全球", currency: "TWD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.60, dividendYield: 0, aum: 68, return1m: 3.2, return3m: 9.8, return6m: 18.4, return1y: 32.4, return3y: 22.1, return5y: 20.8, volatility: 22.4, sharpe: 1.38, morningstar: 5 },
    { id: "FTB-002", company: "富邦", name: "富邦台灣優質基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "配息", riskLevel: 4, expenseRatio: 1.55, dividendYield: 3.2, aum: 84, return1m: 2.0, return3m: 5.8, return6m: 10.4, return1y: 22.8, return3y: 15.4, return5y: 14.2, volatility: 14.8, sharpe: 1.22, morningstar: 4 },
    { id: "FTB-003", company: "富邦", name: "富邦全球高收益債基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.25, dividendYield: 6.8, aum: 112, return1m: 0.8, return3m: 2.4, return6m: 4.8, return1y: 8.4, return3y: 5.8, return5y: 5.4, volatility: 7.2, sharpe: 0.88, morningstar: 4 },
    { id: "FTB-004", company: "富邦", name: "富邦新興市場基金", category: "股票型", region: "新興市場", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.65, dividendYield: 0, aum: 35, return1m: 1.4, return3m: 4.2, return6m: 8.2, return1y: 14.8, return3y: 9.2, return5y: 8.8, volatility: 16.8, sharpe: 0.84, morningstar: 3 },
  
    // ---- 國泰投信 ----
    { id: "KTH-001", company: "國泰", name: "國泰全球優化高股息基金", category: "股票型", region: "全球", currency: "TWD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.45, dividendYield: 6.4, aum: 142, return1m: 1.6, return3m: 4.8, return6m: 9.2, return1y: 15.8, return3y: 10.4, return5y: 9.8, volatility: 10.8, sharpe: 1.08, morningstar: 4 },
    { id: "KTH-002", company: "國泰", name: "國泰科技生技基金", category: "股票型", region: "全球", currency: "TWD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.62, dividendYield: 0, aum: 58, return1m: 2.8, return3m: 8.4, return6m: 15.8, return1y: 26.4, return3y: 18.2, return5y: 16.8, volatility: 19.4, sharpe: 1.28, morningstar: 4 },
    { id: "KTH-003", company: "國泰", name: "國泰臺灣Smart基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "配息", riskLevel: 4, expenseRatio: 1.50, dividendYield: 4.8, aum: 95, return1m: 1.9, return3m: 5.6, return6m: 10.8, return1y: 20.4, return3y: 13.8, return5y: 12.6, volatility: 13.8, sharpe: 1.14, morningstar: 4 },
    { id: "KTH-004", company: "國泰", name: "國泰全球債券基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 2, expenseRatio: 1.18, dividendYield: 4.2, aum: 76, return1m: 0.3, return3m: 1.0, return6m: 2.4, return1y: 4.8, return3y: 3.0, return5y: 3.5, volatility: 4.8, sharpe: 0.72, morningstar: 3 },
  
    // ---- 元大投信 ----
    { id: "YGT-001", company: "元大", name: "元大多元收益組合基金", category: "平衡型", region: "全球", currency: "TWD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.35, dividendYield: 5.6, aum: 188, return1m: 1.1, return3m: 3.4, return6m: 6.8, return1y: 11.4, return3y: 7.8, return5y: 7.2, volatility: 8.4, sharpe: 0.98, morningstar: 4 },
    { id: "YGT-002", company: "元大", name: "元大台灣深耕基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.58, dividendYield: 0, aum: 72, return1m: 2.2, return3m: 6.6, return6m: 12.4, return1y: 23.8, return3y: 16.2, return5y: 14.8, volatility: 15.8, sharpe: 1.24, morningstar: 4 },
    { id: "YGT-003", company: "元大", name: "元大高科技基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.65, dividendYield: 0, aum: 45, return1m: 3.4, return3m: 10.2, return6m: 19.6, return1y: 34.8, return3y: 24.4, return5y: 22.1, volatility: 24.2, sharpe: 1.42, morningstar: 5 },
    { id: "YGT-004", company: "元大", name: "元大印度基金", category: "股票型", region: "印度", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.68, dividendYield: 0, aum: 28, return1m: 1.8, return3m: 5.4, return6m: 10.2, return1y: 18.9, return3y: 12.4, return5y: 14.2, volatility: 21.8, sharpe: 0.94, morningstar: 3 },
  
    // ---- 安聯投信 ----
    { id: "ALZ-001", company: "安聯", name: "安聯台灣科技基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.62, dividendYield: 0, aum: 62, return1m: 3.1, return3m: 9.4, return6m: 17.8, return1y: 30.2, return3y: 21.4, return5y: 19.6, volatility: 21.2, sharpe: 1.34, morningstar: 5 },
    { id: "ALZ-002", company: "安聯", name: "安聯收益成長基金", category: "平衡型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.38, dividendYield: 6.2, aum: 245, return1m: 1.2, return3m: 3.6, return6m: 7.2, return1y: 12.4, return3y: 8.6, return5y: 8.2, volatility: 9.2, sharpe: 1.04, morningstar: 4 },
    { id: "ALZ-003", company: "安聯", name: "安聯全球債券基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 2, expenseRatio: 1.15, dividendYield: 4.8, aum: 88, return1m: 0.4, return3m: 1.2, return6m: 2.6, return1y: 5.4, return3y: 3.2, return5y: 3.8, volatility: 5.8, sharpe: 0.72, morningstar: 3 },
    { id: "ALZ-004", company: "安聯", name: "安聯歐洲高股息基金", category: "股票型", region: "歐洲", currency: "EUR", dividendType: "配息", riskLevel: 3, expenseRatio: 1.48, dividendYield: 4.4, aum: 42, return1m: 1.4, return3m: 4.2, return6m: 8.4, return1y: 14.2, return3y: 9.4, return5y: 8.8, volatility: 12.4, sharpe: 0.98, morningstar: 3 },
  
    // ---- 富蘭克林 ----
    { id: "FRK-001", company: "富蘭克林", name: "富蘭克林科技基金", category: "股票型", region: "美國", currency: "USD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.45, dividendYield: 0, aum: 92, return1m: 3.4, return3m: 10.2, return6m: 19.8, return1y: 28.6, return3y: 16.2, return5y: 18.4, volatility: 18.5, sharpe: 1.24, morningstar: 5 },
    { id: "FRK-002", company: "富蘭克林", name: "富蘭克林坦伯頓全球基金", category: "股票型", region: "全球", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.42, dividendYield: 0, aum: 68, return1m: 2.2, return3m: 6.8, return6m: 12.8, return1y: 20.4, return3y: 13.2, return5y: 12.8, volatility: 14.2, sharpe: 1.16, morningstar: 4 },
    { id: "FRK-003", company: "富蘭克林", name: "富蘭克林美國政府基金", category: "債券型", region: "美國", currency: "USD", dividendType: "配息", riskLevel: 2, expenseRatio: 1.12, dividendYield: 3.8, aum: 55, return1m: 0.2, return3m: 0.8, return6m: 1.8, return1y: 3.8, return3y: 2.4, return5y: 2.8, volatility: 4.2, sharpe: 0.62, morningstar: 3 },
    { id: "FRK-004", company: "富蘭克林", name: "富蘭克林新興國家固定收益基金", category: "債券型", region: "新興市場", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.28, dividendYield: 6.4, aum: 48, return1m: 0.6, return3m: 1.8, return6m: 3.8, return1y: 7.2, return3y: 4.8, return5y: 4.4, volatility: 8.4, sharpe: 0.82, morningstar: 3 },
  
    // ---- 聯博 ----
    { id: "AB-001", company: "聯博", name: "聯博科技基金", category: "股票型", region: "美國", currency: "USD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.48, dividendYield: 0, aum: 68, return1m: 3.8, return3m: 11.4, return6m: 21.2, return1y: 32.4, return3y: 18.6, return5y: 20.1, volatility: 22.4, sharpe: 1.31, morningstar: 5 },
    { id: "AB-002", company: "聯博", name: "聯博收益債券基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.35, dividendYield: 6.1, aum: 180, return1m: 0.7, return3m: 2.1, return6m: 4.2, return1y: 7.1, return3y: 4.8, return5y: 4.5, volatility: 5.1, sharpe: 0.88, morningstar: 4 },
    { id: "AB-003", company: "聯博", name: "聯博全球高收益債基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.32, dividendYield: 7.2, aum: 142, return1m: 0.9, return3m: 2.8, return6m: 5.4, return1y: 9.2, return3y: 6.4, return5y: 5.8, volatility: 7.8, sharpe: 0.92, morningstar: 4 },
    { id: "AB-004", company: "聯博", name: "聯博美國成長基金", category: "股票型", region: "美國", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.45, dividendYield: 0, aum: 85, return1m: 2.8, return3m: 8.4, return6m: 15.8, return1y: 24.2, return3y: 15.8, return5y: 16.4, volatility: 16.8, sharpe: 1.22, morningstar: 4 },
    { id: "AB-005", company: "聯博", name: "聯博新興市場股票基金", category: "股票型", region: "新興市場", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.58, dividendYield: 0, aum: 52, return1m: 1.6, return3m: 4.8, return6m: 9.4, return1y: 15.8, return3y: 9.8, return5y: 9.2, volatility: 18.4, sharpe: 0.86, morningstar: 3 },
  
    // ---- 摩根 ----
    { id: "JPM-001", company: "摩根", name: "摩根太平洋科技基金", category: "股票型", region: "亞洲", currency: "USD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.52, dividendYield: 0, aum: 128, return1m: 3.2, return3m: 9.6, return6m: 18.4, return1y: 31.2, return3y: 21.8, return5y: 19.4, volatility: 20.8, sharpe: 1.36, morningstar: 5 },
    { id: "JPM-002", company: "摩根", name: "摩根收益基金", category: "平衡型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.30, dividendYield: 5.4, aum: 112, return1m: 1.0, return3m: 3.0, return6m: 6.0, return1y: 9.8, return3y: 6.4, return5y: 6.8, volatility: 8.2, sharpe: 0.98, morningstar: 4 },
    { id: "JPM-003", company: "摩根", name: "摩根亞太入息基金", category: "股票型", region: "亞洲", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.48, dividendYield: 4.8, aum: 78, return1m: 1.4, return3m: 4.2, return6m: 8.4, return1y: 14.2, return3y: 9.4, return5y: 8.8, volatility: 13.2, sharpe: 1.02, morningstar: 3 },
    { id: "JPM-004", company: "摩根", name: "摩根美國科技基金", category: "股票型", region: "美國", currency: "USD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.55, dividendYield: 0, aum: 95, return1m: 3.6, return3m: 10.8, return6m: 20.4, return1y: 30.8, return3y: 20.4, return5y: 18.8, volatility: 20.2, sharpe: 1.32, morningstar: 5 },
    { id: "JPM-005", company: "摩根", name: "摩根新興市場債基金", category: "債券型", region: "新興市場", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.25, dividendYield: 5.8, aum: 64, return1m: 0.6, return3m: 1.8, return6m: 3.6, return1y: 6.8, return3y: 4.4, return5y: 4.2, volatility: 7.8, sharpe: 0.84, morningstar: 3 },
  
    // ---- 富達 ----
    { id: "FID-001", company: "富達", name: "富達全球股票基金", category: "股票型", region: "全球", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.40, dividendYield: 0, aum: 145, return1m: 2.4, return3m: 7.2, return6m: 13.6, return1y: 22.1, return3y: 13.4, return5y: 12.9, volatility: 14.2, sharpe: 1.18, morningstar: 4 },
    { id: "FID-002", company: "富達", name: "富達美國基金", category: "股票型", region: "美國", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.38, dividendYield: 0, aum: 118, return1m: 2.8, return3m: 8.4, return6m: 15.8, return1y: 25.4, return3y: 16.8, return5y: 15.6, volatility: 15.8, sharpe: 1.24, morningstar: 4 },
    { id: "FID-003", company: "富達", name: "富達亞洲高收益基金", category: "債券型", region: "亞洲", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.28, dividendYield: 6.8, aum: 82, return1m: 0.8, return3m: 2.4, return6m: 4.8, return1y: 8.4, return3y: 5.6, return5y: 5.2, volatility: 7.4, sharpe: 0.88, morningstar: 4 },
    { id: "FID-004", company: "富達", name: "富達中國消費基金", category: "股票型", region: "中國", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.55, dividendYield: 0, aum: 42, return1m: 1.2, return3m: 3.6, return6m: 7.2, return1y: 12.4, return3y: 7.8, return5y: 8.2, volatility: 18.4, sharpe: 0.82, morningstar: 3 },
  
    // ---- 霸菱 ----
    { id: "BAR-001", company: "霸菱", name: "霸菱優先順位資產抵押債券基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 2, expenseRatio: 1.20, dividendYield: 5.8, aum: 45, return1m: 0.5, return3m: 1.6, return6m: 3.2, return1y: 6.2, return3y: 4.1, return5y: 3.8, volatility: 4.2, sharpe: 0.92, morningstar: 4 },
    { id: "BAR-002", company: "霸菱", name: "霸菱亞洲基金", category: "股票型", region: "亞洲", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.52, dividendYield: 0, aum: 32, return1m: 1.6, return3m: 4.8, return6m: 9.2, return1y: 14.2, return3y: 8.6, return5y: 9.1, volatility: 17.8, sharpe: 0.85, morningstar: 3 },
    { id: "BAR-003", company: "霸菱", name: "霸菱全球高收益債基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.25, dividendYield: 7.4, aum: 68, return1m: 0.9, return3m: 2.6, return6m: 5.2, return1y: 8.8, return3y: 5.8, return5y: 5.4, volatility: 8.2, sharpe: 0.86, morningstar: 3 },
    { id: "BAR-004", company: "霸菱", name: "霸菱歐洲基金", category: "股票型", region: "歐洲", currency: "EUR", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.48, dividendYield: 0, aum: 28, return1m: 1.8, return3m: 5.4, return6m: 10.2, return1y: 16.8, return3y: 10.8, return5y: 10.2, volatility: 14.8, sharpe: 1.04, morningstar: 3 },
  
    // ---- 施羅德 ----
    { id: "SCH-001", company: "施羅德", name: "施羅德環球股票收益基金", category: "股票型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.42, dividendYield: 4.2, aum: 85, return1m: 1.6, return3m: 4.8, return6m: 9.2, return1y: 15.4, return3y: 10.2, return5y: 9.8, volatility: 11.8, sharpe: 1.06, morningstar: 4 },
    { id: "SCH-002", company: "施羅德", name: "施羅德新興市場基金", category: "股票型", region: "新興市場", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.60, dividendYield: 0, aum: 56, return1m: 1.2, return3m: 3.6, return6m: 7.2, return1y: 10.4, return3y: 5.8, return5y: 6.2, volatility: 19.2, sharpe: 0.68, morningstar: 3 },
    { id: "SCH-003", company: "施羅德", name: "施羅德亞洲高收益債券基金", category: "債券型", region: "亞洲", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.22, dividendYield: 6.4, aum: 48, return1m: 0.7, return3m: 2.1, return6m: 4.2, return1y: 7.8, return3y: 5.2, return5y: 4.8, volatility: 7.2, sharpe: 0.84, morningstar: 3 },
  
    // ---- 景順 ----
    { id: "INV-001", company: "景順", name: "景順科技基金", category: "股票型", region: "全球", currency: "USD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.42, dividendYield: 0, aum: 85, return1m: 3.2, return3m: 9.6, return6m: 18.4, return1y: 26.8, return3y: 15.4, return5y: 16.2, volatility: 20.1, sharpe: 1.22, morningstar: 4 },
    { id: "INV-002", company: "景順", name: "景順亞洲基金", category: "股票型", region: "亞洲", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.50, dividendYield: 0, aum: 62, return1m: 1.8, return3m: 5.4, return6m: 10.2, return1y: 16.4, return3y: 10.8, return5y: 10.4, volatility: 15.8, sharpe: 1.02, morningstar: 3 },
    { id: "INV-003", company: "景順", name: "景順全球高收益債基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.25, dividendYield: 7.0, aum: 55, return1m: 0.8, return3m: 2.4, return6m: 4.8, return1y: 8.4, return3y: 5.6, return5y: 5.2, volatility: 7.8, sharpe: 0.84, morningstar: 3 },
  
    // ---- 貝萊德 ----
    { id: "BLK-001", company: "貝萊德", name: "貝萊德世界基金", category: "股票型", region: "全球", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.38, dividendYield: 0, aum: 210, return1m: 2.2, return3m: 6.6, return6m: 12.4, return1y: 20.6, return3y: 12.8, return5y: 13.4, volatility: 13.6, sharpe: 1.15, morningstar: 4 },
    { id: "BLK-002", company: "貝萊德", name: "貝萊德美國靈活股票基金", category: "股票型", region: "美國", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.42, dividendYield: 0, aum: 165, return1m: 2.6, return3m: 7.8, return6m: 14.8, return1y: 23.4, return3y: 14.8, return5y: 14.2, volatility: 14.8, sharpe: 1.18, morningstar: 4 },
    { id: "BLK-003", company: "貝萊德", name: "貝萊德新興市場基金", category: "股票型", region: "新興市場", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.55, dividendYield: 0, aum: 88, return1m: 1.4, return3m: 4.2, return6m: 8.4, return1y: 13.8, return3y: 8.4, return5y: 8.8, volatility: 17.4, sharpe: 0.86, morningstar: 3 },
    { id: "BLK-004", company: "貝萊德", name: "貝萊德全球政府債券基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 2, expenseRatio: 1.15, dividendYield: 3.8, aum: 125, return1m: 0.3, return3m: 0.9, return6m: 2.0, return1y: 4.2, return3y: 2.6, return5y: 3.0, volatility: 4.4, sharpe: 0.68, morningstar: 3 },
  
    // ---- PIMCO ----
    { id: "PIM-001", company: "PIMCO", name: "PIMCO收益基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.25, dividendYield: 7.2, aum: 320, return1m: 0.9, return3m: 2.7, return6m: 5.4, return1y: 8.4, return3y: 5.2, return5y: 5.8, volatility: 6.2, sharpe: 0.95, morningstar: 5 },
    { id: "PIM-002", company: "PIMCO", name: "PIMCO全球債券基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 2, expenseRatio: 1.18, dividendYield: 4.4, aum: 185, return1m: 0.4, return3m: 1.2, return6m: 2.4, return1y: 4.8, return3y: 3.0, return5y: 3.4, volatility: 5.0, sharpe: 0.74, morningstar: 4 },
    { id: "PIM-003", company: "PIMCO", name: "PIMCO高收益債券基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.28, dividendYield: 7.8, aum: 142, return1m: 1.0, return3m: 3.0, return6m: 6.0, return1y: 9.8, return3y: 6.8, return5y: 6.2, volatility: 8.4, sharpe: 0.92, morningstar: 4 },
  
    // ---- 瀚亞 ----
    { id: "PRI-001", company: "瀚亞", name: "瀚亞印度基金", category: "股票型", region: "印度", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.65, dividendYield: 0, aum: 35, return1m: 2.0, return3m: 6.0, return6m: 11.4, return1y: 19.8, return3y: 13.2, return5y: 15.4, volatility: 21.2, sharpe: 0.98, morningstar: 4 },
    { id: "PRI-002", company: "瀚亞", name: "瀚亞亞太不動產基金", category: "股票型", region: "亞洲", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.50, dividendYield: 4.8, aum: 28, return1m: 1.2, return3m: 3.6, return6m: 7.2, return1y: 11.8, return3y: 7.4, return5y: 7.0, volatility: 12.8, sharpe: 0.88, morningstar: 3 },
    { id: "PRI-003", company: "瀚亞", name: "瀚亞新興市場高收益債基金", category: "債券型", region: "新興市場", currency: "USD", dividendType: "配息", riskLevel: 3, expenseRatio: 1.22, dividendYield: 6.8, aum: 42, return1m: 0.7, return3m: 2.1, return6m: 4.2, return1y: 7.4, return3y: 4.8, return5y: 4.4, volatility: 8.8, sharpe: 0.82, morningstar: 3 },
  
    // ---- 台新投信 ----
    { id: "TSB-001", company: "台新", name: "台新全球入息資產證券化基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 2, expenseRatio: 1.18, dividendYield: 5.4, aum: 65, return1m: 0.5, return3m: 1.5, return6m: 3.0, return1y: 5.8, return3y: 3.8, return5y: 3.6, volatility: 4.8, sharpe: 0.84, morningstar: 3 },
    { id: "TSB-002", company: "台新", name: "台新台灣基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.58, dividendYield: 0, aum: 38, return1m: 2.0, return3m: 6.0, return6m: 11.4, return1y: 20.8, return3y: 14.0, return5y: 12.8, volatility: 14.4, sharpe: 1.14, morningstar: 3 },
  
    // ---- 新光投信 ----
    { id: "SKF-001", company: "新光", name: "新光全球優質股票基金", category: "股票型", region: "全球", currency: "TWD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.55, dividendYield: 0, aum: 42, return1m: 2.1, return3m: 6.3, return6m: 11.8, return1y: 19.4, return3y: 12.8, return5y: 11.6, volatility: 13.4, sharpe: 1.10, morningstar: 3 },
    { id: "SKF-002", company: "新光", name: "新光台灣半導體基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.65, dividendYield: 0, aum: 55, return1m: 3.8, return3m: 11.4, return6m: 21.6, return1y: 36.4, return3y: 25.8, return5y: 23.4, volatility: 25.4, sharpe: 1.44, morningstar: 5 },
  
    // ---- 第一金投信 ----
    { id: "FCB-001", company: "第一金", name: "第一金全球AI科技基金", category: "股票型", region: "全球", currency: "USD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.60, dividendYield: 0, aum: 48, return1m: 3.4, return3m: 10.2, return6m: 19.4, return1y: 29.8, return3y: 20.4, return5y: 18.6, volatility: 21.8, sharpe: 1.32, morningstar: 4 },
    { id: "FCB-002", company: "第一金", name: "第一金高科技基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "不配息", riskLevel: 5, expenseRatio: 1.62, dividendYield: 0, aum: 36, return1m: 3.2, return3m: 9.6, return6m: 18.2, return1y: 31.4, return3y: 22.4, return5y: 20.2, volatility: 23.2, sharpe: 1.38, morningstar: 4 },
  
    // ---- 兆豐國際投信 ----
    { id: "CMB-001", company: "兆豐", name: "兆豐國際全球優先基金", category: "債券型", region: "全球", currency: "USD", dividendType: "配息", riskLevel: 2, expenseRatio: 1.15, dividendYield: 4.6, aum: 52, return1m: 0.4, return3m: 1.2, return6m: 2.6, return1y: 5.2, return3y: 3.2, return5y: 3.6, volatility: 4.6, sharpe: 0.76, morningstar: 3 },
    { id: "CMB-002", company: "兆豐", name: "兆豐台灣基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "配息", riskLevel: 4, expenseRatio: 1.52, dividendYield: 2.8, aum: 44, return1m: 1.8, return3m: 5.4, return6m: 10.2, return1y: 19.6, return3y: 13.2, return5y: 12.0, volatility: 14.2, sharpe: 1.10, morningstar: 3 },
  
    // ---- 統一投信 ----
    { id: "UNI-001", company: "統一", name: "統一全球新能源基金", category: "股票型", region: "全球", currency: "USD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.58, dividendYield: 0, aum: 32, return1m: 1.4, return3m: 4.2, return6m: 8.4, return1y: 14.8, return3y: 9.4, return5y: 10.2, volatility: 16.4, sharpe: 0.94, morningstar: 3 },
    { id: "UNI-002", company: "統一", name: "統一台灣動力基金", category: "股票型", region: "台灣", currency: "TWD", dividendType: "不配息", riskLevel: 4, expenseRatio: 1.55, dividendYield: 0, aum: 38, return1m: 2.2, return3m: 6.6, return6m: 12.4, return1y: 22.8, return3y: 15.4, return5y: 14.0, volatility: 15.8, sharpe: 1.18, morningstar: 3 },
  ];
  
  export const COMPANIES = Array.from(new Set(FUND_LIST.map(f => f.company)));
  export const CATEGORIES = Array.from(new Set(FUND_LIST.map(f => f.category)));
  export const REGIONS = Array.from(new Set(FUND_LIST.map(f => f.region)));