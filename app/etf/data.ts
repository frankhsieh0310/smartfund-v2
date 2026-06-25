// ============================================================
// lib/data/etfData.ts
// SmartMatch ETF 集中資料源
// 所有 ETF 資料統一從此檔案引用，禁止各頁面獨立定義
// ============================================================

export type Etf = {
    // 基本資訊
    code:         string;   // ETF 代碼，例如 "0050"
    name:         string;   // 中文名稱
    region:       string;   // 地區：台灣/美國/全球/亞洲/日本/歐洲...
    sector:       string;   // 類型：市值型/高股息/科技/債券/半導體...
  
    // 配息資訊
    dividendPerUnit: number; // 每單位配息金額
    dividendYield:   number; // 殖利率 %
    dividendFreq:    string; // 配息頻率：季配/月配/年配/不配息
  
    // 績效 %（正負值，例如 12.5 代表 +12.5%）
    returnYTD:  number; // 今年以來
    return1m:   number; // 近1個月
    return3m:   number; // 近3個月
    return6m:   number; // 近6個月
    return1y:   number; // 近1年
    return3y:   number; // 近3年累計
  
    // 風險指標
    volatility: number; // 年化波動度 %
  };
  
  // ── ETF 資料集 ────────────────────────────────────────────────────────
  // 共 95 檔，涵蓋台股、美股、全球、亞洲、債券、商品等類型
  // 資料為示意數值，正式版將接入即時 API
  // ── 台灣市值型 ETF ────────────────────────────────────────────────────
  const RAW: Omit<Etf, "return3y" | "volatility"> & { return3y: number; volatility: number }[] = [
    // 台灣市值型
    { code:"0050",   name:"元大台灣50",             region:"台灣", sector:"市值型",   dividendPerUnit:3.40, dividendYield:1.7, dividendFreq:"季配", returnYTD:21.6, return1m:3.8, return3m:8.2, return6m:14.1, return1y:38.4, return3y:89.2, volatility:16.8 },
    { code:"006208", name:"富邦台灣50",             region:"台灣", sector:"市值型",   dividendPerUnit:2.80, dividendYield:1.4, dividendFreq:"季配", returnYTD:21.2, return1m:3.7, return3m:8.0, return6m:13.8, return1y:37.9, return3y:88.1, volatility:16.7 },
    { code:"00733",  name:"富邦台灣中小",           region:"台灣", sector:"市值型",   dividendPerUnit:1.20, dividendYield:1.1, dividendFreq:"年配", returnYTD:15.2, return1m:2.4, return3m:5.8, return6m:9.2,  return1y:28.4, return3y:62.1, volatility:19.2 },
    { code:"006204", name:"永豐台灣加權",           region:"台灣", sector:"市値型",   dividendPerUnit:0.80, dividendYield:0.9, dividendFreq:"年配", returnYTD:20.8, return1m:3.6, return3m:7.9, return6m:13.5, return1y:37.2, return3y:85.4, volatility:16.9 },
    { code:"00850",  name:"元大台灣ESG永續",        region:"台灣", sector:"市值型",   dividendPerUnit:1.60, dividendYield:1.5, dividendFreq:"季配", returnYTD:18.4, return1m:3.1, return3m:7.0, return6m:11.8, return1y:32.6, return3y:74.2, volatility:17.4 },
    // 台灣高股息 ETF
    { code:"00878",  name:"國泰永續高股息",         region:"台灣", sector:"高股息",   dividendPerUnit:0.34, dividendYield:7.8, dividendFreq:"季配", returnYTD:12.4, return1m:1.8, return3m:4.2, return6m:7.8,  return1y:18.6, return3y:42.8, volatility:13.2 },
    { code:"00919",  name:"群益台灣精選高息",       region:"台灣", sector:"高股息",   dividendPerUnit:0.42, dividendYield:8.4, dividendFreq:"月配", returnYTD:14.2, return1m:2.1, return3m:5.0, return6m:9.1,  return1y:21.8, return3y:48.4, volatility:14.1 },
    { code:"00940",  name:"元大台灣價值高息",       region:"台灣", sector:"高股息",   dividendPerUnit:0.38, dividendYield:8.1, dividendFreq:"月配", returnYTD:13.8, return1m:2.0, return3m:4.8, return6m:8.8,  return1y:20.9, return3y:46.2, volatility:13.8 },
    { code:"00713",  name:"元大台灣高息低波",       region:"台灣", sector:"高股息",   dividendPerUnit:0.46, dividendYield:6.9, dividendFreq:"季配", returnYTD:11.2, return1m:1.6, return3m:3.8, return6m:7.0,  return1y:16.8, return3y:38.4, volatility:11.8 },
    { code:"00929",  name:"復華台灣科技優息",       region:"台灣", sector:"高股息",   dividendPerUnit:0.35, dividendYield:8.8, dividendFreq:"月配", returnYTD:16.2, return1m:2.4, return3m:5.8, return6m:10.4, return1y:24.6, return3y:52.1, volatility:15.2 },
    { code:"00701",  name:"國泰股利精選30",         region:"台灣", sector:"高股息",   dividendPerUnit:0.68, dividendYield:6.4, dividendFreq:"半年配",returnYTD:10.8, return1m:1.5, return3m:3.6, return6m:6.8,  return1y:16.2, return3y:36.8, volatility:12.4 },
    { code:"00900",  name:"富邦特選高股息30",       region:"台灣", sector:"高股息",   dividendPerUnit:0.41, dividendYield:7.6, dividendFreq:"季配", returnYTD:12.8, return1m:1.9, return3m:4.4, return6m:8.1,  return1y:19.2, return3y:44.1, volatility:13.6 },
    // 台灣科技 ETF
    { code:"00881",  name:"國泰台灣5G+",           region:"台灣", sector:"科技",     dividendPerUnit:0.52, dividendYield:2.4, dividendFreq:"季配", returnYTD:28.4, return1m:4.8, return3m:10.2, return6m:18.4, return1y:42.6, return3y:94.8, volatility:22.4 },
    { code:"00922",  name:"國泰台灣半導體",         region:"台灣", sector:"半導體",   dividendPerUnit:0.28, dividendYield:1.2, dividendFreq:"季配", returnYTD:32.1, return1m:5.4, return3m:11.8, return6m:21.2, return1y:48.4, return3y:106.2,volatility:24.8 },
    { code:"00913",  name:"兆豐台灣晶圓製造ETF",   region:"台灣", sector:"半導體",   dividendPerUnit:0.25, dividendYield:1.0, dividendFreq:"季配", returnYTD:30.8, return1m:5.1, return3m:11.2, return6m:20.1, return1y:46.2, return3y:101.8,volatility:24.1 },
    { code:"00904",  name:"新光臺灣半導體30",       region:"台灣", sector:"半導體",   dividendPerUnit:0.18, dividendYield:0.8, dividendFreq:"季配", returnYTD:31.4, return1m:5.2, return3m:11.5, return6m:20.6, return1y:47.2, return3y:104.1,volatility:24.4 },
    { code:"00891",  name:"中信關鍵半導體",         region:"台灣", sector:"半導體",   dividendPerUnit:0.22, dividendYield:0.9, dividendFreq:"季配", returnYTD:29.8, return1m:4.9, return3m:10.8, return6m:19.4, return1y:44.8, return3y:98.4, volatility:23.8 },
    { code:"00830",  name:"國泰費城半導體",         region:"台灣", sector:"半導體",   dividendPerUnit:0.14, dividendYield:0.6, dividendFreq:"年配", returnYTD:34.2, return1m:5.8, return3m:12.4, return6m:22.4, return1y:52.1, return3y:114.8,volatility:26.2 },
    // 美國 ETF
    { code:"VOO",    name:"Vanguard S&P 500",       region:"美國", sector:"市值型",   dividendPerUnit:1.68, dividendYield:1.3, dividendFreq:"季配", returnYTD:18.4, return1m:3.2, return3m:7.4, return6m:12.8, return1y:31.2, return3y:68.4, volatility:15.2 },
    { code:"VTI",    name:"Vanguard Total Market",  region:"美國", sector:"市值型",   dividendPerUnit:1.42, dividendYield:1.2, dividendFreq:"季配", returnYTD:17.8, return1m:3.0, return3m:7.1, return6m:12.2, return1y:29.8, return3y:65.4, volatility:15.4 },
    { code:"QQQ",    name:"Invesco NASDAQ 100",      region:"美國", sector:"科技",     dividendPerUnit:0.82, dividendYield:0.6, dividendFreq:"季配", returnYTD:24.8, return1m:4.2, return3m:9.8, return6m:17.4, return1y:38.6, return3y:84.2, volatility:19.8 },
    { code:"SPY",    name:"SPDR S&P 500",            region:"美國", sector:"市值型",   dividendPerUnit:1.72, dividendYield:1.3, dividendFreq:"季配", returnYTD:18.2, return1m:3.1, return3m:7.2, return6m:12.6, return1y:30.8, return3y:67.4, volatility:15.3 },
    { code:"IVV",    name:"iShares S&P 500",         region:"美國", sector:"市値型",   dividendPerUnit:1.70, dividendYield:1.3, dividendFreq:"季配", returnYTD:18.3, return1m:3.1, return3m:7.3, return6m:12.7, return1y:31.0, return3y:67.8, volatility:15.2 },
    { code:"VUG",    name:"Vanguard Growth ETF",     region:"美國", sector:"成長型",   dividendPerUnit:0.48, dividendYield:0.4, dividendFreq:"季配", returnYTD:26.4, return1m:4.4, return3m:10.2, return6m:18.2, return1y:40.8, return3y:88.4, volatility:20.2 },
    { code:"SOXX",   name:"iShares 半導體",          region:"美國", sector:"半導體",   dividendPerUnit:1.24, dividendYield:0.8, dividendFreq:"季配", returnYTD:38.4, return1m:6.4, return3m:14.2, return6m:25.8, return1y:58.2, return3y:126.4,volatility:28.4 },
    { code:"SMH",    name:"VanEck Semiconductor",    region:"美國", sector:"半導體",   dividendPerUnit:1.08, dividendYield:0.7, dividendFreq:"季配", returnYTD:36.8, return1m:6.1, return3m:13.6, return6m:24.8, return1y:56.1, return3y:122.8,volatility:27.8 },
    { code:"XLK",    name:"Technology Select SPDR", region:"美國", sector:"科技",     dividendPerUnit:0.64, dividendYield:0.7, dividendFreq:"季配", returnYTD:30.2, return1m:5.1, return3m:11.4, return6m:20.4, return1y:46.8, return3y:101.4,volatility:22.8 },
    { code:"VGT",    name:"Vanguard IT ETF",         region:"美國", sector:"科技",     dividendPerUnit:0.84, dividendYield:0.6, dividendFreq:"季配", returnYTD:29.8, return1m:5.0, return3m:11.2, return6m:20.1, return1y:46.2, return3y:100.8,volatility:22.4 },
    { code:"ARKK",   name:"ARK Innovation ETF",      region:"美國", sector:"主動式",   dividendPerUnit:0.00, dividendYield:0.0, dividendFreq:"不配息",returnYTD:18.4, return1m:2.8, return3m:6.4, return6m:11.2, return1y:28.4, return3y:24.8, volatility:42.8 },
    { code:"SCHD",   name:"Schwab US Dividend",      region:"美國", sector:"高股息",   dividendPerUnit:1.12, dividendYield:3.6, dividendFreq:"季配", returnYTD:14.2, return1m:2.2, return3m:5.4, return6m:9.8,  return1y:22.4, return3y:52.8, volatility:13.2 },
    { code:"DVY",    name:"iShares Dividend Select", region:"美國", sector:"高股息",   dividendPerUnit:2.84, dividendYield:4.8, dividendFreq:"季配", returnYTD:12.8, return1m:2.0, return3m:4.8, return6m:8.8,  return1y:20.1, return3y:46.8, volatility:12.4 },
    { code:"VYM",    name:"Vanguard High Dividend",  region:"美國", sector:"高股息",   dividendPerUnit:1.48, dividendYield:2.8, dividendFreq:"季配", returnYTD:13.4, return1m:2.1, return3m:5.0, return6m:9.2,  return1y:21.2, return3y:49.4, volatility:12.8 },
    // 全球 ETF
    { code:"VT",     name:"Vanguard Total World",    region:"全球", sector:"市值型",   dividendPerUnit:1.24, dividendYield:1.8, dividendFreq:"季配", returnYTD:16.2, return1m:2.8, return3m:6.4, return6m:11.0, return1y:26.4, return3y:58.1, volatility:14.8 },
    { code:"ACWI",   name:"iShares MSCI ACWI",       region:"全球", sector:"市值型",   dividendPerUnit:0.92, dividendYield:1.6, dividendFreq:"季配", returnYTD:15.8, return1m:2.7, return3m:6.2, return6m:10.8, return1y:25.8, return3y:56.8, volatility:14.6 },
    // 美國債券 ETF（台股掛牌）
    { code:"00679B", name:"元大美債20年",            region:"台灣", sector:"債券",     dividendPerUnit:0.14, dividendYield:3.8, dividendFreq:"月配", returnYTD:-1.8, return1m:-0.4, return3m:-0.8, return6m:-1.2, return1y:-3.6, return3y:-8.4, volatility:18.2 },
    { code:"00720B", name:"元大投資級公司債",        region:"台灣", sector:"債券",     dividendPerUnit:0.18, dividendYield:4.2, dividendFreq:"月配", returnYTD:2.4,  return1m:0.4,  return3m:1.2,  return6m:2.0,  return1y:4.8,  return3y:10.2, volatility:8.4 },
    { code:"00646B", name:"元大美債7-10年",          region:"台灣", sector:"債券",     dividendPerUnit:0.12, dividendYield:3.4, dividendFreq:"月配", returnYTD:0.8,  return1m:0.2,  return3m:0.6,  return6m:1.0,  return1y:2.4,  return3y:4.8,  volatility:10.2 },
    { code:"00847B", name:"中信美國公司債20年",      region:"台灣", sector:"債券",     dividendPerUnit:0.16, dividendYield:4.0, dividendFreq:"月配", returnYTD:-1.2, return1m:-0.3, return3m:-0.6, return6m:-1.0, return1y:-2.8, return3y:-6.4, volatility:17.4 },
    // 美國債券 ETF（美股）
    { code:"BND",    name:"Vanguard Total Bond",     region:"美國", sector:"債券",     dividendPerUnit:0.24, dividendYield:4.2, dividendFreq:"月配", returnYTD:1.2,  return1m:0.3,  return3m:0.8,  return6m:1.4,  return1y:3.2,  return3y:6.8,  volatility:6.4 },
    { code:"AGG",    name:"iShares Core US Aggregate",region:"美國",sector:"債券",     dividendPerUnit:0.22, dividendYield:4.1, dividendFreq:"月配", returnYTD:1.0,  return1m:0.3,  return3m:0.7,  return6m:1.2,  return1y:3.0,  return3y:6.4,  volatility:6.2 },
    { code:"LQD",    name:"iShares Investment Grade", region:"美國", sector:"債券",    dividendPerUnit:0.42, dividendYield:4.8, dividendFreq:"月配", returnYTD:1.8,  return1m:0.4,  return3m:1.0,  return6m:1.8,  return1y:4.2,  return3y:8.8,  volatility:8.2 },
    { code:"TLT",    name:"iShares 20+ Year Treasury",region:"美國", sector:"債券",   dividendPerUnit:0.28, dividendYield:4.4, dividendFreq:"月配", returnYTD:-3.2, return1m:-0.6, return3m:-1.2, return6m:-2.0, return1y:-5.8, return3y:-14.2,volatility:20.8 },
    { code:"HYG",    name:"iShares High Yield Corp",  region:"美國", sector:"債券",   dividendPerUnit:0.52, dividendYield:6.2, dividendFreq:"月配", returnYTD:4.8,  return1m:0.8,  return3m:2.2,  return6m:3.8,  return1y:8.4,  return3y:18.2, volatility:8.8 },
    // 亞洲 ETF
    { code:"EWT",    name:"iShares Taiwan ETF",       region:"台灣", sector:"市值型",  dividendPerUnit:0.84, dividendYield:2.4, dividendFreq:"年配", returnYTD:22.4, return1m:3.8, return3m:8.4, return6m:14.8, return1y:36.4, return3y:82.4, volatility:17.4 },
    { code:"EWJ",    name:"iShares MSCI Japan",        region:"日本", sector:"市值型", dividendPerUnit:0.42, dividendYield:2.1, dividendFreq:"半年配",returnYTD:12.4, return1m:2.0, return3m:4.8, return6m:8.4,  return1y:18.2, return3y:42.4, volatility:16.2 },
    { code:"AAXJ",   name:"iShares MSCI Asia ex Japan",region:"亞洲",sector:"市值型", dividendPerUnit:0.62, dividendYield:2.8, dividendFreq:"半年配",returnYTD:14.8, return1m:2.4, return3m:5.6, return6m:9.8,  return1y:22.4, return3y:48.4, volatility:18.4 },
    { code:"EEM",    name:"iShares MSCI Emerging",     region:"新興市場",sector:"市值型",dividendPerUnit:0.58,dividendYield:3.2, dividendFreq:"半年配",returnYTD:12.8, return1m:2.0, return3m:4.8, return6m:8.4,  return1y:19.2, return3y:40.8, volatility:19.2 },
    { code:"INDA",   name:"iShares MSCI India",        region:"印度", sector:"市值型", dividendPerUnit:0.12, dividendYield:0.4, dividendFreq:"年配", returnYTD:18.4, return1m:3.0, return3m:6.8, return6m:11.8, return1y:28.4, return3y:64.8, volatility:20.8 },
    // 更多台灣 ETF
    { code:"00741",  name:"元大超大型ETF",           region:"台灣", sector:"市值型",   dividendPerUnit:1.80, dividendYield:2.2, dividendFreq:"季配", returnYTD:19.8, return1m:3.4, return3m:7.6, return6m:13.2, return1y:34.8, return3y:78.4, volatility:16.2 },
    { code:"006201", name:"元大富櫃50",              region:"台灣", sector:"市值型",   dividendPerUnit:0.60, dividendYield:1.4, dividendFreq:"年配", returnYTD:16.4, return1m:2.8, return3m:6.2, return6m:10.8, return1y:24.8, return3y:56.4, volatility:18.8 },
    { code:"00830",  name:"國泰費城半導體",          region:"台灣", sector:"半導體",   dividendPerUnit:0.14, dividendYield:0.6, dividendFreq:"年配", returnYTD:34.2, return1m:5.8, return3m:12.4, return6m:22.4, return1y:52.1, return3y:114.8,volatility:26.2 },
    { code:"00757",  name:"統一FANG+",              region:"美國", sector:"科技",     dividendPerUnit:0.00, dividendYield:0.0, dividendFreq:"不配息",returnYTD:42.4, return1m:7.2, return3m:15.8, return6m:28.4, return1y:64.8, return3y:138.4,volatility:32.4 },
    { code:"00858",  name:"中信美國地產",            region:"美國", sector:"不動產",   dividendPerUnit:0.42, dividendYield:4.8, dividendFreq:"季配", returnYTD:8.4,  return1m:1.4, return3m:3.2, return6m:5.8,  return1y:12.4, return3y:28.4, volatility:18.4 },
    { code:"00742",  name:"新興市場債",              region:"新興市場",sector:"債券",  dividendPerUnit:0.22, dividendYield:5.2, dividendFreq:"月配", returnYTD:4.8,  return1m:0.8, return3m:2.0, return6m:3.6,  return1y:8.4,  return3y:18.2, volatility:10.4 },
    { code:"00882",  name:"中信中國高股息",          region:"中國", sector:"高股息",   dividendPerUnit:0.48, dividendYield:6.4, dividendFreq:"季配", returnYTD:10.8, return1m:1.8, return3m:4.2, return6m:7.6,  return1y:16.4, return3y:36.8, volatility:22.4 },
    { code:"00712",  name:"復華全球原物料",          region:"全球", sector:"原物料",   dividendPerUnit:0.28, dividendYield:3.4, dividendFreq:"季配", returnYTD:6.8,  return1m:1.1, return3m:2.8, return6m:5.0,  return1y:10.8, return3y:24.4, volatility:20.8 },
    { code:"GLD",    name:"SPDR Gold Shares",         region:"全球", sector:"商品",    dividendPerUnit:0.00, dividendYield:0.0, dividendFreq:"不配息",returnYTD:18.4, return1m:3.1, return3m:7.2, return6m:12.8, return1y:28.4, return3y:48.2, volatility:12.8 },
    { code:"IAU",    name:"iShares Gold Trust",        region:"全球", sector:"商品",   dividendPerUnit:0.00, dividendYield:0.0, dividendFreq:"不配息",returnYTD:18.2, return1m:3.0, return3m:7.0, return6m:12.6, return1y:28.0, return3y:47.8, volatility:12.6 },
    { code:"SLV",    name:"iShares Silver Trust",      region:"全球", sector:"商品",   dividendPerUnit:0.00, dividendYield:0.0, dividendFreq:"不配息",returnYTD:24.8, return1m:4.2, return3m:9.6, return6m:17.2, return1y:38.4, return3y:62.4, volatility:22.4 },
    // 更多美股 ETF
    { code:"XLF",    name:"Financial Select SPDR",    region:"美國", sector:"金融",    dividendPerUnit:0.84, dividendYield:1.8, dividendFreq:"季配", returnYTD:14.8, return1m:2.4, return3m:5.6, return6m:9.8,  return1y:22.4, return3y:52.8, volatility:16.4 },
    { code:"XLE",    name:"Energy Select SPDR",       region:"美國", sector:"能源",    dividendPerUnit:1.24, dividendYield:3.8, dividendFreq:"季配", returnYTD:8.4,  return1m:1.4, return3m:3.2, return6m:5.8,  return1y:12.8, return3y:48.4, volatility:24.8 },
    { code:"XLV",    name:"Health Care Select SPDR",  region:"美國", sector:"醫療",    dividendPerUnit:1.12, dividendYield:1.6, dividendFreq:"季配", returnYTD:10.8, return1m:1.8, return3m:4.2, return6m:7.4,  return1y:16.4, return3y:38.8, volatility:14.2 },
    { code:"XLRE",   name:"Real Estate Select SPDR",  region:"美國", sector:"不動產",  dividendPerUnit:1.08, dividendYield:3.8, dividendFreq:"季配", returnYTD:9.4,  return1m:1.6, return3m:3.8, return6m:6.8,  return1y:14.8, return3y:32.4, volatility:18.8 },
    { code:"XLB",    name:"Materials Select SPDR",    region:"美國", sector:"原物料",  dividendPerUnit:0.64, dividendYield:1.8, dividendFreq:"季配", returnYTD:12.4, return1m:2.0, return3m:4.8, return6m:8.4,  return1y:18.8, return3y:42.4, volatility:18.2 },
    { code:"JETS",   name:"US Global Jets ETF",        region:"美國", sector:"航空",   dividendPerUnit:0.28, dividendYield:1.2, dividendFreq:"季配", returnYTD:6.4,  return1m:1.0, return3m:2.4, return6m:4.4,  return1y:9.8,  return3y:18.4, volatility:28.4 },
    { code:"ICLN",   name:"iShares Global Clean Energy",region:"全球",sector:"潔淨能源",dividendPerUnit:0.14,dividendYield:0.8, dividendFreq:"半年配",returnYTD:-8.4, return1m:-1.4,return3m:-3.2,return6m:-5.8, return1y:-14.2,return3y:-28.4,volatility:28.8 },
    { code:"KWEB",   name:"KraneShares CSI China Internet",region:"中國",sector:"科技",dividendPerUnit:0.00,dividendYield:0.0, dividendFreq:"不配息",returnYTD:18.4, return1m:3.1, return3m:7.2, return6m:12.8, return1y:24.8, return3y:8.4,  volatility:38.4 },
    { code:"EWZ",    name:"iShares MSCI Brazil",       region:"新興市場",sector:"市值型",dividendPerUnit:1.42,dividendYield:8.2,dividendFreq:"半年配",returnYTD:-4.8, return1m:-0.8,return3m:-2.0,return6m:-3.6, return1y:-8.4, return3y:-12.4,volatility:28.8 },
    // 更多台股
    { code:"00906",  name:"TPEX 50",                 region:"台灣", sector:"市值型",   dividendPerUnit:0.42, dividendYield:1.6, dividendFreq:"季配", returnYTD:18.2, return1m:3.1, return3m:7.0, return6m:12.4, return1y:32.4, return3y:72.4, volatility:17.8 },
    { code:"00944",  name:"第一金工業30",            region:"台灣", sector:"市值型",   dividendPerUnit:0.24, dividendYield:1.4, dividendFreq:"季配", returnYTD:14.4, return1m:2.4, return3m:5.6, return6m:9.8,  return1y:21.8, return3y:48.4, volatility:16.4 },
    { code:"00930",  name:"永豐優息存股",            region:"台灣", sector:"高股息",   dividendPerUnit:0.32, dividendYield:7.2, dividendFreq:"月配", returnYTD:12.4, return1m:1.9, return3m:4.6, return6m:8.4,  return1y:18.8, return3y:42.4, volatility:13.4 },
    { code:"00918",  name:"大華優利高填息30",        region:"台灣", sector:"高股息",   dividendPerUnit:0.36, dividendYield:7.8, dividendFreq:"月配", returnYTD:13.2, return1m:2.0, return3m:4.8, return6m:8.8,  return1y:19.8, return3y:44.8, volatility:13.8 },
    { code:"00915",  name:"凱基優選高股息30",        region:"台灣", sector:"高股息",   dividendPerUnit:0.38, dividendYield:8.2, dividendFreq:"月配", returnYTD:13.8, return1m:2.1, return3m:5.0, return6m:9.2,  return1y:20.8, return3y:46.4, volatility:14.2 },
    // 其他
    { code:"TQQQ",   name:"ProShares UltraPro QQQ",  region:"美國", sector:"槓桿型",   dividendPerUnit:0.00, dividendYield:0.0, dividendFreq:"不配息",returnYTD:88.4, return1m:14.8, return3m:32.4, return6m:58.4, return1y:148.4,return3y:184.8,volatility:68.4 },
    { code:"SQQQ",   name:"ProShares UltraPro Short", region:"美國", sector:"反向型",  dividendPerUnit:0.00, dividendYield:0.0, dividendFreq:"不配息",returnYTD:-82.4,return1m:-13.8,return3m:-28.4,return6m:-52.4,return1y:-88.4,return3y:-96.4,volatility:72.4 },
    { code:"SPXS",   name:"Direxion 3X Bear S&P500", region:"美國", sector:"反向型",  dividendPerUnit:0.00, dividendYield:0.0, dividendFreq:"不配息",returnYTD:-48.4,return1m:-8.4, return3m:-18.4,return6m:-32.4,return1y:-62.4,return3y:-88.4,volatility:52.4 },
    { code:"EFA",    name:"iShares MSCI EAFE",        region:"歐洲", sector:"市值型",  dividendPerUnit:1.24, dividendYield:3.2, dividendFreq:"半年配",returnYTD:12.8, return1m:2.1, return3m:5.0, return6m:8.8,  return1y:19.4, return3y:44.8, volatility:14.8 },
    { code:"VEA",    name:"Vanguard Dev Markets",     region:"歐洲", sector:"市值型",  dividendPerUnit:1.18, dividendYield:3.0, dividendFreq:"季配", returnYTD:13.2, return1m:2.2, return3m:5.2, return6m:9.2,  return1y:20.2, return3y:46.4, volatility:14.4 },
    { code:"IEUR",   name:"iShares Core MSCI Europe", region:"歐洲", sector:"市值型",  dividendPerUnit:1.08, dividendYield:3.4, dividendFreq:"半年配",returnYTD:14.8, return1m:2.4, return3m:5.8, return6m:10.4, return1y:22.8, return3y:52.4, volatility:15.2 },
    { code:"FXI",    name:"iShares China Large-Cap",  region:"中國", sector:"市值型",  dividendPerUnit:0.84, dividendYield:4.8, dividendFreq:"半年配",returnYTD:14.8, return1m:2.4, return3m:5.8, return6m:10.4, return1y:22.4, return3y:12.8, volatility:26.4 },
    { code:"MCHI",   name:"iShares MSCI China",       region:"中國", sector:"市值型",  dividendPerUnit:0.68, dividendYield:3.8, dividendFreq:"半年配",returnYTD:16.4, return1m:2.8, return3m:6.4, return6m:11.4, return1y:24.8, return3y:14.2, volatility:28.2 },
    { code:"VPL",    name:"Vanguard Pacific",         region:"亞洲", sector:"市值型",  dividendPerUnit:1.08, dividendYield:2.8, dividendFreq:"季配", returnYTD:14.2, return1m:2.3, return3m:5.5, return6m:9.6,  return1y:21.4, return3y:48.2, volatility:15.8 },
    { code:"ONEQ",   name:"Fidelity NASDAQ Composite",region:"美國", sector:"市值型",  dividendPerUnit:0.44, dividendYield:0.8, dividendFreq:"季配", returnYTD:22.4, return1m:3.8, return3m:8.8, return6m:15.8, return1y:34.8, return3y:76.4, volatility:18.4 },
    { code:"PDBC",   name:"Invesco Commodity ETF",    region:"全球", sector:"商品",    dividendPerUnit:0.00, dividendYield:0.0, dividendFreq:"不配息",returnYTD:4.8,  return1m:0.8, return3m:2.0, return6m:3.6,  return1y:8.4,  return3y:18.4, volatility:18.8 },
    { code:"00891",  name:"中信關鍵半導體",          region:"台灣", sector:"半導體",   dividendPerUnit:0.22, dividendYield:0.9, dividendFreq:"季配", returnYTD:29.8, return1m:4.9, return3m:10.8, return6m:19.4, return1y:44.8, return3y:98.4, volatility:23.8 },
  ];
  
  // 去除重複代碼
  const seen = new Set<string>();
  export const ETF_LIST: Etf[] = RAW
    .filter(r => { if (seen.has(r.code)) return false; seen.add(r.code); return true; })
    .map(r => ({ ...r }));
  
  export const REGIONS  = Array.from(new Set(ETF_LIST.map(e => e.region)));
  export const SECTORS  = Array.from(new Set(ETF_LIST.map(e => e.sector)));
  
  // ── Ranking Service ───────────────────────────────────────────────────
  export type RankTab = "best1y" | "best3y" | "hot30" | "hot90";
  
  export function getEtfRanking(tab: RankTab, topN = 10): Etf[] {
    const list = [...ETF_LIST];
    switch (tab) {
      case "best1y": return list.sort((a,b) => b.return1y - a.return1y).slice(0, topN);
      case "best3y": return list.sort((a,b) => b.return3y - a.return3y).slice(0, topN);
      case "hot30":  return list.sort((a,b) => b.return1m - a.return1m).slice(0, topN);
      case "hot90":  return list.sort((a,b) => b.return3m - a.return3m).slice(0, topN);
      default:       return list.sort((a,b) => b.return1y - a.return1y).slice(0, topN);
    }
  }