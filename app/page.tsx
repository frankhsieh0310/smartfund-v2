"use client";
import React from "react";

import Link from "next/link";
import { useState } from "react";
import { getHomeTopEtfs, getHomeTopFunds } from "@/lib/services/rankingService";
import { ETF_LIST } from "./etf/data";
import { FUND_LIST } from "./funds/data";
import { searchAll, type FilterCondition, type SearchResultItem } from "@/lib/engines/filterEngine";
import { getSuggestions, conditionToLabel, type Suggestion } from "@/lib/engines/recommendationEngine";

// ── 全球市場資料 ──────────────────────────────────────────────────────
type MktItem  = { name: string; value: string; pts: string; pct: string; up: boolean };
type MktGroup = { id: string; label: string; sublabel: string; emoji: string; main: MktItem[]; more: MktItem[] };

const MARKET_GROUPS: MktGroup[] = [
  { id:"tw", label:"台灣市場", sublabel:"TAIWAN", emoji:"🇹🇼",
    main:[
      { name:"加權指數",   value:"22,184", pts:"+184.32", pct:"+0.84%", up:true  },
      { name:"台指期近月", value:"22,210", pts:"+128.00", pct:"+0.58%", up:true  },
      { name:"元大台灣50", value:"198.45", pts:"+1.42",   pct:"+0.72%", up:true  },
    ],
    more:[
      { name:"櫃買指數", value:"248.32", pts:"+1.85",  pct:"+0.75%", up:true },
      { name:"金融指數", value:"2,184",  pts:"+12.40", pct:"+0.57%", up:true },
      { name:"電子指數", value:"1,092",  pts:"+9.84",  pct:"+0.91%", up:true },
    ],
  },
  { id:"us", label:"美國市場", sublabel:"UNITED STATES", emoji:"🇺🇸",
    main:[
      { name:"道瓊工業", value:"43,408", pts:"+228.41", pct:"+0.53%", up:true },
      { name:"NASDAQ",  value:"19,271", pts:"+162.25", pct:"+0.85%", up:true },
      { name:"S&P 500", value:"5,842",  pts:"+39.52",  pct:"+0.68%", up:true },
    ],
    more:[
      { name:"費城半導體",    value:"5,124", pts:"+62.10", pct:"+1.23%", up:true  },
      { name:"Russell 2000", value:"2,218", pts:"-6.89",  pct:"-0.31%", up:false },
      { name:"VIX",          value:"13.42", pts:"-0.16",  pct:"-1.19%", up:false },
    ],
  },
  { id:"asia", label:"亞洲市場", sublabel:"ASIA", emoji:"🌏",
    main:[
      { name:"日經 225",   value:"39,842", pts:"+411.24", pct:"+1.04%", up:true  },
      { name:"韓國 KOSPI", value:"2,621",  pts:"+15.92",  pct:"+0.61%", up:true  },
      { name:"恒生指數",   value:"23,184", pts:"-109.60", pct:"-0.47%", up:false },
    ],
    more:[
      { name:"上證指數", value:"3,412",  pts:"+7.48",  pct:"+0.22%", up:true },
      { name:"深圳成指", value:"10,824", pts:"+98.42", pct:"+0.92%", up:true },
      { name:"新加坡",   value:"3,822",  pts:"+18.40", pct:"+0.48%", up:true },
    ],
  },
  { id:"eu", label:"歐洲市場", sublabel:"EUROPE", emoji:"🇪🇺",
    main:[
      { name:"德國 DAX",      value:"22,854", pts:"+100.56", pct:"+0.44%", up:true },
      { name:"英國 FTSE 100", value:"8,732",  pts:"+24.44",  pct:"+0.28%", up:true },
      { name:"法國 CAC 40",   value:"7,981",  pts:"+15.16",  pct:"+0.19%", up:true },
    ],
    more:[
      { name:"Euro STOXX 50", value:"5,312",  pts:"+18.60", pct:"+0.35%", up:true },
      { name:"瑞士 SMI",      value:"12,184", pts:"+48.24", pct:"+0.40%", up:true },
      { name:"義大利 MIB",    value:"38,420", pts:"+84.12", pct:"+0.22%", up:true },
    ],
  },
  { id:"cmd", label:"商品市場", sublabel:"COMMODITIES", emoji:"🥇",
    main:[
      { name:"黃金 XAU", value:"3,342", pts:"+30.18", pct:"+0.91%", up:true  },
      { name:"WTI 原油",  value:"71.28", pts:"-0.60",  pct:"-0.83%", up:false },
      { name:"布蘭特",   value:"74.52", pts:"-0.53",  pct:"-0.71%", up:false },
    ],
    more:[
      { name:"白銀",  value:"32.84", pts:"+0.37", pct:"+1.14%", up:true  },
      { name:"銅",    value:"4.52",  pts:"+0.02", pct:"+0.44%", up:true  },
      { name:"天然氣", value:"2.18", pts:"-0.04", pct:"-1.80%", up:false },
    ],
  },
];

const ETF_HOT = [
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

const FUND_HOT = [
  { rank:1,  name:"安聯台灣科技基金",   company:"安聯",  flow:"+45.7億", change:"+1.25%", up:true },
  { rank:2,  name:"復華全球物聯網基金", company:"復華",  flow:"+32.2億", change:"+0.98%", up:true },
  { rank:3,  name:"國泰台灣5G+基金",    company:"國泰",  flow:"+28.9億", change:"+1.12%", up:true },
  { rank:4,  name:"聯博全球高收益債券", company:"聯博",  flow:"+24.3億", change:"+0.42%", up:true },
  { rank:5,  name:"富達基金－美國基金", company:"富達",  flow:"+21.9億", change:"+0.81%", up:true },
  { rank:6,  name:"摩根美國科技基金",   company:"摩根",  flow:"+19.2億", change:"+1.14%", up:true },
  { rank:7,  name:"安聯收益成長基金",   company:"安聯",  flow:"+16.4億", change:"+0.38%", up:true },
  { rank:8,  name:"貝萊德世界科技基金", company:"貝萊德",flow:"+13.9億", change:"+0.92%", up:true },
  { rank:9,  name:"野村亞太高股息基金", company:"野村",  flow:"+11.2億", change:"+0.44%", up:true },
  { rank:10, name:"施羅德環球股息收益", company:"施羅德",flow:"+9.2億",  change:"+0.55%", up:true },
];

// ── Sparkline ─────────────────────────────────────────────────────────
function Sparkline({ up }: { up: boolean }) {
  const pts = up ? [38,35,37,32,29,33,27,23,19,16,13,10] : [10,14,12,18,15,20,24,19,27,25,31,36];
  const minV = Math.min(...pts), maxV = Math.max(...pts), range = maxV - minV || 1;
  const W = 90, H = 32;
  const coords = pts.map((v,i) => `${((i/(pts.length-1))*W).toFixed(1)},${(H-((v-minV)/range)*(H-6)-3).toFixed(1)}`).join(" ");
  const color = up ? "#22C55E" : "#EF4444";
  const gid = `sp${up?"u":"d"}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${coords} ${W},${H}`} fill={`url(#${gid})`} />
      <polyline points={coords} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Market Row ────────────────────────────────────────────────────────
function MktRow({ group }: { group: MktGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-white/[0.08] rounded-2xl overflow-hidden mb-4"
      style={{ background:"rgba(15,22,42,0.85)", backdropFilter:"blur(20px)" }}>
      <div className="px-7 py-5">
        <div className="flex items-center gap-6">
          <div className="w-[140px] shrink-0 flex items-center gap-3">
            <span className="text-[26px]">{group.emoji}</span>
            <div>
              <div className="text-[17px] font-bold text-white leading-tight">{group.label}</div>
              <div className="text-[10px] tracking-[3px] text-white/35 mt-0.5">{group.sublabel}</div>
            </div>
          </div>
          <div className="w-px h-12 bg-white/[0.08] shrink-0" />
          <div className="flex flex-1 gap-0 min-w-0">
            {group.main.map((item, i) => (
              <div key={item.name} className="flex items-center gap-5 flex-1 min-w-0 px-5">
                {i > 0 && <div className="w-px h-10 bg-white/[0.06] shrink-0 -ml-5" />}
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-white/50 mb-1 truncate">{item.name}</div>
                  <div className="text-[26px] font-bold text-white leading-none mb-1">{item.value}</div>
                  <div className={`text-[15px] font-semibold ${item.up?"text-[#22C55E]":"text-[#EF4444]"}`}>
                    {item.up?"▲":"▼"} {item.pts} <span className="text-[13px]">{item.pct}</span>
                  </div>
                </div>
                <Sparkline up={item.up} />
              </div>
            ))}
          </div>
          <button onClick={() => setOpen(!open)}
            className="shrink-0 text-[14px] font-semibold text-[#F5B700] hover:text-[#e0a800] transition-colors whitespace-nowrap ml-4">
            {open ? "收起 ▲" : "更多 ▼"}
          </button>
        </div>
      </div>
      {open && (
        <div className="px-7 pb-5 border-t border-white/[0.06]">
          <div className="flex gap-0 pt-4">
            <div className="w-[140px] shrink-0" />
            <div className="w-px bg-white/[0.06] shrink-0 mx-6" />
            <div className="flex flex-1 gap-0 min-w-0">
              {group.more.map((item, i) => (
                <div key={item.name} className="flex items-center gap-4 flex-1 min-w-0 px-5">
                  {i > 0 && <div className="w-px h-10 bg-white/[0.06] shrink-0 -ml-5" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] text-white/40 mb-1 truncate">{item.name}</div>
                    <div className="text-[21px] font-bold text-white leading-none mb-1">{item.value}</div>
                    <div className={`text-[13px] font-semibold ${item.up?"text-[#22C55E]":"text-[#EF4444]"}`}>
                      {item.up?"▲":"▼"} {item.pts} <span className="text-[12px]">{item.pct}</span>
                    </div>
                  </div>
                  <Sparkline up={item.up} />
                </div>
              ))}
            </div>
            <div className="w-[80px] shrink-0" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────


// ══════════════════════════════════════════════════════════════
// Investment Criteria Builder
// 使用 filterEngine + recommendationEngine
// ══════════════════════════════════════════════════════════════

// ── 條件選單定義 ──────────────────────────────────────────────
const CONDITION_MENU: {
  group: string;
  items: { label: string; condition: FilterCondition }[];
}[] = [
  {
    group: "資產類型",
    items: [
      { label: "ETF",  condition: { type: "assetType", operator: "==", value: "ETF" } },
      { label: "基金", condition: { type: "assetType", operator: "==", value: "基金" } },
    ],
  },
  {
    group: "投資區域",
    items: [
      { label: "台灣",   condition: { type: "region", operator: "==", value: "台灣" } },
      { label: "美國",   condition: { type: "region", operator: "==", value: "美國" } },
      { label: "全球",   condition: { type: "region", operator: "==", value: "全球" } },
      { label: "亞洲",   condition: { type: "region", operator: "==", value: "亞洲" } },
      { label: "中國",   condition: { type: "region", operator: "==", value: "中國" } },
      { label: "新興市場",condition:{ type: "region", operator: "==", value: "新興市場" } },
    ],
  },
  {
    group: "商品類型",
    items: [
      { label: "股票型", condition: { type: "category", operator: "==", value: "股票型" } },
      { label: "債券型", condition: { type: "category", operator: "==", value: "債券型" } },
      { label: "平衡型", condition: { type: "category", operator: "==", value: "平衡型" } },
      { label: "高股息", condition: { type: "sector",   operator: "==", value: "高股息" } },
      { label: "科技",   condition: { type: "sector",   operator: "==", value: "科技"   } },
    ],
  },
  {
    group: "配息頻率",
    items: [
      { label: "月配息", condition: { type: "distribution", operator: "==", value: "月配" } },
      { label: "季配息", condition: { type: "distribution", operator: "==", value: "季配" } },
      { label: "年配",   condition: { type: "distribution", operator: "==", value: "年配" } },
    ],
  },
  {
    group: "殖利率",
    items: [
      { label: "殖利率 > 3%", condition: { type: "yield", operator: ">=", value: 3 } },
      { label: "殖利率 > 5%", condition: { type: "yield", operator: ">=", value: 5 } },
      { label: "殖利率 > 7%", condition: { type: "yield", operator: ">=", value: 7 } },
      { label: "殖利率 > 9%", condition: { type: "yield", operator: ">=", value: 9 } },
    ],
  },
  {
    group: "近一年績效",
    items: [
      { label: "近1年 > 5%",  condition: { type: "return", operator: ">=", value: 5,  period: "1y" } },
      { label: "近1年 > 10%", condition: { type: "return", operator: ">=", value: 10, period: "1y" } },
      { label: "近1年 > 15%", condition: { type: "return", operator: ">=", value: 15, period: "1y" } },
      { label: "近1年 > 20%", condition: { type: "return", operator: ">=", value: 20, period: "1y" } },
    ],
  },
  {
    group: "近三年績效",
    items: [
      { label: "近3年 > 20%", condition: { type: "return", operator: ">=", value: 20, period: "3y" } },
      { label: "近3年 > 30%", condition: { type: "return", operator: ">=", value: 30, period: "3y" } },
      { label: "近3年 > 50%", condition: { type: "return", operator: ">=", value: 50, period: "3y" } },
    ],
  },
  {
    group: "年化波動度",
    items: [
      { label: "波動 < 10%", condition: { type: "volatility", operator: "<=", value: 10 } },
      { label: "波動 < 15%", condition: { type: "volatility", operator: "<=", value: 15 } },
      { label: "波動 < 20%", condition: { type: "volatility", operator: "<=", value: 20 } },
    ],
  },
];

// 常用條件範例
const EXAMPLE_SETS: { name: string; desc: string; conditions: FilterCondition[] }[] = [
  {
    name: "退休現金流",
    desc: "月配息＋高配息率",
    conditions: [
      { type: "distribution", operator: "==", value: "月配" },
      { type: "yield",        operator: ">=", value: 6 },
      { type: "volatility",   operator: "<=", value: 15 },
    ],
  },
  {
    name: "亞洲股票基金",
    desc: "亞洲＋股票型",
    conditions: [
      { type: "region",   operator: "==", value: "亞洲" },
      { type: "category", operator: "==", value: "股票型" },
    ],
  },
  {
    name: "科技成長",
    desc: "科技＋近一年績效",
    conditions: [
      { type: "sector", operator: "==", value: "科技" },
      { type: "return", operator: ">=", value: 20, period: "1y" },
    ],
  },
  {
    name: "低波動收益",
    desc: "債券＋低波動",
    conditions: [
      { type: "category",  operator: "==", value: "債券型" },
      { type: "volatility",operator: "<=", value: 10 },
    ],
  },
  {
    name: "高股息 ETF",
    desc: "高股息＋月配息",
    conditions: [
      { type: "assetType", operator: "==", value: "ETF" },
      { type: "sector",    operator: "==", value: "高股息" },
      { type: "yield",     operator: ">=", value: 6 },
    ],
  },
];

const FREE_LIMIT = 3;

// ── Result Card ────────────────────────────────────────────────
function ResultCard({ item }: { item: SearchResultItem }) {
  const isEtf = item.type === "ETF";
  return (
    <div className="bg-white border border-slate-100 rounded-2xl p-5 hover:shadow-md hover:border-[#F5B700]/30 transition-all">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${isEtf ? "bg-blue-50 text-blue-600" : "bg-amber-50 text-amber-700"}`}>
              {item.type}
            </span>
            {item.morningstar && (
              <span className="text-[12px] text-[#b38600]">{"★".repeat(item.morningstar)}</span>
            )}
          </div>
          <div className="text-[15px] font-bold text-[#0a1628]">
            {isEtf ? item.code : item.company}
          </div>
          <div className="text-[13px] text-slate-500 mt-0.5 line-clamp-1">{item.name}</div>
        </div>
        <div className="text-right shrink-0 ml-3">
          <div className={`text-[20px] font-black ${item.return1y >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {item.return1y >= 0 ? "+" : ""}{item.return1y.toFixed(1)}%
          </div>
          <div className="text-[11px] text-slate-400">近1年</div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 pt-3 border-t border-slate-50">
        <div className="text-center">
          <div className="text-[14px] font-semibold text-[#b38600]">
            {item.dividendYield > 0 ? `${item.dividendYield.toFixed(1)}%` : "—"}
          </div>
          <div className="text-[11px] text-slate-400">配息率</div>
        </div>
        <div className="text-center">
          <div className={`text-[14px] font-semibold ${item.return1m >= 0 ? "text-emerald-600" : "text-red-500"}`}>
            {item.return1m >= 0 ? "+" : ""}{item.return1m.toFixed(1)}%
          </div>
          <div className="text-[11px] text-slate-400">近1月</div>
        </div>
        <div className="text-center">
          <div className="text-[14px] font-semibold text-slate-600">{item.volatility.toFixed(1)}%</div>
          <div className="text-[11px] text-slate-400">波動度</div>
        </div>
      </div>
    </div>
  );
}

// ── Main Criteria Builder ──────────────────────────────────────
function InvestmentCriteriaBuilder() {
  const [conditions, setConditions] = useState<FilterCondition[]>([]);
  const [results, setResults]       = useState<SearchResultItem[] | null>(null);
  const [showMenu, setShowMenu]     = useState(false);
  const [showPremium, setShowPremium] = useState(false);
  const [searched, setSearched]     = useState(false);

  const suggestions = React.useMemo(() => getSuggestions(conditions, 4), [conditions]);

  function addCondition(cond: FilterCondition) {
    if (conditions.length >= FREE_LIMIT) {
      setShowPremium(true);
      return;
    }
    // 同類型只保留最後一個
    const filtered = conditions.filter(c => c.type !== cond.type);
    setConditions([...filtered, cond]);
    setShowMenu(false);
    setResults(null);
    setSearched(false);
  }

  function removeCondition(idx: number) {
    setConditions(conditions.filter((_, i) => i !== idx));
    setResults(null);
    setSearched(false);
  }

  function applyExample(example: typeof EXAMPLE_SETS[0]) {
    setConditions(example.conditions.slice(0, FREE_LIMIT));
    setResults(null);
    setSearched(false);
    setShowMenu(false);
  }

  function doSearch() {
    if (conditions.length === 0) return;
    const r = searchAll({ conditions, topN: 20 });
    setResults(r);
    setSearched(true);
  }

  function clearAll() {
    setConditions([]);
    setResults(null);
    setSearched(false);
    setShowPremium(false);
  }

  const etfResults  = results?.filter(r => r.type === "ETF")  ?? [];
  const fundResults = results?.filter(r => r.type === "基金") ?? [];

  return (
    <section className="relative z-10 py-16" style={{ backgroundColor: "#ffffff" }}>
      <div className="max-w-[1400px] mx-auto px-10">

        {/* 標題 */}
        <div className="text-center mb-10">
          <div className="text-[13px] tracking-[10px] text-[#F5B700] font-semibold mb-3">CRITERIA BUILDER</div>
          <h2 className="text-[36px] font-black text-[#0a1628] mb-3">建立你的投資條件</h2>
          <p className="text-[17px] text-slate-500 max-w-[560px] mx-auto leading-relaxed">
            依照自己的需求，建立一組搜尋條件，快速找出符合條件的 ETF 與基金。
          </p>
        </div>

        <div className="max-w-[900px] mx-auto">

          {/* Tag Builder */}
          <div className="bg-slate-50 border border-slate-100 rounded-2xl p-6 mb-6">

            {/* 已選條件 Tags */}
            <div className="flex flex-wrap gap-2 mb-4 min-h-[40px] items-center">
              {conditions.length === 0 && (
                <span className="text-[15px] text-slate-400">點擊「＋ 新增條件」開始建立...</span>
              )}
              {conditions.map((c, i) => (
                <span key={i}
                  className="inline-flex items-center gap-1.5 bg-[#0a1628] text-white text-[14px] font-semibold px-4 py-2 rounded-full">
                  {conditionToLabel(c)}
                  <button onClick={() => removeCondition(i)}
                    className="text-white/60 hover:text-white text-[16px] leading-none ml-1">×</button>
                </span>
              ))}
              {/* 免費限制提示 */}
              {conditions.length >= FREE_LIMIT && (
                <span className="text-[13px] text-amber-600 font-semibold bg-amber-50 border border-amber-200 px-3 py-1.5 rounded-full">
                  免費版最多 {FREE_LIMIT} 個條件
                </span>
              )}
            </div>

            {/* 操作列 */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* 新增條件按鈕 */}
              <div className="relative">
                <button
                  onClick={() => setShowMenu(!showMenu)}
                  className="flex items-center gap-2 bg-white border border-slate-200 text-[#0a1628] text-[15px] font-semibold px-5 py-2.5 rounded-xl hover:border-[#F5B700] hover:shadow-sm transition-all">
                  <span className="text-[18px] text-[#F5B700]">＋</span> 新增條件
                </button>

                {/* 條件下拉選單 */}
                {showMenu && (
                  <div className="absolute top-full left-0 mt-2 w-[320px] bg-white border border-slate-100 rounded-2xl shadow-xl z-50 max-h-[420px] overflow-y-auto">
                    {CONDITION_MENU.map(group => (
                      <div key={group.group}>
                        <div className="px-4 py-2 text-[11px] font-bold text-slate-400 tracking-[3px] bg-slate-50 border-b border-slate-100">
                          {group.group}
                        </div>
                        <div className="p-2 flex flex-wrap gap-1.5">
                          {group.items.map(item => {
                            const isActive = conditions.some(c =>
                              c.type === item.condition.type && c.value === item.condition.value
                            );
                            return (
                              <button key={item.label}
                                onClick={() => addCondition(item.condition)}
                                className={`text-[13px] px-3 py-1.5 rounded-lg font-semibold transition-colors ${
                                  isActive
                                    ? "bg-[#0a1628] text-white"
                                    : "bg-slate-100 text-slate-700 hover:bg-[#F5B700]/10 hover:text-[#b38600]"
                                }`}>
                                {isActive ? "✓ " : ""}{item.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                    <div className="p-3 border-t border-slate-100 text-center">
                      <button onClick={() => setShowMenu(false)} className="text-[13px] text-slate-400 hover:text-slate-600">關閉</button>
                    </div>
                  </div>
                )}
              </div>

              {/* 智慧推薦 */}
              {suggestions.length > 0 && conditions.length > 0 && conditions.length < FREE_LIMIT && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] text-slate-400">推薦加入：</span>
                  {suggestions.map((s: Suggestion, i: number) => (
                    <button key={i}
                      onClick={() => addCondition(s.condition)}
                      className="text-[13px] border border-slate-200 text-slate-600 px-3 py-1.5 rounded-lg hover:border-[#F5B700] hover:text-[#b38600] transition-colors">
                      {s.label} {s.popular ? "🔥" : ""}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex-1" />

              {conditions.length > 0 && (
                <button onClick={clearAll}
                  className="text-[14px] text-slate-400 hover:text-slate-600 transition-colors">
                  清除全部
                </button>
              )}

              <button
                onClick={doSearch}
                disabled={conditions.length === 0}
                className="bg-[#F5B700] hover:bg-[#e0a800] disabled:bg-slate-200 disabled:text-slate-400 text-[#020817] px-8 py-2.5 rounded-xl font-black text-[16px] transition-colors">
                搜尋
              </button>
            </div>
          </div>

          {/* Premium 提示 */}
          {showPremium && (
            <div className="mb-6 bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-center justify-between">
              <div>
                <div className="text-[15px] font-bold text-amber-800 mb-1">🔒 已達免費版條件上限（{FREE_LIMIT} 個）</div>
                <div className="text-[14px] text-amber-700">升級 Premium 可使用最多 20 個條件，並儲存不限組數的投資條件。</div>
              </div>
              <button
                onClick={() => setShowPremium(false)}
                className="ml-4 bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-5 py-2 rounded-xl font-bold text-[14px] transition-colors shrink-0">
                查看方案
              </button>
            </div>
          )}

          {/* 常用條件範例 */}
          {!searched && (
            <div className="mb-2">
              <div className="text-[14px] text-slate-500 mb-3 font-semibold">
                常用條件範例 <span className="text-[12px] font-normal text-slate-400 ml-1">（點擊套用）</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {EXAMPLE_SETS.map((ex: typeof EXAMPLE_SETS[0], i: number) => (
                  <button key={i}
                    onClick={() => applyExample(ex)}
                    className="group flex items-center gap-2 bg-white border border-slate-200 text-[14px] px-4 py-2 rounded-xl hover:border-[#F5B700] hover:shadow-sm transition-all">
                    <span className="text-[11px] font-bold text-[#b38600] bg-amber-50 px-1.5 py-0.5 rounded">範例</span>
                    <span className="font-semibold text-[#0a1628]">{ex.name}</span>
                    <span className="text-slate-400 text-[12px]">{ex.desc}</span>
                  </button>
                ))}
              </div>
              <div className="mt-3 text-[12px] text-slate-400">
                以上僅為條件設定範例，非投資建議。使用者可依自身需求自由調整。
              </div>
            </div>
          )}
        </div>

        {/* 搜尋結果 */}
        {searched && results !== null && (
          <div className="mt-8 max-w-[1400px]">
            <div className="flex items-center justify-between mb-6">
              <div>
                <div className="text-[18px] font-bold text-[#0a1628]">
                  搜尋結果
                  <span className="ml-3 text-[#b38600] font-black text-[24px]">{results.length}</span>
                  <span className="ml-1 text-[16px] text-slate-500">筆符合條件商品</span>
                </div>
                <div className="text-[13px] text-slate-400 mt-1">
                  條件：{conditions.map((c: FilterCondition) => conditionToLabel(c)).join(" ＋ ")}
                </div>
              </div>
              <button onClick={clearAll}
                className="text-[14px] text-slate-500 border border-slate-200 px-4 py-2 rounded-lg hover:border-slate-400 transition-colors">
                重新設定
              </button>
            </div>

            {results.length === 0 && (
              <div className="text-center py-16 text-slate-400">
                <div className="text-[48px] mb-4">🔍</div>
                <div className="text-[18px] font-semibold mb-2">找不到符合條件的商品</div>
                <div className="text-[15px]">請嘗試放寬條件，例如降低殖利率門檻或移除部分條件</div>
              </div>
            )}

            {etfResults.length > 0 && (
              <div className="mb-10">
                <div className="flex items-center gap-3 mb-4">
                  <div className="text-[18px] font-bold text-[#0a1628]">ETF 篩選結果</div>
                  <div className="text-[14px] text-slate-400">{etfResults.length} 檔</div>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {etfResults.slice(0, 8).map(item => <ResultCard key={item.id} item={item} />)}
                </div>
                {etfResults.length > 8 && (
                  <div className="mt-4 text-center">
                    <Link href="/etf" className="text-[14px] text-[#b38600] hover:underline">
                      查看全部 {etfResults.length} 檔 ETF →
                    </Link>
                  </div>
                )}
              </div>
            )}

            {fundResults.length > 0 && (
              <div className="mb-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="text-[18px] font-bold text-[#0a1628]">基金篩選結果</div>
                  <div className="text-[14px] text-slate-400">{fundResults.length} 檔</div>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {fundResults.slice(0, 8).map(item => <ResultCard key={item.id} item={item} />)}
                </div>
                {fundResults.length > 8 && (
                  <div className="mt-4 text-center">
                    <Link href="/funds" className="text-[14px] text-[#b38600] hover:underline">
                      查看全部 {fundResults.length} 檔基金 →
                    </Link>
                  </div>
                )}
              </div>
            )}

            <div className="text-[12px] text-slate-400 border-t border-slate-100 pt-4 mt-4">
              以上為依您設定條件篩選出的商品，非投資建議。過去績效不代表未來表現，請自行評估風險。
            </div>
          </div>
        )}
      </div>
    </section>
  );
}


export default function Home() {
  return (
    <main className="min-h-screen">

      {/* ══ NAVBAR ══════════════════════════════════════════════════ */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#040a18]/90 backdrop-blur-xl border-b border-white/[0.08]">
        <div className="max-w-[1600px] mx-auto h-20 px-10 flex items-center justify-between">
          <div>
            <div className="text-[32px] font-black text-white leading-none">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[12px] text-slate-400 mt-0.5">Investment Intelligence Platform</div>
          </div>
          <nav className="hidden lg:flex gap-8 text-[18px] font-semibold text-slate-300">
            <Link href="/quiz"    className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf"     className="hover:text-white transition-colors">ETF篩選器</Link>
            <Link href="/funds"   className="hover:text-white transition-colors">基金篩選器</Link>
            <Link href="/markets" className="hover:text-white transition-colors">市場中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="hover:text-[#F5B700] transition-colors">方案</Link>
          </nav>
          <div className="flex items-center gap-4">
            <a href="#" className="text-[16px] font-semibold text-slate-300 border border-white/30 px-5 py-2.5 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-6 py-2.5 rounded-lg font-bold text-[16px] transition-colors">開始建立</Link>
          </div>
        </div>
      </header>

      {/* ══ ZONE 1：HERO ════════════════════════════════════════════ */}
      <section className="relative z-10 min-h-screen">
        {/* Overlay 35~40% */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#020817]/70 via-[#020817]/35 to-transparent z-[1]" />
        <div className="relative z-10 max-w-[1600px] mx-auto px-10 flex items-center min-h-screen pt-20">
          <div className="grid lg:grid-cols-[50%_50%] w-full items-center gap-12 py-16">

            {/* LEFT */}
            <div className="space-y-7">
              <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold">SMARTMATCH</div>

              <div>
                <h1 className="text-[56px] font-black leading-[1.12] text-white mb-5">
                  打造屬於你的<br />
                  <span className="text-[#F5B700]">投資儀表板</span>
                </h1>
                <p className="text-[22px] text-white/70 leading-[1.8] max-w-[500px]">
                  掌握市場資訊、追蹤關注商品、建立自己的投資資料庫。
                  用一個平台，管理你的投資決策流程。
                </p>
              </div>

              <div className="flex gap-4 flex-wrap">
                <Link href="/quiz"
                  className="bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-9 py-4 rounded-xl font-black text-[19px] transition-colors shadow-[0_0_40px_rgba(245,183,0,0.25)]">
                  開始打造我的投資首頁 →
                </Link>
                <button
                  onClick={() => document.getElementById("features")?.scrollIntoView({ behavior:"smooth" })}
                  className="bg-white/[0.08] backdrop-blur-md border border-white/[0.15] text-white px-7 py-4 rounded-xl font-semibold text-[17px] hover:bg-white/[0.15] transition-colors">
                  先看看有哪些功能
                </button>
              </div>

              {/* 四統計卡 */}
              <div className="grid grid-cols-4 gap-3 pt-1">
                {[
                  { num:"95+",  label:"ETF 資料" },
                  { num:"269+", label:"基金資料" },
                  { num:"34+",  label:"全球市場指標" },
                  { num:"5min", label:"快速上手" },
                ].map(s => (
                  <div key={s.label} className="bg-white/[0.07] backdrop-blur-sm border border-white/[0.1] rounded-2xl p-4 text-center">
                    <div className="text-[44px] font-black text-[#F5B700] leading-none mb-1">{s.num}</div>
                    <div className="text-[15px] text-white/55 leading-tight">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* 資料來源信任背書 */}
              <div className="pt-1">
                <div className="text-[13px] text-white/30 mb-2">資料來源參考</div>
                <div className="flex flex-wrap gap-2">
                  {["Morningstar","公開資訊觀測站","投信投顧公會","基金公司公開資料"].map(src => (
                    <span key={src} className="text-[13px] text-white/40 border border-white/[0.1] px-3 py-1 rounded-full">{src}</span>
                  ))}
                </div>
              </div>
            </div>

            {/* RIGHT — 個人化首頁預覽（2×3 Grid） */}
            <div className="rounded-3xl border border-white/[0.12] overflow-hidden shadow-[0_40px_120px_rgba(0,0,0,0.5)]"
              style={{ background:"rgba(8,15,32,0.88)", backdropFilter:"blur(28px)" }}>

              {/* 頂部 bar */}
              <div className="flex items-center justify-between px-6 py-3.5 border-b border-white/[0.08]"
                style={{ background:"rgba(8,15,32,0.96)" }}>
                <div className="flex items-center gap-3">
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
                  </div>
                  <div className="text-[12px] font-bold text-[#F5B700] tracking-[4px]">我的投資首頁</div>
                </div>
                <div className="text-[11px] text-white/30">登入後可自由客製</div>
              </div>

              {/* 2×3 模組 Grid */}
              <div className="p-4 grid grid-cols-2 gap-3">

                {/* 模組1：昨日美股 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] text-white/40 mb-2 flex items-center justify-between">
                    <span>昨日美股</span>
                    <span className="text-[10px] text-white/20">可替換 ⊕</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["NASDAQ","19,271","▲ +0.85%",true],["S&P 500","5,842","▲ +0.68%",true],["道瓊","43,408","▲ +0.53%",true]].map(([n,v,c,up])=>(
                      <div key={n as string} className="flex items-center justify-between">
                        <span className="text-[12px] text-white/50">{n}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[13px] font-semibold text-white">{v}</span>
                          <span className={`text-[11px] font-semibold ${up ? "text-emerald-400":"text-red-400"}`}>{c}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模組2：熱門ETF */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] text-white/40 mb-2 flex items-center justify-between">
                    <span>熱門ETF</span>
                    <span className="text-[10px] text-white/20">可替換 ⊕</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["0050","+0.72%",true],["00878","+0.45%",true],["00919","+0.38%",true]].map(([code,chg,up])=>(
                      <div key={code as string} className="flex items-center justify-between">
                        <span className="text-[13px] font-bold text-[#F5B700]">{code}</span>
                        <span className={`text-[12px] font-semibold ${up?"text-emerald-400":"text-red-400"}`}>{chg}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模組3：熱門基金 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] text-white/40 mb-2 flex items-center justify-between">
                    <span>熱門基金</span>
                    <span className="text-[10px] text-white/20">可替換 ⊕</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["安聯","台灣科技基金","+1.25%",true],["復華","全球物聯網","+0.98%",true],["聯博","高收益債券","+0.42%",true]].map(([co,name,chg,up])=>(
                      <div key={name as string} className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-white/40 w-7 shrink-0">{co}</span>
                          <span className="text-[12px] text-white/60 truncate max-w-[80px]">{name}</span>
                        </div>
                        <span className={`text-[12px] font-semibold ${up?"text-emerald-400":"text-red-400"}`}>{chg}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模組4：我的觀察名單 */}
                <div className="bg-white/[0.04] border border-[#F5B700]/20 rounded-xl p-4">
                  <div className="text-[11px] text-[#F5B700]/60 mb-2 flex items-center justify-between">
                    <span>👀 我的觀察名單</span>
                    <span className="text-[10px] text-white/20">個人化</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["QQQ","Invesco NASDAQ","▲ +1.2%",true],["VGT","Vanguard IT","▲ +0.9%",true],["SOXX","iShares 半導體","▲ +1.8%",true]].map(([code,name,chg,up])=>(
                      <div key={code as string} className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[12px] font-bold text-[#F5B700]">{code}</span>
                          <span className="text-[11px] text-white/35 truncate max-w-[70px]">{name}</span>
                        </div>
                        <span className={`text-[12px] font-semibold ${up?"text-emerald-400":"text-red-400"}`}>{chg}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模組5：我的精選商品 */}
                <div className="bg-white/[0.04] border border-[#F5B700]/20 rounded-xl p-4">
                  <div className="text-[11px] text-[#F5B700]/60 mb-2 flex items-center justify-between">
                    <span>⭐ 我的精選商品</span>
                    <span className="text-[10px] text-white/20">個人化</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["霸菱","優先順位基金","6.2%"],["聯博","美國收益基金","6.1%"],["00679B","元大美債20年","3.8%"]].map(([a,b,c])=>(
                      <div key={b as string} className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] text-[#F5B700] w-10 shrink-0">{a}</span>
                          <span className="text-[11px] text-white/50 truncate max-w-[80px]">{b}</span>
                        </div>
                        <span className="text-[12px] font-semibold text-[#F5B700]">{c}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 模組6：市場焦點 */}
                <div className="bg-white/[0.04] border border-white/[0.06] rounded-xl p-4">
                  <div className="text-[11px] text-white/40 mb-2 flex items-center justify-between">
                    <span>市場焦點</span>
                    <span className="text-[10px] text-white/20">可替換 ⊕</span>
                  </div>
                  <div className="space-y-1.5">
                    {[["黃金 XAU","3,342","▲ +0.91%",true],["台股加權","22,184","▲ +0.84%",true],["WTI原油","71.28","▼ -0.83%",false]].map(([n,v,c,up])=>(
                      <div key={n as string} className="flex items-center justify-between">
                        <span className="text-[12px] text-white/50">{n}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[12px] font-semibold text-white">{v}</span>
                          <span className={`text-[11px] ${up?"text-emerald-400":"text-red-400"}`}>{c}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

              </div>

              {/* 底部說明 */}
              <div className="px-5 pb-4 text-center">
                <div className="text-[12px] text-white/25">登入後可自由新增、隱藏、排列模組</div>
              </div>
            </div>

          </div>
        </div>
      </section>

      {/* ══ ZONE 2：個人化首頁展示（未登入 vs 登入後）══════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">PERSONALIZATION</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">你的首頁，你決定</h2>
            <p className="text-[18px] text-slate-500 mt-3 max-w-[600px] mx-auto">
              註冊後可以客製化你的投資首頁，選擇你關心的市場、商品與分析工具。
            </p>
          </div>
          <div className="grid lg:grid-cols-2 gap-8">

            {/* 未登入版本 */}
            <div>
              <div className="text-[16px] font-bold text-slate-500 mb-4 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />
                未登入預設首頁
              </div>
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="bg-slate-50 px-5 py-3.5 border-b border-slate-100 flex items-center justify-between">
                  <div className="text-[14px] font-bold text-slate-400">Smart<span className="text-[#b38600]">Match</span></div>
                  <div className="text-[13px] text-slate-400">預設版本</div>
                </div>
                <div className="p-4 grid grid-cols-2 gap-3 bg-white">
                  {[
                    { title:"昨日美股", icon:"🇺🇸", items:["NASDAQ  +0.85%","S&P 500  +0.68%","道瓊  +0.53%"] },
                    { title:"熱門ETF",  icon:"📊", items:["0050  +0.72%","00878  +0.45%","00919  +0.38%"] },
                    { title:"熱門基金", icon:"🏦", items:["安聯台灣科技  +1.25%","復華物聯網  +0.98%","聯博高收益  +0.42%"] },
                    { title:"市場焦點", icon:"🌐", items:["黃金  +0.91%","台股  +0.84%","WTI  -0.83%"] },
                  ].map(m => (
                    <div key={m.title} className="border border-slate-100 rounded-xl p-4">
                      <div className="text-[13px] font-semibold text-slate-600 mb-2.5">{m.icon} {m.title}</div>
                      <div className="space-y-1.5">
                        {m.items.map(item => (
                          <div key={item} className="text-[13px] text-slate-500">{item}</div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* 登入後版本 */}
            <div>
              <div className="text-[16px] font-bold text-[#b38600] mb-4 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#F5B700] inline-block" />
                登入後個人化首頁
              </div>
              <div className="border border-[#F5B700]/30 rounded-2xl overflow-hidden shadow-sm">
                <div className="bg-[#0a1628] px-5 py-3.5 border-b border-white/[0.08] flex items-center justify-between">
                  <div className="text-[14px] font-bold text-white">Smart<span className="text-[#F5B700]">Match</span></div>
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-400" />
                    <div className="text-[13px] text-white/60">王小明</div>
                  </div>
                </div>
                <div className="p-4 grid grid-cols-2 gap-3" style={{ backgroundColor:"#0d1729" }}>
                  {[
                    { title:"👀 我的觀察名單", gold:true, items:["QQQ  ▲ +1.2%","VGT  ▲ +0.9%","SOXX  ▲ +1.8%"] },
                    { title:"⭐ 我的精選商品", gold:true, items:["霸菱優先順位  6.2%","聯博美國收益  6.1%","00679B  3.8%"] },
                    { title:"📈 我的分析結果", gold:true, items:["穩健型 · 58分","股票50% 債券30%","上次分析 2026/06"] },
                    { title:"🌐 我的市場關注", gold:true, items:["台股  ▲ +0.84%","NASDAQ  ▲ +0.85%","黃金  ▲ +0.91%"] },
                  ].map(m => (
                    <div key={m.title} className="border border-[#F5B700]/20 rounded-xl p-4">
                      <div className="text-[12px] font-semibold text-[#F5B700]/70 mb-2.5">{m.title}</div>
                      <div className="space-y-1.5">
                        {m.items.map(item => (
                          <div key={item} className="text-[13px] text-white/60">{item}</div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="bg-[#0a1628] px-5 py-3 text-center border-t border-white/[0.06]">
                  <div className="text-[13px] text-white/30">可新增 · 隱藏 · 拖曳排列模組</div>
                </div>
              </div>
            </div>

          </div>
          <div className="text-center mt-10">
            <Link href="/quiz"
              className="inline-block bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-12 py-4 rounded-xl font-black text-[20px] transition-colors">
              開始打造我的投資首頁 →
            </Link>
          </div>
        </div>
      </section>


      <InvestmentCriteriaBuilder />

            {/* ══ ZONE 3：為什麼使用 SmartMatch（#F5F7FA）══════════════ */}
      <section id="features" className="relative z-10 py-24" style={{ backgroundColor:"#F5F7FA" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">WHY SMARTMATCH</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">為什麼使用 SmartMatch</h2>
            <p className="text-[18px] text-slate-500 mt-3 max-w-[600px] mx-auto">
              不只是資料查詢。SmartMatch 是你的投資決策夥伴。
            </p>
          </div>
          <div className="grid grid-cols-5 gap-5">
            {[
              {
                num:"01", icon:"🏠", badge:"個人化",
                title:"打造專屬投資首頁",
                desc:"自由配置首頁模組：市場資訊、ETF、基金、觀察名單、收藏商品。登入後建立屬於自己的投資儀表板，不再被別人決定你看到什麼。",
              },
              {
                num:"02", icon:"💾", badge:"資料整合",
                title:"建立自己的投資資料庫",
                desc:"收藏、觀察、比較、分析結果全部集中一處。不再散落於不同網站與 Excel，所有決策紀錄隨時查閱。",
              },
              {
                num:"03", icon:"📊", badge:"效率提升",
                title:"ETF 與基金整合分析",
                desc:"同一平台完成 ETF 查詢、基金查詢與商品比較。大幅減少切換網站的時間，把精力放在決策本身。",
              },
              {
                num:"04", icon:"🎯", badge:"個人需求",
                title:"個人化商品篩選",
                desc:"不是熱門排行，不是大家都買什麼。依照你的風險偏好與投資目標篩選符合條件的商品。",
              },
              {
                num:"05", icon:"🔄", badge:"完整流程",
                title:"從市場到商品一次完成",
                desc:"全球市場資訊 → 商品研究 → 商品比較 → 建立觀察名單。完整投資流程整合在同一個平台。",
              },
            ].map(f => (
              <div key={f.num} className="bg-white border border-slate-100 rounded-2xl p-7 hover:shadow-lg hover:border-[#F5B700]/30 transition-all flex flex-col">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] font-semibold">{f.num}</div>
                  <span className="text-[11px] font-bold text-[#b38600] bg-[#F5B700]/10 px-2 py-0.5 rounded-full">{f.badge}</span>
                </div>
                <div className="text-[36px] mb-4">{f.icon}</div>
                <div className="text-[18px] font-bold text-[#0a1628] mb-3">{f.title}</div>
                <div className="text-[15px] text-slate-500 leading-relaxed flex-1">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ 會員價值：註冊後可以做什麼（白底）══════════════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">MEMBER VALUE</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">註冊後可以做什麼？</h2>
            <p className="text-[18px] text-slate-500 mt-3 max-w-[560px] mx-auto">
              建立帳號後，你的投資資料庫就開始運作。
            </p>
          </div>
          <div className="grid grid-cols-5 gap-6">
            {[
              { icon:"🏠", title:"個人化首頁",   desc:"自由配置首頁模組，選擇你關心的市場、商品與工具。",                     cta:"設定首頁",      href:"/" },
              { icon:"⭐", title:"收藏商品",     desc:"將 ETF 與基金加入收藏清單，建立自己的投資商品庫。",                    cta:"前往ETF篩選器", href:"/etf" },
              { icon:"👀", title:"觀察名單",     desc:"長期追蹤關注商品，隨時掌握動態，等待合適時機。",                       cta:"前往基金篩選器",href:"/funds" },
              { icon:"📋", title:"分析結果保存", desc:"人格分析與商品篩選結果永久保存，隨時回顧每次決策過程。",                cta:"開始人格分析",  href:"/quiz" },
              { icon:"📊", title:"比較中心",     desc:"建立自己的比較清單，ETF 與基金混合比較，找出最符合需求的商品。",       cta:"前往比較中心",  href:"/compare" },
            ].map(m => (
              <div key={m.title} className="flex flex-col border border-slate-100 rounded-2xl overflow-hidden hover:shadow-lg transition-all">
                <div className="bg-[#0a1628] p-6">
                  <div className="text-[40px] mb-3">{m.icon}</div>
                  <div className="text-[20px] font-black text-white">{m.title}</div>
                </div>
                <div className="p-6 flex flex-col flex-1">
                  <div className="text-[16px] text-slate-500 leading-relaxed flex-1">{m.desc}</div>
                  <a href={m.href}
                    className="mt-5 block text-center border border-[#F5B700]/50 text-[#b38600] py-2.5 rounded-xl text-[15px] font-semibold hover:bg-[#F5B700]/10 transition-colors">
                    {m.cta} →
                  </a>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-12">
            <Link href="/quiz"
              className="inline-block bg-[#0a1628] hover:bg-[#0d1f3c] text-white px-12 py-4 rounded-xl font-black text-[20px] transition-colors">
              立即建立我的帳號 →
            </Link>
            <div className="text-[15px] text-slate-400 mt-3">建立帳號後，所有資料保存在你的裝置上</div>
          </div>
        </div>
      </section>

      {/* ══ ZONE 4：開始使用 SmartMatch（白底）══════════════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">GET STARTED</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">開始使用 SmartMatch</h2>
          </div>
          <div className="grid grid-cols-5 gap-4 relative">
            {[
              { step:"STEP 1", icon:"👤", title:"建立帳號",       desc:"免費註冊，30 秒完成" },
              { step:"STEP 2", icon:"🏠", title:"設定首頁模組",   desc:"選擇你想追蹤的市場與商品" },
              { step:"STEP 3", icon:"🧠", title:"完成投資分析",   desc:"20題問卷了解投資風格" },
              { step:"STEP 4", icon:"⭐", title:"收藏與追蹤商品", desc:"建立自己的ETF與基金清單" },
              { step:"STEP 5", icon:"💾", title:"建立投資資料庫", desc:"分析結果與追蹤記錄永久保存" },
            ].map((s, i) => (
              <div key={s.step} className="relative">
                {i < 4 && (
                  <div className="absolute top-[52px] left-[calc(100%-8px)] w-[calc(100%-16px)] h-0.5 z-10 hidden lg:block"
                    style={{ background:"linear-gradient(90deg,#F5B700,rgba(245,183,0,0.2))" }} />
                )}
                <div className="bg-white border border-slate-100 rounded-2xl p-6 text-center hover:shadow-md transition-shadow relative z-20">
                  <div className="text-[11px] tracking-[4px] text-[#F5B700] font-semibold mb-3">{s.step}</div>
                  <div className="text-[36px] mb-3">{s.icon}</div>
                  <div className="text-[18px] font-bold text-[#0a1628] mb-2">{s.title}</div>
                  <div className="text-[15px] text-slate-500 leading-relaxed">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="text-center mt-10">
            <Link href="/quiz"
              className="inline-block bg-[#F5B700] hover:bg-[#e0a800] text-[#020817] px-12 py-4 rounded-xl font-black text-[20px] transition-colors">
              立即打造我的首頁 →
            </Link>
          </div>
        </div>
      </section>

      {/* ══ ZONE 5：全球市場概況（深藍）════════════════════════════ */}
      <section className="relative z-10 py-20" style={{ backgroundColor:"#0a1628" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="flex items-end justify-between mb-8">
            <div>
              <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-3">GLOBAL MARKETS</div>
              <h2 className="text-[40px] font-black text-white">全球市場概況</h2>
              <p className="text-[16px] text-white/40 mt-1">示意資料・非即時行情</p>
            </div>
            <Link href="/markets" className="text-[16px] font-semibold text-[#F5B700] border border-[#F5B700]/40 px-5 py-2.5 rounded-lg hover:bg-[#F5B700]/10 transition-colors">
              完整市場中心 →
            </Link>
          </div>
          {MARKET_GROUPS.map(g => <MktRow key={g.id} group={g} />)}
        </div>
      </section>

      {/* ══ ZONE 6：熱門申購排行（白底）════════════════════════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#ffffff" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-12">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-3">HOT PICKS</div>
            <h2 className="text-[40px] font-black text-[#0a1628]">熱門申購排行榜</h2>
            <p className="text-[16px] text-slate-400 mt-2">近一週資金淨流入排行・示意資料</p>
          </div>
          <div className="grid grid-cols-2 gap-8">
            <div>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[20px]">📊</span>
                <h3 className="text-[20px] font-bold text-[#0a1628]">ETF 近1年績效 Top 5</h3>
              </div>
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <table className="w-full text-[15px]">
                  <thead><tr className="bg-slate-50 text-slate-400 text-[13px]">
                    <th className="px-4 py-3 text-left w-8">#</th>
                    <th className="px-4 py-3 text-left">代碼</th>
                    <th className="px-4 py-3 text-left">名稱</th>
                    <th className="px-4 py-3 text-right">殖利率</th>
                    <th className="px-4 py-3 text-right">近1年</th>
                  </tr></thead>
                  <tbody>
                    {getHomeTopEtfs().map((e, i) => (
                      <tr key={e.code} className="border-t border-slate-50 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-2.5"><span className={`text-[13px] font-bold ${i<3?"text-[#b38600]":"text-slate-300"}`}>{i+1}</span></td>
                        <td className="px-4 py-2.5 font-bold text-[#b38600]">{e.code}</td>
                        <td className="px-4 py-2.5 text-slate-600 truncate max-w-[140px]">{e.name}</td>
                        <td className="px-4 py-2.5 text-right text-slate-500">{e.dividendYield>0?`${e.dividendYield.toFixed(1)}%`:"—"}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${e.return1y>=0?"text-emerald-600":"text-red-500"}`}>{e.return1y>=0?"+":""}{e.return1y.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-right">
                <Link href="/etf" className="text-[14px] text-[#b38600] hover:underline">查看完整排行榜 →</Link>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-[20px]">🏦</span>
                <h3 className="text-[20px] font-bold text-[#0a1628]">基金近1年績效 Top 5</h3>
              </div>
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <table className="w-full text-[15px]">
                  <thead><tr className="bg-slate-50 text-slate-400 text-[13px]">
                    <th className="px-4 py-3 text-left w-8">#</th>
                    <th className="px-4 py-3 text-left">公司</th>
                    <th className="px-4 py-3 text-left">基金名稱</th>
                    <th className="px-4 py-3 text-right">年化配息</th>
                    <th className="px-4 py-3 text-right">近1年</th>
                  </tr></thead>
                  <tbody>
                    {getHomeTopFunds().map((f, i) => (
                      <tr key={f.id} className="border-t border-slate-50 hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-2.5"><span className={`text-[13px] font-bold ${i<3?"text-[#b38600]":"text-slate-300"}`}>{i+1}</span></td>
                        <td className="px-4 py-2.5 text-slate-500 text-[13px]">{f.company}</td>
                        <td className="px-4 py-2.5 text-slate-600 truncate max-w-[160px]">{f.name}</td>
                        <td className="px-4 py-2.5 text-right font-semibold text-[#b38600]">{f.dividendYieldA>0?`${f.dividendYieldA.toFixed(1)}%`:"—"}</td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${f.return1y>=0?"text-emerald-600":"text-red-500"}`}>{f.return1y>=0?"+":""}{f.return1y.toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 text-right">
                <Link href="/funds" className="text-[14px] text-[#b38600] hover:underline">查看完整排行榜 →</Link>
              </div>
            </div>
          </div>
          <p className="text-[14px] text-slate-400 mt-6 text-center">以上排行為示意範例，非即時申購數據，僅供功能展示。</p>
        </div>
      </section>

      {/* ══ ZONE 7：About SmartMatch（深藍）════════════════════════ */}
      <section className="relative z-10 py-24" style={{ backgroundColor:"#0a1628" }}>
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="text-center mb-14">
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-4">ABOUT</div>
            <h2 className="text-[40px] font-black text-white">關於 SmartMatch</h2>
            <p className="text-[18px] text-slate-400 mt-3 max-w-[680px] mx-auto leading-relaxed">
              投資資料分析平台。整合市場數據、ETF 與基金資料庫、商品比較、個人化儀表板與分析工具，幫助你建立更有系統的投資決策流程。
            </p>
          </div>
          <div className="grid lg:grid-cols-3 gap-6 mb-10">
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[12px] tracking-[4px] text-[#F5B700] font-semibold mb-4">PLATFORM</div>
              <h3 className="text-[20px] font-bold text-white mb-4">平台介紹</h3>
              <div className="space-y-3 text-[16px] text-slate-400 leading-relaxed">
                <p>SmartMatch 為<span className="text-white font-semibold">瑞宇智庫</span>旗下投資資料分析平台。</p>
                <p>提供個人化投資首頁、ETF 與基金資料庫、商品比較中心與資產配置分析工具。</p>
                <p>定位類似 Morningstar，以<span className="text-white">客觀數據</span>為核心，不提供投資建議。</p>
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[12px] tracking-[4px] text-[#F5B700] font-semibold mb-4">DATA SOURCES</div>
              <h3 className="text-[20px] font-bold text-white mb-4">資料來源</h3>
              <div className="space-y-2 text-[16px] text-slate-400">
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0">·</span><span>ETF：各發行商公開說明書</span></div>
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0">·</span><span>基金：投信投顧公會公開資料</span></div>
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0">·</span><span>市場指數：各交易所公開資訊</span></div>
                <div className="flex items-start gap-2"><span className="text-[#F5B700] shrink-0">·</span><span>申購排行：投信投顧公會月報</span></div>
                <p className="text-[14px] text-slate-600 mt-3">目前版本使用示意數據供功能展示。</p>
              </div>
            </div>
            <div className="bg-white/[0.04] border border-white/[0.08] rounded-2xl p-7">
              <div className="text-[12px] tracking-[4px] text-[#F5B700] font-semibold mb-4">DISCLAIMER</div>
              <h3 className="text-[20px] font-bold text-white mb-4">免責聲明</h3>
              <div className="space-y-3 text-[16px] text-slate-400 leading-relaxed">
                <p>本平台所有內容均為<span className="text-slate-300">資料分析結果</span>，不構成投資建議或買賣推薦。</p>
                <p>投資人應自行評估風險，詳閱各商品公開說明書後謹慎決策。</p>
                <p>過去績效不代表未來表現。</p>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-4">
            {[
              { num:"95+",  label:"ETF 商品",   sub:"台股＋美股" },
              { num:"269+", label:"基金商品",     sub:"前20大基金公司" },
              { num:"34+",  label:"市場指標",     sub:"台灣、美歐、亞洲、商品" },
              { num:"NT$99起", label:"多元方案", sub:"依需求升級" },
            ].map(s => (
              <div key={s.label} className="bg-white/[0.04] border border-white/[0.08] rounded-xl p-5 text-center">
                <div className="text-[36px] font-black text-[#F5B700] leading-none mb-1">{s.num}</div>
                <div className="text-[16px] font-semibold text-white mb-1">{s.label}</div>
                <div className="text-[14px] text-slate-500">{s.sub}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ FOOTER ══════════════════════════════════════════════════ */}
      <footer className="relative z-10 bg-[#060e1e] border-t border-white/[0.06] py-10">
        <div className="max-w-[1600px] mx-auto px-10">
          <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
            <div>
              <div className="text-[24px] font-black text-white">Smart<span className="text-[#F5B700]">Match</span></div>
              <div className="text-[14px] text-slate-500 mt-1">瑞宇智庫｜Investment Intelligence Platform</div>
            </div>
            <div className="flex flex-wrap gap-6 text-[16px] text-slate-500">
              <Link href="/markets" className="hover:text-slate-300 transition-colors">市場中心</Link>
              <Link href="/etf"     className="hover:text-slate-300 transition-colors">ETF資料庫</Link>
              <Link href="/funds"   className="hover:text-slate-300 transition-colors">基金資料庫</Link>
              <Link href="/compare" className="hover:text-slate-300 transition-colors">比較中心</Link>
              <Link href="/quiz"    className="hover:text-slate-300 transition-colors">人格分析</Link>
              <Link href="/clients" className="hover:text-slate-300 transition-colors">客戶管理</Link>
              <Link href="/pricing" className="hover:text-slate-300 transition-colors">方案說明</Link>
              <a href="mailto:contact@smartmatch.tw" className="hover:text-slate-300 transition-colors">聯絡我們</a>
            </div>
            <div className="text-[13px] text-slate-600 text-right">
              <div>以上資料為示意範例，不構成投資建議</div>
              <div className="mt-1">© 2026 SmartMatch｜瑞宇智庫 版權所有</div>
            </div>
          </div>
        </div>
      </footer>

    </main>
  );
}