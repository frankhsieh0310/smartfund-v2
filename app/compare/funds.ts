// 示意資料，非即時行情。正式上線前請替換為實際金融資料源。

export type Etf = {
    code: string;
    name: string;
    region: string;
    sector: string;
    expenseRatio: number; // %
    dividendYield: number; // %
    aum: number; // 億美元
    return1y: number; // %
  };
  
  export const ETF_LIST: Etf[] = [
    { code: "VOO", name: "Vanguard S&P 500 ETF", region: "美國", sector: "市值型", expenseRatio: 0.03, dividendYield: 1.3, aum: 4200, return1y: 24.1 },
    { code: "VTI", name: "Vanguard Total Stock Market ETF", region: "美國", sector: "市值型", expenseRatio: 0.03, dividendYield: 1.3, aum: 1600, return1y: 23.5 },
    { code: "QQQ", name: "Invesco QQQ Trust", region: "美國", sector: "科技", expenseRatio: 0.20, dividendYield: 0.6, aum: 2800, return1y: 29.4 },
    { code: "VUG", name: "Vanguard Growth ETF", region: "美國", sector: "成長型", expenseRatio: 0.04, dividendYield: 0.5, aum: 1450, return1y: 27.8 },
    { code: "VTV", name: "Vanguard Value ETF", region: "美國", sector: "價值型", expenseRatio: 0.04, dividendYield: 2.2, aum: 1280, return1y: 16.3 },
    { code: "SCHD", name: "Schwab US Dividend Equity ETF", region: "美國", sector: "高股息", expenseRatio: 0.06, dividendYield: 3.4, aum: 680, return1y: 14.2 },
    { code: "VYM", name: "Vanguard High Dividend Yield ETF", region: "美國", sector: "高股息", expenseRatio: 0.06, dividendYield: 2.9, aum: 590, return1y: 15.1 },
    { code: "VXUS", name: "Vanguard Total International Stock ETF", region: "全球", sector: "市值型", expenseRatio: 0.05, dividendYield: 2.8, aum: 980, return1y: 14.2 },
    { code: "VT", name: "Vanguard Total World Stock ETF", region: "全球", sector: "市值型", expenseRatio: 0.06, dividendYield: 1.8, aum: 450, return1y: 19.6 },
    { code: "VEA", name: "Vanguard FTSE Developed Markets ETF", region: "已開發市場", sector: "市值型", expenseRatio: 0.05, dividendYield: 2.7, aum: 1320, return1y: 13.8 },
    { code: "VWO", name: "Vanguard FTSE Emerging Markets ETF", region: "新興市場", sector: "市值型", expenseRatio: 0.07, dividendYield: 3.1, aum: 820, return1y: 11.4 },
    { code: "EEM", name: "iShares MSCI Emerging Markets ETF", region: "新興市場", sector: "市值型", expenseRatio: 0.69, dividendYield: 2.9, aum: 240, return1y: 10.7 },
    { code: "BND", name: "Vanguard Total Bond Market ETF", region: "美國", sector: "債券", expenseRatio: 0.03, dividendYield: 4.1, aum: 1180, return1y: 3.8 },
    { code: "AGG", name: "iShares Core U.S. Aggregate Bond ETF", region: "美國", sector: "債券", expenseRatio: 0.03, dividendYield: 4.0, aum: 1050, return1y: 3.6 },
    { code: "BNDX", name: "Vanguard Total International Bond ETF", region: "全球", sector: "債券", expenseRatio: 0.07, dividendYield: 3.2, aum: 540, return1y: 2.9 },
    { code: "LQD", name: "iShares iBoxx Investment Grade Corp Bond ETF", region: "美國", sector: "債券", expenseRatio: 0.14, dividendYield: 4.5, aum: 320, return1y: 4.2 },
    { code: "TLT", name: "iShares 20+ Year Treasury Bond ETF", region: "美國", sector: "債券", expenseRatio: 0.15, dividendYield: 3.9, aum: 480, return1y: -2.1 },
    { code: "00679B", name: "元大美債20年", region: "美國", sector: "債券", expenseRatio: 0.15, dividendYield: 3.8, aum: 95, return1y: -1.8 },
    { code: "0050", name: "元大台灣50", region: "台灣", sector: "市值型", expenseRatio: 0.43, dividendYield: 2.8, aum: 75, return1y: 21.6 },
    { code: "0056", name: "元大高股息", region: "台灣", sector: "高股息", expenseRatio: 0.66, dividendYield: 6.2, aum: 68, return1y: 12.4 },
    { code: "00878", name: "國泰永續高股息", region: "台灣", sector: "高股息", expenseRatio: 0.59, dividendYield: 5.8, aum: 92, return1y: 13.7 },
    { code: "006208", name: "富邦台50", region: "台灣", sector: "市值型", expenseRatio: 0.35, dividendYield: 2.7, aum: 45, return1y: 21.4 },
    { code: "XLK", name: "Technology Select Sector SPDR Fund", region: "美國", sector: "科技", expenseRatio: 0.09, dividendYield: 0.7, aum: 720, return1y: 31.2 },
    { code: "VGT", name: "Vanguard Information Technology ETF", region: "美國", sector: "科技", expenseRatio: 0.09, dividendYield: 0.6, aum: 850, return1y: 30.5 },
    { code: "SOXX", name: "iShares Semiconductor ETF", region: "美國", sector: "半導體", expenseRatio: 0.35, dividendYield: 0.8, aum: 110, return1y: 38.4 },
    { code: "SMH", name: "VanEck Semiconductor ETF", region: "全球", sector: "半導體", expenseRatio: 0.35, dividendYield: 0.6, aum: 230, return1y: 41.2 },
    { code: "XLF", name: "Financial Select Sector SPDR Fund", region: "美國", sector: "金融", expenseRatio: 0.09, dividendYield: 1.6, aum: 480, return1y: 18.9 },
    { code: "XLE", name: "Energy Select Sector SPDR Fund", region: "美國", sector: "能源", expenseRatio: 0.09, dividendYield: 3.3, aum: 320, return1y: 8.6 },
    { code: "XLV", name: "Health Care Select Sector SPDR Fund", region: "美國", sector: "醫療保健", expenseRatio: 0.09, dividendYield: 1.5, aum: 410, return1y: 9.8 },
    { code: "XLI", name: "Industrial Select Sector SPDR Fund", region: "美國", sector: "工業", expenseRatio: 0.09, dividendYield: 1.4, aum: 220, return1y: 17.3 },
    { code: "XLY", name: "Consumer Discretionary Select Sector SPDR", region: "美國", sector: "消費", expenseRatio: 0.09, dividendYield: 0.7, aum: 200, return1y: 22.7 },
    { code: "XLP", name: "Consumer Staples Select Sector SPDR", region: "美國", sector: "民生消費", expenseRatio: 0.09, dividendYield: 2.5, aum: 180, return1y: 7.4 },
    { code: "XLU", name: "Utilities Select Sector SPDR Fund", region: "美國", sector: "公用事業", expenseRatio: 0.09, dividendYield: 3.0, aum: 160, return1y: 19.2 },
    { code: "XLRE", name: "Real Estate Select Sector SPDR Fund", region: "美國", sector: "不動產", expenseRatio: 0.09, dividendYield: 3.4, aum: 70, return1y: 6.1 },
    { code: "GLD", name: "SPDR Gold Shares", region: "全球", sector: "大宗商品", expenseRatio: 0.40, dividendYield: 0, aum: 740, return1y: 28.3 },
    { code: "SLV", name: "iShares Silver Trust", region: "全球", sector: "大宗商品", expenseRatio: 0.50, dividendYield: 0, aum: 140, return1y: 21.6 },
    { code: "USO", name: "United States Oil Fund", region: "全球", sector: "大宗商品", expenseRatio: 0.81, dividendYield: 0, aum: 18, return1y: -4.2 },
    { code: "IWM", name: "iShares Russell 2000 ETF", region: "美國", sector: "小型股", expenseRatio: 0.19, dividendYield: 1.2, aum: 580, return1y: 12.9 },
    { code: "DIA", name: "SPDR Dow Jones Industrial Average ETF", region: "美國", sector: "市值型", expenseRatio: 0.16, dividendYield: 1.7, aum: 340, return1y: 15.8 },
    { code: "MCHI", name: "iShares MSCI China ETF", region: "中國", sector: "市值型", expenseRatio: 0.58, dividendYield: 2.4, aum: 65, return1y: 9.1 },
    { code: "EWJ", name: "iShares MSCI Japan ETF", region: "日本", sector: "市值型", expenseRatio: 0.50, dividendYield: 1.9, aum: 150, return1y: 17.6 },
    { code: "EWT", name: "iShares MSCI Taiwan ETF", region: "台灣", sector: "市值型", expenseRatio: 0.58, dividendYield: 2.3, aum: 78, return1y: 23.8 },
    { code: "INDA", name: "iShares MSCI India ETF", region: "印度", sector: "市值型", expenseRatio: 0.58, dividendYield: 1.0, aum: 88, return1y: 19.4 },
    { code: "FXI", name: "iShares China Large-Cap ETF", region: "中國", sector: "市值型", expenseRatio: 0.74, dividendYield: 2.6, aum: 52, return1y: 7.8 },
    { code: "ARKK", name: "ARK Innovation ETF", region: "美國", sector: "創新科技", expenseRatio: 0.75, dividendYield: 0, aum: 42, return1y: 12.6 },
    { code: "TQQQ", name: "ProShares UltraPro QQQ", region: "美國", sector: "槓桿型", expenseRatio: 0.86, dividendYield: 0, aum: 220, return1y: 68.3 },
    { code: "SQQQ", name: "ProShares UltraPro Short QQQ", region: "美國", sector: "反向型", expenseRatio: 0.95, dividendYield: 0, aum: 35, return1y: -42.7 },
    { code: "JEPI", name: "JPMorgan Equity Premium Income ETF", region: "美國", sector: "高股息", expenseRatio: 0.35, dividendYield: 7.8, aum: 380, return1y: 11.5 },
    { code: "SPLG", name: "SPDR Portfolio S&P 500 ETF", region: "美國", sector: "市值型", expenseRatio: 0.02, dividendYield: 1.3, aum: 360, return1y: 24.0 },
  ];
  
  export const REGIONS = Array.from(new Set(ETF_LIST.map((e) => e.region)));
  export const SECTORS = Array.from(new Set(ETF_LIST.map((e) => e.sector)));