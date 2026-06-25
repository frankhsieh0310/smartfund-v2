// ============================================================
// lib/data/marketData.ts
// SmartMatch 全球市場資料集中管理
// ============================================================

export type MarketItem = {
  id: string; name: string; value: string; pts: string; pct: string; up: boolean;
};

export type MarketGroup = {
  id: string; label: string; sublabel: string; emoji: string;
  main: MarketItem[]; more: MarketItem[];
};

export const MARKET_GROUPS: MarketGroup[] = [
  { id:"tw", label:"台灣市場", sublabel:"TAIWAN", emoji:"🇹🇼",
    main:[
      { id:"taiex", name:"加權指數",   value:"22,184", pts:"+184.32", pct:"+0.84%", up:true },
      { id:"txf",   name:"台指期近月", value:"22,210", pts:"+128.00", pct:"+0.58%", up:true },
      { id:"0050",  name:"元大台灣50", value:"198.45", pts:"+1.42",   pct:"+0.72%", up:true },
    ],
    more:[
      { id:"otc",    name:"櫃買指數", value:"248.32", pts:"+1.85",  pct:"+0.75%", up:true },
      { id:"finidx", name:"金融指數", value:"2,184",  pts:"+12.40", pct:"+0.57%", up:true },
      { id:"elec",   name:"電子指數", value:"1,092",  pts:"+9.84",  pct:"+0.91%", up:true },
    ],
  },
  { id:"us", label:"美國市場", sublabel:"UNITED STATES", emoji:"🇺🇸",
    main:[
      { id:"djia",   name:"道瓊工業", value:"43,408", pts:"+228.41", pct:"+0.53%", up:true },
      { id:"nasdaq", name:"NASDAQ",   value:"19,271", pts:"+162.25", pct:"+0.85%", up:true },
      { id:"sp500",  name:"S&P 500",  value:"5,842",  pts:"+39.52",  pct:"+0.68%", up:true },
    ],
    more:[
      { id:"sox", name:"費城半導體",    value:"5,124", pts:"+62.10", pct:"+1.23%", up:true  },
      { id:"rut", name:"Russell 2000", value:"2,218", pts:"-6.89",  pct:"-0.31%", up:false },
      { id:"vix", name:"VIX 恐慌指數", value:"13.42", pts:"-0.16",  pct:"-1.19%", up:false },
    ],
  },
  { id:"asia", label:"亞洲市場", sublabel:"ASIA", emoji:"🌏",
    main:[
      { id:"nikkei", name:"日經 225",   value:"39,842", pts:"+411.24", pct:"+1.04%", up:true  },
      { id:"kospi",  name:"韓國 KOSPI", value:"2,621",  pts:"+15.92",  pct:"+0.61%", up:true  },
      { id:"hsi",    name:"恒生指數",   value:"23,184", pts:"-109.60", pct:"-0.47%", up:false },
    ],
    more:[
      { id:"sse",  name:"上證指數", value:"3,412",  pts:"+7.48",  pct:"+0.22%", up:true },
      { id:"szse", name:"深圳成指", value:"10,824", pts:"+98.42", pct:"+0.92%", up:true },
      { id:"sti",  name:"新加坡",   value:"3,822",  pts:"+18.40", pct:"+0.48%", up:true },
    ],
  },
  { id:"eu", label:"歐洲市場", sublabel:"EUROPE", emoji:"🇪🇺",
    main:[
      { id:"dax",  name:"德國 DAX",      value:"22,854", pts:"+100.56", pct:"+0.44%", up:true },
      { id:"ftse", name:"英國 FTSE 100", value:"8,732",  pts:"+24.44",  pct:"+0.28%", up:true },
      { id:"cac",  name:"法國 CAC 40",   value:"7,981",  pts:"+15.16",  pct:"+0.19%", up:true },
    ],
    more:[
      { id:"stoxx", name:"Euro STOXX 50", value:"5,312",  pts:"+18.60", pct:"+0.35%", up:true },
      { id:"smi",   name:"瑞士 SMI",      value:"12,184", pts:"+48.24", pct:"+0.40%", up:true },
      { id:"mib",   name:"義大利 MIB",    value:"38,420", pts:"+84.12", pct:"+0.22%", up:true },
    ],
  },
  { id:"cmd", label:"商品市場", sublabel:"COMMODITIES", emoji:"🥇",
    main:[
      { id:"xau",   name:"黃金 XAU",   value:"3,342", pts:"+30.18", pct:"+0.91%", up:true  },
      { id:"wti",   name:"WTI 原油",   value:"71.28", pts:"-0.60",  pct:"-0.83%", up:false },
      { id:"brent", name:"布蘭特原油", value:"74.52", pts:"-0.53",  pct:"-0.71%", up:false },
    ],
    more:[
      { id:"xag",    name:"白銀",   value:"32.84", pts:"+0.37", pct:"+1.14%", up:true  },
      { id:"copper", name:"銅",     value:"4.52",  pts:"+0.02", pct:"+0.44%", up:true  },
      { id:"natgas", name:"天然氣", value:"2.18",  pts:"-0.04", pct:"-1.80%", up:false },
    ],
  },
];

export type HotItem = {
  rank: number; code?: string; company?: string;
  name: string; flow: string; change: string; up: boolean;
};

export const ETF_HOT: HotItem[] = [
  { rank:1,  code:"0050",   name:"元大台灣50",           flow:"+125.3億", change:"+0.72%", up:true  },
  { rank:2,  code:"00878",  name:"國泰永續高股息",         flow:"+98.7億",  change:"+0.45%", up:true  },
  { rank:3,  code:"00919",  name:"群益台灣精選高息",       flow:"+76.2億",  change:"+0.38%", up:true  },
  { rank:4,  code:"00940",  name:"元大台灣價值高息",       flow:"+54.8億",  change:"+1.24%", up:true  },
  { rank:5,  code:"VOO",    name:"Vanguard S&P 500",     flow:"+48.3億",  change:"+0.68%", up:true  },
  { rank:6,  code:"QQQ",    name:"Invesco NASDAQ 100",   flow:"+38.1億",  change:"+0.85%", up:true  },
  { rank:7,  code:"00713",  name:"元大台灣高息低波",       flow:"+29.4億",  change:"+0.43%", up:true  },
  { rank:8,  code:"VTI",    name:"Vanguard Total Mkt",   flow:"+22.2億",  change:"+0.59%", up:true  },
  { rank:9,  code:"SOXX",   name:"iShares 半導體",        flow:"+18.9億",  change:"+1.23%", up:true  },
  { rank:10, code:"00679B", name:"元大美債20年",           flow:"+14.8億",  change:"-0.32%", up:false },
];

export const FUND_HOT: HotItem[] = [
  { rank:1,  company:"安聯",   name:"安聯台灣科技基金",   flow:"+45.7億", change:"+1.25%", up:true },
  { rank:2,  company:"復華",   name:"復華全球物聯網基金", flow:"+32.2億", change:"+0.98%", up:true },
  { rank:3,  company:"國泰",   name:"國泰台灣5G+基金",    flow:"+28.9億", change:"+1.12%", up:true },
  { rank:4,  company:"聯博",   name:"聯博全球高收益債券", flow:"+24.3億", change:"+0.42%", up:true },
  { rank:5,  company:"富達",   name:"富達基金－美國基金", flow:"+21.9億", change:"+0.81%", up:true },
  { rank:6,  company:"摩根",   name:"摩根美國科技基金",   flow:"+19.2億", change:"+1.14%", up:true },
  { rank:7,  company:"安聯",   name:"安聯收益成長基金",   flow:"+16.4億", change:"+0.38%", up:true },
  { rank:8,  company:"貝萊德", name:"貝萊德世界科技基金", flow:"+13.9億", change:"+0.92%", up:true },
  { rank:9,  company:"野村",   name:"野村亞太高股息基金", flow:"+11.2億", change:"+0.44%", up:true },
  { rank:10, company:"施羅德", name:"施羅德環球股息收益", flow:"+9.2億",  change:"+0.55%", up:true },
];
