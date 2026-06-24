"use client";

import { useState } from "react";
import Link from "next/link";

// ── 市場資料 ──────────────────────────────────────────────────────────
type MktItem = {
  name: string;
  value: string;
  pts: string;
  pct: string;
  up: boolean;
};

type MktSection = {
  id: string;
  label: string;
  emoji: string;
  items: MktItem[];
};

const SECTIONS: MktSection[] = [
  {
    id: "tw", label: "台灣", emoji: "🇹🇼",
    items: [
      { name: "加權指數",   value: "22,184.32", pts: "+184.32", pct: "+0.84%", up: true  },
      { name: "台指期近月", value: "22,210.00", pts: "+128.00", pct: "+0.58%", up: true  },
      { name: "櫃買指數",   value: "248.32",    pts: "+1.85",   pct: "+0.75%", up: true  },
      { name: "電子指數",   value: "1,092.44",  pts: "+9.84",   pct: "+0.91%", up: true  },
      { name: "金融指數",   value: "2,184.12",  pts: "+12.40",  pct: "+0.57%", up: true  },
    ],
  },
  {
    id: "us", label: "美國", emoji: "🇺🇸",
    items: [
      { name: "道瓊 DJIA",    value: "43,408.47", pts: "+228.41", pct: "+0.53%", up: true  },
      { name: "NASDAQ",        value: "19,271.34", pts: "+162.25", pct: "+0.85%", up: true  },
      { name: "S&P 500",       value: "5,842.01",  pts: "+39.52",  pct: "+0.68%", up: true  },
      { name: "費城半導體 SOX", value: "5,124.18",  pts: "+62.10",  pct: "+1.23%", up: true  },
      { name: "Russell 2000",  value: "2,218.44",  pts: "-6.89",   pct: "-0.31%", up: false },
      { name: "VIX 恐慌指數",  value: "13.42",     pts: "-0.16",   pct: "-1.19%", up: false },
    ],
  },
  {
    id: "asia", label: "亞洲", emoji: "🌏",
    items: [
      { name: "日經 225",          value: "39,842.21", pts: "+411.24", pct: "+1.04%", up: true  },
      { name: "恒生指數",          value: "23,184.45", pts: "-109.60", pct: "-0.47%", up: false },
      { name: "韓國 KOSPI",        value: "2,621.15",  pts: "+15.92",  pct: "+0.61%", up: true  },
      { name: "上證綜合",          value: "3,412.18",  pts: "+7.48",   pct: "+0.22%", up: true  },
      { name: "深圳成指",          value: "10,824.32", pts: "+98.42",  pct: "+0.92%", up: true  },
      { name: "MSCI Asia ex JP",   value: "824.11",    pts: "+3.12",   pct: "+0.38%", up: true  },
    ],
  },
  {
    id: "eu", label: "歐洲", emoji: "🇪🇺",
    items: [
      { name: "德國 DAX",      value: "22,854.12", pts: "+100.56", pct: "+0.44%", up: true },
      { name: "法國 CAC 40",   value: "7,981.26",  pts: "+15.16",  pct: "+0.19%", up: true },
      { name: "英國 FTSE 100", value: "8,732.11",  pts: "+24.44",  pct: "+0.28%", up: true },
      { name: "Euro STOXX 600",value: "531.24",    pts: "+1.88",   pct: "+0.35%", up: true },
    ],
  },
  {
    id: "cmd", label: "商品", emoji: "🥇",
    items: [
      { name: "黃金 XAU/USD", value: "3,342.12", pts: "+30.18", pct: "+0.91%", up: true  },
      { name: "白銀 XAG/USD", value: "32.84",    pts: "+0.37",  pct: "+1.14%", up: true  },
      { name: "銅 HG",        value: "4.52",     pts: "+0.02",  pct: "+0.44%", up: true  },
      { name: "WTI 原油",     value: "71.28",    pts: "-0.60",  pct: "-0.83%", up: false },
      { name: "布蘭特原油",   value: "74.52",    pts: "-0.53",  pct: "-0.71%", up: false },
      { name: "天然氣 NG",    value: "2.18",     pts: "-0.04",  pct: "-1.80%", up: false },
    ],
  },
  {
    id: "fx", label: "匯率", emoji: "💱",
    items: [
      { name: "美元指數 DXY", value: "104.21", pts: "-0.18", pct: "-0.17%", up: false },
      { name: "USD/TWD",      value: "32.41",  pts: "-0.04", pct: "-0.12%", up: false },
      { name: "USD/JPY",      value: "154.82", pts: "+0.37", pct: "+0.24%", up: true  },
      { name: "EUR/USD",      value: "1.0812", pts: "+0.001",pct: "+0.09%", up: true  },
    ],
  },
  {
    id: "bond", label: "債券", emoji: "📊",
    items: [
      { name: "美國 2年公債",  value: "4.84%", pts: "+0.02%", pct: "+0.41%", up: true  },
      { name: "美國 10年公債", value: "4.28%", pts: "-0.03%", pct: "-0.69%", up: false },
      { name: "美國 30年公債", value: "4.51%", pts: "-0.02%", pct: "-0.44%", up: false },
    ],
  },
];

// ── Sparkline SVG ──────────────────────────────────────────────────────
function Sparkline({ up }: { up: boolean }) {
  const upPts   = [36,32,34,28,25,29,23,19,16,13,10,8];
  const downPts = [8,12,10,16,13,18,22,17,25,23,29,34];
  const pts = up ? upPts : downPts;
  const minV = Math.min(...pts), maxV = Math.max(...pts);
  const range = maxV - minV || 1;
  const W = 80, H = 32;
  const coords = pts.map((v, i) => {
    const x = (i / (pts.length - 1)) * W;
    const y = H - ((v - minV) / range) * (H - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = up ? "#22c55e" : "#ef4444";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0 opacity-80">
      <defs>
        <linearGradient id={`mg-${up ? "u" : "d"}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${coords} ${W},${H}`} fill={`url(#mg-${up ? "u" : "d"})`} />
      <polyline points={coords} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── 單筆指數列 ────────────────────────────────────────────────────────
function MktRow({ item, rank }: { item: MktItem; rank: number }) {
  const color = item.up ? "text-emerald-400" : "text-red-400";
  const arrow = item.up ? "▲" : "▼";
  return (
    <div className="flex items-center gap-4 px-5 py-3.5 border-b border-white/[0.05] hover:bg-white/[0.03] transition-colors">
      <span className="w-6 text-[12px] text-slate-600 shrink-0">{rank}</span>
      <span className="flex-1 text-[15px] text-slate-300 truncate">{item.name}</span>
      <span className="text-[17px] font-bold text-white w-28 text-right shrink-0">{item.value}</span>
      <span className={`text-[13px] font-semibold w-36 text-right shrink-0 ${color}`}>
        {arrow} {item.pts}
      </span>
      <span className={`text-[13px] font-bold w-20 text-right shrink-0 ${color}`}>
        {item.pct}
      </span>
      <div className="w-20 flex justify-end shrink-0">
        <Sparkline up={item.up} />
      </div>
    </div>
  );
}

// ── 市場分類區塊 ──────────────────────────────────────────────────────
function MktBlock({ section }: { section: MktSection }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] overflow-hidden mb-4"
      style={{ background: "rgba(17,24,39,0.75)", backdropFilter: "blur(16px)" }}>
      {/* 區塊標題 */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]">
        <span className="text-[22px]">{section.emoji}</span>
        <span className="text-[18px] font-bold text-white">{section.label}</span>
        <span className="ml-auto text-[12px] text-slate-500">{section.items.length} 個指標</span>
      </div>
      {/* 表頭 */}
      <div className="flex items-center gap-4 px-5 py-2 text-[11px] text-slate-600 tracking-wide border-b border-white/[0.04]">
        <span className="w-6 shrink-0">#</span>
        <span className="flex-1">指數名稱</span>
        <span className="w-28 text-right shrink-0">最新價格</span>
        <span className="w-36 text-right shrink-0">漲跌點數</span>
        <span className="w-20 text-right shrink-0">漲跌幅</span>
        <span className="w-20 text-right shrink-0">走勢</span>
      </div>
      {section.items.map((item, i) => (
        <MktRow key={item.name} item={item} rank={i + 1} />
      ))}
    </div>
  );
}

export default function MarketsPage() {
  const [search, setSearch] = useState("");

  const filtered = SECTIONS.map(s => ({
    ...s,
    items: s.items.filter(item =>
      !search.trim() ||
      item.name.toLowerCase().includes(search.toLowerCase())
    ),
  })).filter(s => s.items.length > 0);

  const totalCount = SECTIONS.reduce((sum, s) => sum + s.items.length, 0);
  const upCount = SECTIONS.flatMap(s => s.items).filter(i => i.up).length;
  const downCount = totalCount - upCount;

  return (
    <main className="min-h-screen px-6 pt-28 pb-20">

      {/* NAVBAR */}
      <header className="fixed top-0 left-0 w-full z-50 backdrop-blur-xl border-b border-white/[0.08]"
        style={{ background: "rgba(2,8,23,0.85)" }}>
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <Link href="/">
            <div className="text-[28px] font-black text-white leading-none">
              Smart<span className="text-[#F5B700]">Match</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </Link>
          <nav className="hidden lg:flex gap-7 text-[14px] font-semibold text-slate-300">
            <Link href="/quiz"    className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf"     className="hover:text-white transition-colors">ETF篩選器</Link>
            <Link href="/funds"   className="hover:text-white transition-colors">基金篩選器</Link>
            <Link href="/compare" className="hover:text-white transition-colors">比較中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="hover:text-[#F5B700] transition-colors">方案</Link>
          </nav>
          <div className="flex items-center gap-3">
            <a href="#" className="text-[14px] font-semibold text-slate-300 border border-white/30 px-4 py-2 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-5 py-2 rounded-lg font-bold text-[14px] transition-colors">免費註冊</Link>
          </div>
        </div>
      </header>

      <div className="max-w-[1200px] mx-auto">

        {/* 頁首 */}
        <div className="mb-10">
          <div className="text-[13px] tracking-[8px] text-[#F5B700] font-semibold mb-3">GLOBAL MARKETS</div>
          <h1 className="text-[48px] font-black text-white mb-2">全球市場中心</h1>
          <p className="text-[16px] text-slate-400">
            涵蓋台灣、美國、亞洲、歐洲、商品、匯率與債券，共 {totalCount} 個市場指標
          </p>
        </div>

        {/* 統計列 */}
        <div className="flex items-center gap-6 mb-8">
          <div className="flex items-center gap-2 text-[14px]">
            <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />
            <span className="text-slate-400">上漲</span>
            <span className="text-emerald-400 font-bold">{upCount}</span>
          </div>
          <div className="flex items-center gap-2 text-[14px]">
            <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
            <span className="text-slate-400">下跌</span>
            <span className="text-red-400 font-bold">{downCount}</span>
          </div>
          <div className="ml-auto text-[12px] text-slate-500">
            示意數據 · 2026/06/24 15:30 · 非即時行情
          </div>
        </div>

        {/* 搜尋 */}
        <div className="mb-8">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜尋指數名稱，例如：日經、黃金、NASDAQ"
            className="w-full bg-transparent border border-white/20 rounded-xl px-5 py-3.5 text-[15px] text-white placeholder:text-slate-600 focus:outline-none focus:border-[#F5B700] transition-colors"
          />
        </div>

        {/* 分類區塊 */}
        {filtered.length > 0 ? (
          filtered.map(s => <MktBlock key={s.id} section={s} />)
        ) : (
          <div className="text-center py-20 text-slate-500">
            找不到「{search}」相關指數
          </div>
        )}

        {/* 免責聲明 */}
        <p className="text-[12px] text-slate-600 mt-8 text-center leading-relaxed">
          以上資料為示意範例，非即時市場數據，不構成投資建議。實際行情請參考各交易所或專業金融資訊平台。
        </p>

        <div className="flex justify-center mt-8">
          <Link href="/" className="border border-white/20 text-white px-8 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">
            回到首頁
          </Link>
        </div>

      </div>
    </main>
  );
}