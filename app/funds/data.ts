// ============================================================
// lib/data/fundData.ts
// SmartMatch 基金集中資料源
// 所有基金資料統一從此檔案引用，禁止各頁面獨立定義
// ============================================================

export type Fund = {
  // 基本資訊
  id:       string;   // 唯一識別碼
  company:  string;   // 基金公司
  name:     string;   // 基金名稱
  category: string;   // 類別：股票型/債券型/平衡型/貨幣型
  region:   string;   // 投資地區

  // 晨星評等
  morningstar: number; // 1~5

  // 配息資訊
  dividendPerUnit: number; // 每單位配息
  dividendFreq:    string; // 配息頻率
  dividendYieldM:  number; // 月配息率 %
  dividendYieldA:  number; // 約當年化配息率 %

  // 績效 %
  returnYTD:  number;
  return1m:   number;
  return3m:   number;
  return6m:   number;
  return1y:   number;
  return3y:   number;

  // 風險
  volatility: number;
};

const RAW: Fund[] = [
  // ── 安聯 ──────────────────────────────────────────────────
  { id:"alz-001", company:"安聯",   name:"安聯台灣科技基金",         category:"股票型", region:"台灣",   morningstar:5, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:42.4,  return1m:7.1,  return3m:15.8,  return6m:28.4,  return1y:64.8,  return3y:142.4, volatility:24.8 },
  { id:"alz-002", company:"安聯",   name:"安聯收益成長基金",         category:"平衡型", region:"全球",   morningstar:4, dividendPerUnit:0.04, dividendFreq:"月配息", dividendYieldM:0.42,  dividendYieldA:5.1,  returnYTD:12.4,  return1m:2.1,  return3m:5.0,   return6m:8.8,   return1y:18.4,  return3y:42.8,  volatility:10.4 },
  { id:"alz-003", company:"安聯",   name:"安聯全球高股息基金",       category:"股票型", region:"全球",   morningstar:4, dividendPerUnit:0.05, dividendFreq:"月配息", dividendYieldM:0.48,  dividendYieldA:5.8,  returnYTD:14.8,  return1m:2.4,  return3m:5.8,   return6m:10.4,  return1y:22.4,  return3y:52.4,  volatility:13.2 },
  { id:"alz-004", company:"安聯",   name:"安聯歐洲高股息基金",       category:"股票型", region:"歐洲",   morningstar:3, dividendPerUnit:0.06, dividendFreq:"月配息", dividendYieldM:0.52,  dividendYieldA:6.2,  returnYTD:10.8,  return1m:1.8,  return3m:4.2,   return6m:7.4,   return1y:16.4,  return3y:38.4,  volatility:15.8 },
  // ── 聯博 ──────────────────────────────────────────────────
  { id:"ab-001",  company:"聯博",   name:"聯博全球高收益債券基金",   category:"債券型", region:"全球",   morningstar:5, dividendPerUnit:0.06, dividendFreq:"月配息", dividendYieldM:0.56,  dividendYieldA:6.7,  returnYTD:8.4,   return1m:1.4,  return3m:3.2,   return6m:5.8,   return1y:12.4,  return3y:28.4,  volatility:8.2  },
  { id:"ab-002",  company:"聯博",   name:"聯博美國收益基金",         category:"債券型", region:"美國",   morningstar:4, dividendPerUnit:0.05, dividendFreq:"月配息", dividendYieldM:0.52,  dividendYieldA:6.2,  returnYTD:6.8,   return1m:1.1,  return3m:2.6,   return6m:4.8,   return1y:10.2,  return3y:22.4,  volatility:7.4  },
  { id:"ab-003",  company:"聯博",   name:"聯博全球平衡基金",         category:"平衡型", region:"全球",   morningstar:4, dividendPerUnit:0.03, dividendFreq:"月配息", dividendYieldM:0.38,  dividendYieldA:4.6,  returnYTD:14.8,  return1m:2.4,  return3m:5.8,   return6m:10.4,  return1y:22.4,  return3y:51.4,  volatility:11.2 },
  // ── 富達 ──────────────────────────────────────────────────
  { id:"fid-001", company:"富達",   name:"富達基金－美國基金",       category:"股票型", region:"美國",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:28.4,  return1m:4.8,  return3m:10.8,  return6m:19.4,  return1y:44.8,  return3y:98.4,  volatility:18.4 },
  { id:"fid-002", company:"富達",   name:"富達全球收益基金",         category:"平衡型", region:"全球",   morningstar:4, dividendPerUnit:0.05, dividendFreq:"月配息", dividendYieldM:0.46,  dividendYieldA:5.5,  returnYTD:12.4,  return1m:2.0,  return3m:4.8,   return6m:8.6,   return1y:18.2,  return3y:42.1,  volatility:11.4 },
  { id:"fid-003", company:"富達",   name:"富達基金－歐洲基金",       category:"股票型", region:"歐洲",   morningstar:3, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:14.8,  return1m:2.4,  return3m:5.8,   return6m:10.4,  return1y:22.8,  return3y:52.4,  volatility:16.2 },
  // ── 摩根 ──────────────────────────────────────────────────
  { id:"jpm-001", company:"摩根",   name:"摩根美國科技基金",         category:"股票型", region:"美國",   morningstar:5, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:38.4,  return1m:6.4,  return3m:14.2,  return6m:25.8,  return1y:58.4,  return3y:128.4, volatility:24.8 },
  { id:"jpm-002", company:"摩根",   name:"摩根全球股票入息基金",     category:"股票型", region:"全球",   morningstar:4, dividendPerUnit:0.06, dividendFreq:"月配息", dividendYieldM:0.52,  dividendYieldA:6.2,  returnYTD:14.8,  return1m:2.4,  return3m:5.8,   return6m:10.4,  return1y:22.4,  return3y:52.4,  volatility:13.4 },
  { id:"jpm-003", company:"摩根",   name:"摩根亞太入息基金",         category:"股票型", region:"亞洲",   morningstar:4, dividendPerUnit:0.07, dividendFreq:"月配息", dividendYieldM:0.58,  dividendYieldA:7.0,  returnYTD:16.4,  return1m:2.8,  return3m:6.4,   return6m:11.4,  return1y:24.8,  return3y:56.4,  volatility:16.4 },
  // ── 貝萊德 ──────────────────────────────────────────────────
  { id:"blk-001", company:"貝萊德", name:"貝萊德世界科技基金",       category:"股票型", region:"全球",   morningstar:5, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:36.8,  return1m:6.1,  return3m:13.6,  return6m:24.8,  return1y:56.4,  return3y:124.8, volatility:24.2 },
  { id:"blk-002", company:"貝萊德", name:"貝萊德全球配置基金",       category:"平衡型", region:"全球",   morningstar:4, dividendPerUnit:0.03, dividendFreq:"月配息", dividendYieldM:0.32,  dividendYieldA:3.8,  returnYTD:12.4,  return1m:2.1,  return3m:5.0,   return6m:8.8,   return1y:18.8,  return3y:44.2,  volatility:10.8 },
  { id:"blk-003", company:"貝萊德", name:"貝萊德全球政府債券基金",   category:"債券型", region:"全球",   morningstar:3, dividendPerUnit:0.04, dividendFreq:"月配息", dividendYieldM:0.38,  dividendYieldA:4.6,  returnYTD:2.4,   return1m:0.4,  return3m:1.0,   return6m:1.8,   return1y:4.2,   return3y:8.8,   volatility:7.2  },
  // ── 霸菱 ──────────────────────────────────────────────────
  { id:"bar-001", company:"霸菱",   name:"霸菱優先順位資產抵押債券基金",category:"債券型",region:"全球",  morningstar:5, dividendPerUnit:0.05, dividendFreq:"月配息", dividendYieldM:0.50,  dividendYieldA:6.0,  returnYTD:7.4,   return1m:1.2,  return3m:2.8,   return6m:5.2,   return1y:10.8,  return3y:24.4,  volatility:7.8  },
  { id:"bar-002", company:"霸菱",   name:"霸菱亞洲股票型基金",       category:"股票型", region:"亞洲",   morningstar:4, dividendPerUnit:0.04, dividendFreq:"季配息", dividendYieldM:0.12,  dividendYieldA:1.5,  returnYTD:18.4,  return1m:3.1,  return3m:7.2,   return6m:12.8,  return1y:28.4,  return3y:64.8,  volatility:18.4 },
  // ── 施羅德 ──────────────────────────────────────────────────
  { id:"sch-001", company:"施羅德", name:"施羅德環球股息收益基金",   category:"股票型", region:"全球",   morningstar:4, dividendPerUnit:0.07, dividendFreq:"月配息", dividendYieldM:0.60,  dividendYieldA:7.2,  returnYTD:12.8,  return1m:2.1,  return3m:5.0,   return6m:8.8,   return1y:19.2,  return3y:44.8,  volatility:12.8 },
  { id:"sch-002", company:"施羅德", name:"施羅德亞洲高股息股票基金", category:"股票型", region:"亞洲",   morningstar:4, dividendPerUnit:0.08, dividendFreq:"月配息", dividendYieldM:0.65,  dividendYieldA:7.8,  returnYTD:14.2,  return1m:2.3,  return3m:5.5,   return6m:9.8,   return1y:21.4,  return3y:49.4,  volatility:15.4 },
  { id:"sch-003", company:"施羅德", name:"施羅德ISF歐洲股息最大化基金",category:"股票型",region:"歐洲",  morningstar:3, dividendPerUnit:0.09, dividendFreq:"月配息", dividendYieldM:0.72,  dividendYieldA:8.6,  returnYTD:10.4,  return1m:1.7,  return3m:4.0,   return6m:7.2,   return1y:15.8,  return3y:36.4,  volatility:15.8 },
  // ── 野村 ──────────────────────────────────────────────────
  { id:"nom-001", company:"野村",   name:"野村亞太高股息基金",       category:"股票型", region:"亞洲",   morningstar:4, dividendPerUnit:0.08, dividendFreq:"月配息", dividendYieldM:0.62,  dividendYieldA:7.4,  returnYTD:16.4,  return1m:2.7,  return3m:6.4,   return6m:11.4,  return1y:24.8,  return3y:57.4,  volatility:16.2 },
  { id:"nom-002", company:"野村",   name:"野村台灣科技基金",         category:"股票型", region:"台灣",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:44.8,  return1m:7.4,  return3m:16.4,  return6m:29.8,  return1y:68.4,  return3y:148.4, volatility:26.4 },
  { id:"nom-003", company:"野村",   name:"野村全球不動產基金",       category:"股票型", region:"全球",   morningstar:3, dividendPerUnit:0.05, dividendFreq:"月配息", dividendYieldM:0.44,  dividendYieldA:5.3,  returnYTD:8.4,   return1m:1.4,  return3m:3.2,   return6m:5.8,   return1y:12.8,  return3y:29.4,  volatility:16.8 },
  // ── 國泰 ──────────────────────────────────────────────────
  { id:"cat-001", company:"國泰",   name:"國泰台灣5G+基金",          category:"股票型", region:"台灣",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:38.4,  return1m:6.4,  return3m:14.2,  return6m:25.8,  return1y:58.4,  return3y:128.4, volatility:24.8 },
  { id:"cat-002", company:"國泰",   name:"國泰優質債券基金",         category:"債券型", region:"全球",   morningstar:3, dividendPerUnit:0.04, dividendFreq:"月配息", dividendYieldM:0.36,  dividendYieldA:4.3,  returnYTD:3.8,   return1m:0.6,  return3m:1.4,   return6m:2.6,   return1y:5.8,   return3y:12.4,  volatility:6.8  },
  // ── 復華 ──────────────────────────────────────────────────
  { id:"fh-001",  company:"復華",   name:"復華全球物聯網基金",       category:"股票型", region:"全球",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:34.8,  return1m:5.8,  return3m:12.8,  return6m:23.2,  return1y:52.4,  return3y:116.4, volatility:22.4 },
  { id:"fh-002",  company:"復華",   name:"復華台灣科技概念基金",     category:"股票型", region:"台灣",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:40.2,  return1m:6.8,  return3m:15.0,  return6m:27.2,  return1y:62.4,  return3y:138.4, volatility:25.2 },
  // ── 元大 ──────────────────────────────────────────────────
  { id:"yue-001", company:"元大",   name:"元大台灣高科技基金",       category:"股票型", region:"台灣",   morningstar:5, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:46.4,  return1m:7.8,  return3m:17.2,  return6m:31.2,  return1y:71.4,  return3y:154.8, volatility:27.4 },
  { id:"yue-002", company:"元大",   name:"元大多元收益組合基金",     category:"平衡型", region:"全球",   morningstar:3, dividendPerUnit:0.04, dividendFreq:"月配息", dividendYieldM:0.40,  dividendYieldA:4.8,  returnYTD:10.4,  return1m:1.7,  return3m:4.1,   return6m:7.4,   return1y:15.8,  return3y:36.4,  volatility:10.2 },
  // ── 群益 ──────────────────────────────────────────────────
  { id:"grf-001", company:"群益",   name:"群益店頭市場基金",         category:"股票型", region:"台灣",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:28.4,  return1m:4.8,  return3m:10.8,  return6m:19.4,  return1y:44.8,  return3y:98.4,  volatility:20.4 },
  { id:"grf-002", company:"群益",   name:"群益多重收益組合基金",     category:"平衡型", region:"全球",   morningstar:3, dividendPerUnit:0.06, dividendFreq:"月配息", dividendYieldM:0.52,  dividendYieldA:6.2,  returnYTD:9.8,   return1m:1.6,  return3m:3.8,   return6m:6.8,   return1y:14.8,  return3y:34.2,  volatility:9.8  },
  // ── 富邦 ──────────────────────────────────────────────────
  { id:"fub-001", company:"富邦",   name:"富邦台灣高股息基金",       category:"股票型", region:"台灣",   morningstar:4, dividendPerUnit:0.08, dividendFreq:"季配息", dividendYieldM:0.20,  dividendYieldA:2.4,  returnYTD:18.4,  return1m:3.1,  return3m:7.2,   return6m:12.8,  return1y:28.4,  return3y:64.8,  volatility:14.4 },
  { id:"fub-002", company:"富邦",   name:"富邦全球科技基金",         category:"股票型", region:"全球",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:32.8,  return1m:5.5,  return3m:12.2,  return6m:22.0,  return1y:49.8,  return3y:110.4, volatility:23.4 },
  // ── 永豐 ──────────────────────────────────────────────────
  { id:"ysf-001", company:"永豐",   name:"永豐標普500波動加權ETF基金",category:"股票型",region:"美國",   morningstar:3, dividendPerUnit:0.02, dividendFreq:"季配息", dividendYieldM:0.06,  dividendYieldA:0.8,  returnYTD:17.8,  return1m:3.0,  return3m:7.0,   return6m:12.2,  return1y:29.4,  return3y:65.8,  volatility:14.8 },
  // ── 華南 ──────────────────────────────────────────────────
  { id:"hn-001",  company:"華南",   name:"華南永昌亞太基金",         category:"股票型", region:"亞洲",   morningstar:3, dividendPerUnit:0.03, dividendFreq:"年配息", dividendYieldM:0.02,  dividendYieldA:0.3,  returnYTD:14.4,  return1m:2.4,  return3m:5.6,   return6m:9.8,   return1y:21.4,  return3y:49.4,  volatility:17.4 },
  // ── 台新 ──────────────────────────────────────────────────
  { id:"ts-001",  company:"台新",   name:"台新台灣動力基金",         category:"股票型", region:"台灣",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:36.4,  return1m:6.1,  return3m:13.6,  return6m:24.8,  return1y:55.8,  return3y:122.4, volatility:24.2 },
  // ── 中信 ──────────────────────────────────────────────────
  { id:"ctb-001", company:"中信",   name:"中信高評級公司債基金",     category:"債券型", region:"全球",   morningstar:4, dividendPerUnit:0.04, dividendFreq:"月配息", dividendYieldM:0.40,  dividendYieldA:4.8,  returnYTD:4.8,   return1m:0.8,  return3m:1.8,   return6m:3.4,   return1y:7.4,   return3y:16.4,  volatility:7.4  },
  { id:"ctb-002", company:"中信",   name:"中信台灣智慧50基金",       category:"股票型", region:"台灣",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:32.4,  return1m:5.4,  return3m:12.0,  return6m:21.8,  return1y:49.4,  return3y:109.4, volatility:22.4 },
  // ── 統一 ──────────────────────────────────────────────────
  { id:"uni-001", company:"統一",   name:"統一全球新興市場基金",     category:"股票型", region:"新興市場",morningstar:3, dividendPerUnit:0.02, dividendFreq:"年配息", dividendYieldM:0.02,  dividendYieldA:0.2,  returnYTD:12.8,  return1m:2.1,  return3m:4.8,   return6m:8.4,   return1y:19.4,  return3y:44.8,  volatility:20.4 },
  // ── 瀚亞 ──────────────────────────────────────────────────
  { id:"pan-001", company:"瀚亞",   name:"瀚亞印度基金",             category:"股票型", region:"印度",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:22.4,  return1m:3.7,  return3m:8.4,   return6m:14.8,  return1y:34.4,  return3y:78.4,  volatility:22.4 },
  { id:"pan-002", company:"瀚亞",   name:"瀚亞亞洲高股息基金",       category:"股票型", region:"亞洲",   morningstar:4, dividendPerUnit:0.08, dividendFreq:"月配息", dividendYieldM:0.65,  dividendYieldA:7.8,  returnYTD:16.8,  return1m:2.8,  return3m:6.4,   return6m:11.4,  return1y:25.4,  return3y:58.4,  volatility:16.8 },
  // ── 法巴 ──────────────────────────────────────────────────
  { id:"bnp-001", company:"法巴",   name:"法巴百利達靈活策略股票基金",category:"股票型",region:"全球",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:18.4,  return1m:3.1,  return3m:7.2,   return6m:12.8,  return1y:28.4,  return3y:64.8,  volatility:16.4 },
  // ── 富蘭克林 ──────────────────────────────────────────────
  { id:"fra-001", company:"富蘭克林", name:"富蘭克林坦伯頓全球股票收益基金",category:"股票型",region:"全球",morningstar:4, dividendPerUnit:0.05, dividendFreq:"月配息", dividendYieldM:0.48,  dividendYieldA:5.8,  returnYTD:14.8,  return1m:2.4,  return3m:5.8,   return6m:10.4,  return1y:22.4,  return3y:52.4,  volatility:14.4 },
  { id:"fra-002", company:"富蘭克林", name:"富蘭克林穩定月收益基金", category:"平衡型", region:"全球",   morningstar:4, dividendPerUnit:0.06, dividendFreq:"月配息", dividendYieldM:0.54,  dividendYieldA:6.5,  returnYTD:10.4,  return1m:1.7,  return3m:4.1,   return6m:7.4,   return1y:15.8,  return3y:36.4,  volatility:9.8  },
  // ── 歐義銳榮 ──────────────────────────────────────────────
  { id:"inv-001", company:"景順",   name:"景順亞洲高收益債券基金",   category:"債券型", region:"亞洲",   morningstar:4, dividendPerUnit:0.07, dividendFreq:"月配息", dividendYieldM:0.60,  dividendYieldA:7.2,  returnYTD:8.4,   return1m:1.4,  return3m:3.2,   return6m:5.8,   return1y:12.4,  return3y:28.4,  volatility:9.4  },
  { id:"inv-002", company:"景順",   name:"景順美國科技基金",         category:"股票型", region:"美國",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:34.8,  return1m:5.8,  return3m:12.8,  return6m:23.2,  return1y:52.4,  return3y:116.4, volatility:23.8 },
  // ── 宏利 ──────────────────────────────────────────────────
  { id:"mfc-001", company:"宏利",   name:"宏利亞洲債券基金",         category:"債券型", region:"亞洲",   morningstar:4, dividendPerUnit:0.06, dividendFreq:"月配息", dividendYieldM:0.52,  dividendYieldA:6.2,  returnYTD:6.8,   return1m:1.1,  return3m:2.6,   return6m:4.8,   return1y:10.4,  return3y:23.4,  volatility:8.4  },
  { id:"mfc-002", company:"宏利",   name:"宏利印度股票基金",         category:"股票型", region:"印度",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:24.8,  return1m:4.1,  return3m:9.4,   return6m:16.8,  return1y:38.4,  return3y:88.4,  volatility:24.4 },
  // ── 保誠 ──────────────────────────────────────────────────
  { id:"pru-001", company:"保誠",   name:"保誠全球收益基金",         category:"平衡型", region:"全球",   morningstar:3, dividendPerUnit:0.05, dividendFreq:"月配息", dividendYieldM:0.46,  dividendYieldA:5.5,  returnYTD:10.8,  return1m:1.8,  return3m:4.2,   return6m:7.4,   return1y:16.4,  return3y:37.8,  volatility:10.8 },
  // ── 聯博新增 ──────────────────────────────────────────────
  { id:"ab-004",  company:"聯博",   name:"聯博新興市場債券基金",     category:"債券型", region:"新興市場",morningstar:3, dividendPerUnit:0.07, dividendFreq:"月配息", dividendYieldM:0.62,  dividendYieldA:7.4,  returnYTD:8.4,   return1m:1.4,  return3m:3.2,   return6m:5.8,   return1y:12.4,  return3y:28.4,  volatility:11.4 },
  // ── 安聯新增 ──────────────────────────────────────────────
  { id:"alz-005", company:"安聯",   name:"安聯AI智慧基金",           category:"股票型", region:"全球",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:52.4,  return1m:8.8,  return3m:19.4,  return6m:35.2,  return1y:80.4,  return3y:168.4, volatility:32.4 },
  // ── 更多高股息月配息基金 ──────────────────────────────────
  { id:"ab-005",  company:"聯博",   name:"聯博精選收益基金",         category:"債券型", region:"全球",   morningstar:5, dividendPerUnit:0.09, dividendFreq:"月配息", dividendYieldM:0.74,  dividendYieldA:8.9,  returnYTD:9.8,   return1m:1.6,  return3m:3.8,   return6m:6.8,   return1y:14.8,  return3y:34.2,  volatility:8.8  },
  { id:"blk-004", company:"貝萊德", name:"貝萊德全球高收益債券基金", category:"債券型", region:"全球",   morningstar:4, dividendPerUnit:0.08, dividendFreq:"月配息", dividendYieldM:0.68,  dividendYieldA:8.2,  returnYTD:9.4,   return1m:1.6,  return3m:3.6,   return6m:6.4,   return1y:13.8,  return3y:31.4,  volatility:9.2  },
  { id:"sch-004", company:"施羅德", name:"施羅德環球高息股票基金",   category:"股票型", region:"全球",   morningstar:4, dividendPerUnit:0.09, dividendFreq:"月配息", dividendYieldM:0.72,  dividendYieldA:8.6,  returnYTD:13.4,  return1m:2.2,  return3m:5.2,   return6m:9.2,   return1y:20.2,  return3y:46.8,  volatility:13.8 },
  { id:"nom-004", company:"野村",   name:"野村全球高收益債券基金",   category:"債券型", region:"全球",   morningstar:4, dividendPerUnit:0.08, dividendFreq:"月配息", dividendYieldM:0.65,  dividendYieldA:7.8,  returnYTD:8.8,   return1m:1.5,  return3m:3.4,   return6m:6.2,   return1y:13.2,  return3y:29.8,  volatility:9.8  },
  { id:"jpm-004", company:"摩根",   name:"摩根環球動態收益基金",     category:"平衡型", region:"全球",   morningstar:4, dividendPerUnit:0.07, dividendFreq:"月配息", dividendYieldM:0.58,  dividendYieldA:7.0,  returnYTD:11.4,  return1m:1.9,  return3m:4.5,   return6m:8.0,   return1y:17.2,  return3y:39.8,  volatility:9.8  },
  { id:"fra-003", company:"富蘭克林", name:"富蘭克林坦伯頓全球債券基金",category:"債券型",region:"全球", morningstar:3, dividendPerUnit:0.05, dividendFreq:"月配息", dividendYieldM:0.44,  dividendYieldA:5.3,  returnYTD:4.8,   return1m:0.8,  return3m:1.8,   return6m:3.2,   return1y:7.4,   return3y:16.4,  volatility:8.4  },
  // ── 亞洲股票型 ────────────────────────────────────────────
  { id:"fid-004", company:"富達",   name:"富達基金－東南亞基金",     category:"股票型", region:"亞洲",   morningstar:3, dividendPerUnit:0.04, dividendFreq:"年配息", dividendYieldM:0.03,  dividendYieldA:0.4,  returnYTD:14.4,  return1m:2.4,  return3m:5.6,   return6m:9.8,   return1y:21.8,  return3y:49.8,  volatility:18.8 },
  { id:"jpm-005", company:"摩根",   name:"摩根東方科技基金",         category:"股票型", region:"亞洲",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:22.4,  return1m:3.7,  return3m:8.4,   return6m:14.8,  return1y:34.4,  return3y:78.4,  volatility:24.4 },
  { id:"blk-005", company:"貝萊德", name:"貝萊德亞洲老虎基金",       category:"股票型", region:"亞洲",   morningstar:4, dividendPerUnit:0.00, dividendFreq:"不配息", dividendYieldM:0,     dividendYieldA:0,    returnYTD:20.4,  return1m:3.4,  return3m:7.8,   return6m:14.0,  return1y:31.4,  return3y:72.4,  volatility:22.4 },
];

export const FUND_LIST: Fund[] = RAW;

export const COMPANIES  = Array.from(new Set(FUND_LIST.map(f => f.company)));
export const CATEGORIES = Array.from(new Set(FUND_LIST.map(f => f.category)));
export const REGIONS    = Array.from(new Set(FUND_LIST.map(f => f.region)));

// ── Ranking Service ───────────────────────────────────────────────────
export type FundRankTab = "best1y" | "best3y" | "hot30" | "hot90";

export function getFundRanking(tab: FundRankTab, topN = 10): Fund[] {
  const list = [...FUND_LIST];
  switch (tab) {
    case "best1y": return list.sort((a,b) => b.return1y - a.return1y).slice(0, topN);
    case "best3y": return list.sort((a,b) => b.return3y - a.return3y).slice(0, topN);
    case "hot30":  return list.sort((a,b) => b.return1m - a.return1m).slice(0, topN);
    case "hot90":  return list.sort((a,b) => b.return3m - a.return3m).slice(0, topN);
    default:       return list.sort((a,b) => b.return1y - a.return1y).slice(0, topN);
  }
}