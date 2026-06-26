// ETF示意資料。台股ETF代碼與名稱對照真實商品，數值為示意，非即時行情。
// 正式上線前請替換為實際資料源。

export type Etf = {
    code: string;
    name: string;
    region: string;
    sector: string;
    dividendPerUnit: number;
    dividendYield: number;
    dividendFreq: string;
    returnYTD: number;
    return1m: number;
    return3m: number;
    return6m: number;
    return1y: number;
    return3y: number;
    volatility: number;
  };
  
  function freq(sector: string, yield_: number): string {
    if (yield_ === 0) return "不配息";
    if (sector === "高股息") return "月配";
    if (sector === "債券") return "月配";
    return "季配";
  }
  
  const RAW = [
    // ---- 台股 ETF：市值型 ----
    { code: "0050",   name: "元大台灣50",             region: "台灣", sector: "市值型",   dividendYield: 2.8,  return1y: 21.6 },
    { code: "0051",   name: "元大中型100",             region: "台灣", sector: "市值型",   dividendYield: 2.4,  return1y: 18.4 },
    { code: "006208", name: "富邦台50",                region: "台灣", sector: "市值型",   dividendYield: 2.7,  return1y: 21.4 },
    { code: "00922",  name: "國泰台灣領袖50",          region: "台灣", sector: "市值型",   dividendYield: 2.5,  return1y: 20.8 },
    { code: "006201", name: "元大富櫃50",              region: "台灣", sector: "市值型",   dividendYield: 1.8,  return1y: 15.2 },
    // ---- 半導體 ----
    { code: "00830",  name: "國泰費城半導體",          region: "台灣", sector: "半導體",   dividendYield: 0.8,  return1y: 38.4 },
    { code: "00881",  name: "國泰台灣5G+",             region: "台灣", sector: "科技",     dividendYield: 2.4,  return1y: 22.6 },
    { code: "00891",  name: "中信關鍵半導體",          region: "台灣", sector: "半導體",   dividendYield: 1.2,  return1y: 36.8 },
    { code: "00904",  name: "新光台灣半導體30",        region: "台灣", sector: "半導體",   dividendYield: 1.0,  return1y: 34.2 },
    { code: "00913",  name: "兆豐台灣晶圓製造ETF",    region: "台灣", sector: "半導體",   dividendYield: 1.4,  return1y: 32.8 },
    { code: "00928",  name: "中信上游ESG30",           region: "台灣", sector: "ESG",      dividendYield: 2.2,  return1y: 18.6 },
    { code: "00943",  name: "兆豐電子高息等權",        region: "台灣", sector: "高股息",   dividendYield: 5.8,  return1y: 14.2 },
    { code: "00947",  name: "台新台灣IC設計動能ETF",  region: "台灣", sector: "半導體",   dividendYield: 0.8,  return1y: 28.4 },
    // ---- 高股息 ----
    { code: "0056",   name: "元大高股息",              region: "台灣", sector: "高股息",   dividendYield: 6.2,  return1y: 12.4 },
    { code: "00878",  name: "國泰永續高股息",          region: "台灣", sector: "高股息",   dividendYield: 5.8,  return1y: 13.7 },
    { code: "00919",  name: "群益台灣精選高息",        region: "台灣", sector: "高股息",   dividendYield: 8.4,  return1y: 14.2 },
    { code: "00929",  name: "復華台灣科技優息",        region: "台灣", sector: "高股息",   dividendYield: 8.8,  return1y: 13.8 },
    { code: "00713",  name: "元大台灣高息低波",        region: "台灣", sector: "高股息",   dividendYield: 5.4,  return1y: 11.6 },
    { code: "00900",  name: "富邦特選高股息30",        region: "台灣", sector: "高股息",   dividendYield: 7.2,  return1y: 12.8 },
    { code: "00907",  name: "永豐優息存股",            region: "台灣", sector: "高股息",   dividendYield: 6.8,  return1y: 11.4 },
    { code: "00915",  name: "凱基優選高股息30",        region: "台灣", sector: "高股息",   dividendYield: 7.4,  return1y: 13.2 },
    { code: "00918",  name: "大華優利高填息30",        region: "台灣", sector: "高股息",   dividendYield: 6.6,  return1y: 12.6 },
    { code: "00730",  name: "富邦台灣優質高息",        region: "台灣", sector: "高股息",   dividendYield: 5.8,  return1y: 11.8 },
    { code: "00934",  name: "中信成長高股息",          region: "台灣", sector: "高股息",   dividendYield: 7.6,  return1y: 13.4 },
    { code: "00936",  name: "台新永續高息中小型ETF",  region: "台灣", sector: "高股息",   dividendYield: 7.8,  return1y: 14.6 },
    { code: "00961",  name: "FT台灣永續高息",          region: "台灣", sector: "高股息",   dividendYield: 6.4,  return1y: 12.2 },
    // ---- ESG ----
    { code: "00888",  name: "永豐台灣ESG",             region: "台灣", sector: "ESG",      dividendYield: 2.8,  return1y: 19.8 },
    { code: "00850",  name: "元大台灣ESG永續",         region: "台灣", sector: "ESG",      dividendYield: 2.4,  return1y: 18.4 },
    { code: "00927",  name: "群益半導體收益",          region: "台灣", sector: "半導體",   dividendYield: 4.2,  return1y: 28.6 },
    // ---- 科技/產業 ----
    { code: "0052",   name: "富邦科技",                region: "台灣", sector: "科技",     dividendYield: 1.8,  return1y: 28.4 },
    { code: "0053",   name: "元大電子",                region: "台灣", sector: "科技",     dividendYield: 1.6,  return1y: 24.8 },
    { code: "0055",   name: "元大MSCI金融",            region: "台灣", sector: "金融",     dividendYield: 3.8,  return1y: 14.2 },
    // ---- 主動式 ----
    { code: "00400A", name: "主動國泰動能高息",        region: "台灣", sector: "主動式",   dividendYield: 6.8,  return1y: 15.4 },
    { code: "00401A", name: "主動摩根台灣紅收",        region: "台灣", sector: "主動式",   dividendYield: 5.8,  return1y: 13.8 },
    { code: "00403A", name: "主動統一升級50",          region: "台灣", sector: "主動式",   dividendYield: 2.4,  return1y: 22.4 },
    { code: "00404A", name: "主動聯博動能50",          region: "台灣", sector: "主動式",   dividendYield: 2.2,  return1y: 21.8 },
    { code: "00405A", name: "主動富邦台灣龍頭",        region: "台灣", sector: "主動式",   dividendYield: 2.6,  return1y: 20.4 },
    { code: "00406A", name: "主動中信台灣收益",        region: "台灣", sector: "主動式",   dividendYield: 5.4,  return1y: 14.8 },
    // ---- 台灣債券 ETF ----
    { code: "00679B", name: "元大美債20年",            region: "美國", sector: "債券",     dividendYield: 3.8,  return1y: -1.8 },
    { code: "00696B", name: "富邦美債7-10",            region: "美國", sector: "債券",     dividendYield: 3.4,  return1y: 0.8  },
    { code: "00720B", name: "元大投資級公司債",        region: "美國", sector: "債券",     dividendYield: 4.2,  return1y: 2.4  },
    { code: "00725B", name: "國泰投資級公司債",        region: "美國", sector: "債券",     dividendYield: 4.0,  return1y: 2.2  },
    { code: "00740B", name: "元大美債7-10",            region: "美國", sector: "債券",     dividendYield: 3.6,  return1y: 1.2  },
    { code: "00751B", name: "元大AAA至A公司債",        region: "美國", sector: "債券",     dividendYield: 3.8,  return1y: 2.0  },
    { code: "00761B", name: "元大美債1-3",             region: "美國", sector: "債券",     dividendYield: 4.8,  return1y: 4.2  },
    { code: "00772B", name: "中信高評級公司債",        region: "全球", sector: "債券",     dividendYield: 4.4,  return1y: 2.8  },
    { code: "00779B", name: "凱基美債25年以上",        region: "美國", sector: "債券",     dividendYield: 3.6,  return1y: -2.4 },
    // ---- 美股 ETF ----
    { code: "VOO",   name: "Vanguard S&P 500 ETF",                      region: "美國", sector: "市值型",   dividendYield: 1.3,  return1y: 24.1 },
    { code: "VTI",   name: "Vanguard Total Stock Market ETF",            region: "美國", sector: "市值型",   dividendYield: 1.3,  return1y: 23.5 },
    { code: "SPY",   name: "SPDR S&P 500 ETF Trust",                    region: "美國", sector: "市值型",   dividendYield: 1.2,  return1y: 24.0 },
    { code: "IVV",   name: "iShares Core S&P 500 ETF",                  region: "美國", sector: "市值型",   dividendYield: 1.2,  return1y: 24.1 },
    { code: "SPLG",  name: "SPDR Portfolio S&P 500 ETF",                region: "美國", sector: "市值型",   dividendYield: 1.3,  return1y: 24.0 },
    { code: "DIA",   name: "SPDR Dow Jones Industrial Average ETF",     region: "美國", sector: "市值型",   dividendYield: 1.7,  return1y: 15.8 },
    { code: "IWM",   name: "iShares Russell 2000 ETF",                  region: "美國", sector: "小型股",   dividendYield: 1.2,  return1y: 12.9 },
    { code: "QQQ",   name: "Invesco QQQ Trust",                          region: "美國", sector: "科技",     dividendYield: 0.6,  return1y: 29.4 },
    { code: "QQQM",  name: "Invesco NASDAQ 100 ETF",                    region: "美國", sector: "科技",     dividendYield: 0.6,  return1y: 29.4 },
    { code: "VUG",   name: "Vanguard Growth ETF",                       region: "美國", sector: "成長型",   dividendYield: 0.5,  return1y: 27.8 },
    { code: "VGT",   name: "Vanguard Information Technology ETF",       region: "美國", sector: "科技",     dividendYield: 0.6,  return1y: 30.5 },
    { code: "XLK",   name: "Technology Select Sector SPDR Fund",        region: "美國", sector: "科技",     dividendYield: 0.7,  return1y: 31.2 },
    { code: "ARKK",  name: "ARK Innovation ETF",                        region: "美國", sector: "創新科技", dividendYield: 0,    return1y: 12.6 },
    { code: "SCHD",  name: "Schwab US Dividend Equity ETF",             region: "美國", sector: "高股息",   dividendYield: 3.4,  return1y: 14.2 },
    { code: "VYM",   name: "Vanguard High Dividend Yield ETF",          region: "美國", sector: "高股息",   dividendYield: 2.9,  return1y: 15.1 },
    { code: "VTV",   name: "Vanguard Value ETF",                        region: "美國", sector: "價值型",   dividendYield: 2.2,  return1y: 16.3 },
    { code: "JEPI",  name: "JPMorgan Equity Premium Income ETF",        region: "美國", sector: "高股息",   dividendYield: 7.8,  return1y: 11.5 },
    { code: "SOXX",  name: "iShares Semiconductor ETF",                 region: "美國", sector: "半導體",   dividendYield: 0.8,  return1y: 38.4 },
    { code: "SMH",   name: "VanEck Semiconductor ETF",                  region: "全球", sector: "半導體",   dividendYield: 0.6,  return1y: 41.2 },
    { code: "XLF",   name: "Financial Select Sector SPDR Fund",         region: "美國", sector: "金融",     dividendYield: 1.6,  return1y: 18.9 },
    { code: "XLE",   name: "Energy Select Sector SPDR Fund",            region: "美國", sector: "能源",     dividendYield: 3.3,  return1y: 8.6  },
    { code: "XLV",   name: "Health Care Select Sector SPDR Fund",       region: "美國", sector: "醫療保健", dividendYield: 1.5,  return1y: 9.8  },
    { code: "XLI",   name: "Industrial Select Sector SPDR Fund",        region: "美國", sector: "工業",     dividendYield: 1.4,  return1y: 17.3 },
    { code: "XLY",   name: "Consumer Discretionary Select Sector SPDR", region: "美國", sector: "消費",     dividendYield: 0.7,  return1y: 22.7 },
    { code: "XLP",   name: "Consumer Staples Select Sector SPDR",       region: "美國", sector: "民生消費", dividendYield: 2.5,  return1y: 7.4  },
    { code: "XLU",   name: "Utilities Select Sector SPDR Fund",         region: "美國", sector: "公用事業", dividendYield: 3.0,  return1y: 19.2 },
    { code: "XLRE",  name: "Real Estate Select Sector SPDR Fund",       region: "美國", sector: "不動產",   dividendYield: 3.4,  return1y: 6.1  },
    // ---- 全球/國際 ETF ----
    { code: "VT",    name: "Vanguard Total World Stock ETF",            region: "全球",     sector: "市值型", dividendYield: 1.8, return1y: 19.6 },
    { code: "VXUS",  name: "Vanguard Total International Stock ETF",    region: "全球",     sector: "市值型", dividendYield: 2.8, return1y: 14.2 },
    { code: "VEA",   name: "Vanguard FTSE Developed Markets ETF",       region: "已開發市場",sector: "市值型", dividendYield: 2.7, return1y: 13.8 },
    { code: "VWO",   name: "Vanguard FTSE Emerging Markets ETF",        region: "新興市場", sector: "市值型", dividendYield: 3.1, return1y: 11.4 },
    { code: "EEM",   name: "iShares MSCI Emerging Markets ETF",         region: "新興市場", sector: "市值型", dividendYield: 2.9, return1y: 10.7 },
    { code: "EWT",   name: "iShares MSCI Taiwan ETF",                   region: "台灣",     sector: "市值型", dividendYield: 2.3, return1y: 23.8 },
    { code: "EWJ",   name: "iShares MSCI Japan ETF",                    region: "日本",     sector: "市值型", dividendYield: 1.9, return1y: 17.6 },
    { code: "MCHI",  name: "iShares MSCI China ETF",                    region: "中國",     sector: "市值型", dividendYield: 2.4, return1y: 9.1  },
    { code: "FXI",   name: "iShares China Large-Cap ETF",               region: "中國",     sector: "市值型", dividendYield: 2.6, return1y: 7.8  },
    { code: "INDA",  name: "iShares MSCI India ETF",                    region: "印度",     sector: "市值型", dividendYield: 1.0, return1y: 19.4 },
    // ---- 債券 ETF ----
    { code: "BND",   name: "Vanguard Total Bond Market ETF",            region: "美國", sector: "債券", dividendYield: 4.1, return1y: 3.8  },
    { code: "AGG",   name: "iShares Core U.S. Aggregate Bond ETF",      region: "美國", sector: "債券", dividendYield: 4.0, return1y: 3.6  },
    { code: "BNDX",  name: "Vanguard Total International Bond ETF",     region: "全球", sector: "債券", dividendYield: 3.2, return1y: 2.9  },
    { code: "LQD",   name: "iShares iBoxx IG Corp Bond ETF",            region: "美國", sector: "債券", dividendYield: 4.5, return1y: 4.2  },
    { code: "TLT",   name: "iShares 20+ Year Treasury Bond ETF",        region: "美國", sector: "債券", dividendYield: 3.9, return1y: -2.1 },
    // ---- 大宗商品 ETF ----
    { code: "GLD",   name: "SPDR Gold Shares",                          region: "全球", sector: "大宗商品", dividendYield: 0, return1y: 28.3 },
    { code: "SLV",   name: "iShares Silver Trust",                      region: "全球", sector: "大宗商品", dividendYield: 0, return1y: 21.6 },
    { code: "USO",   name: "United States Oil Fund",                    region: "全球", sector: "大宗商品", dividendYield: 0, return1y: -4.2 },
    // ---- 槓桿/反向 ETF ----
    { code: "TQQQ",  name: "ProShares UltraPro QQQ",                   region: "美國", sector: "槓桿型", dividendYield: 0, return1y: 68.3  },
    { code: "SQQQ",  name: "ProShares UltraPro Short QQQ",             region: "美國", sector: "反向型", dividendYield: 0, return1y: -42.7 },
  ];
  
  export const ETF_LIST: Etf[] = RAW.map(r => ({
    code: r.code,
    name: r.name,
    region: r.region,
    sector: r.sector,
    dividendPerUnit: r.dividendYield > 0
      ? parseFloat((r.dividendYield * 0.18).toFixed(2))
      : 0,
    dividendYield: r.dividendYield,
    dividendFreq: freq(r.sector, r.dividendYield),
    returnYTD:  parseFloat((r.return1y * 0.52).toFixed(1)),
    return1m:   parseFloat((r.return1y * 0.08).toFixed(1)),
    return3m:   parseFloat((r.return1y * 0.22).toFixed(1)),
    return6m:   parseFloat((r.return1y * 0.40).toFixed(1)),
    return1y:   r.return1y,
    return3y:   parseFloat((r.return1y * 2.4).toFixed(1)),
    volatility: r.sector === "高股息" ? parseFloat((Math.abs(r.return1y) * 0.55 + 4).toFixed(1))
              : r.sector === "債券"   ? parseFloat((Math.abs(r.return1y) * 0.35 + 2).toFixed(1))
              : r.sector === "槓桿型" ? parseFloat((Math.abs(r.return1y) * 0.8).toFixed(1))
              : parseFloat((Math.abs(r.return1y) * 0.62 + 5).toFixed(1)),
  }));
  
  export const REGIONS = Array.from(new Set(ETF_LIST.map(e => e.region)));
  export const SECTORS = Array.from(new Set(ETF_LIST.map(e => e.sector)));