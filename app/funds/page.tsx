"use client";
import React from "react";

import { useMemo, useState, useEffect, useCallback } from "react";
import { useWatchlist, KEY_FAV, KEY_WATCH, KEY_COMPARE, MAX_COMPARE, loadList, saveList, hasItem, toggleItem, type ListItem } from "@/lib/hooks/useWatchlist";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FUND_LIST, COMPANIES, CATEGORIES, REGIONS, type Fund } from "./data";
import { getTopFunds, type FundRankType } from "@/lib/services/rankingService";

// ── localStorage 規格書定義 ───────────────────────────────────────────
// Keys from shared hook








// ── Types ─────────────────────────────────────────────────────────────
type SortKey = "returnYTD" | "return1m" | "return3m" | "return6m" | "return1y" | "return3y" | "dividendYieldA" | "dividendYieldM" | "dividendPerUnit" | "volatility";
type SortDir = "asc" | "desc";
type FilterMode = "all" | "fav" | "watch";
type Period = "1M" | "3M" | "6M" | "1Y" | "3Y";

const PERIODS: { key: Period; label: string }[] = [
  { key: "1M", label: "1月" }, { key: "3M", label: "3月" },
  { key: "6M", label: "6月" }, { key: "1Y", label: "1年" },
  { key: "3Y", label: "3年" },
];
const LINE_COLORS = ["#F5B700", "#3b82f6", "#22c55e", "#ef4444", "#9333ea"];
const MAX_CHART = 5;

// ── Trend helpers ─────────────────────────────────────────────────────
function seededRandom(seed: string, index: number): number {
  let hash = 0;
  const str = `${seed}-${index}`;
  for (let i = 0; i < str.length; i++) { hash = (hash << 5) - hash + str.charCodeAt(i); hash |= 0; }
  return (Math.abs(hash) % 1000) / 1000;
}
function generateTrend(fund: Fund, period: Period): number[] {
  const pts = { "1M": 22, "3M": 13, "6M": 12, "1Y": 12, "3Y": 18 }[period];
  const ret = { "1M": fund.return1m, "3M": fund.return3m, "6M": fund.return6m, "1Y": fund.return1y, "3Y": fund.return3y }[period] / 100;
  const end = 100 * (1 + ret);
  const result: number[] = [];
  for (let i = 0; i < pts; i++) {
    const p = i / (pts - 1);
    result.push(Math.round((100 + (end - 100) * p + (seededRandom(fund.id, i) - 0.5) * Math.abs(end - 100) * 0.2) * 100) / 100);
  }
  result[0] = 100;
  result[result.length - 1] = Math.round(end * 100) / 100;
  return result;
}

// ── Toast ─────────────────────────────────────────────────────────────
function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 2000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[999] bg-[#1a2540] border border-white/20 text-white text-[14px] font-semibold px-6 py-3 rounded-full shadow-xl">
      {msg}
    </div>
  );
}

// ── Morningstar ───────────────────────────────────────────────────────
function Stars({ n }: { n: number }) {
  return <span className="text-[#F5B700] text-[13px] tracking-tight">{"★".repeat(n)}</span>;
}

// ── Action buttons ────────────────────────────────────────────────────
function ActionBtns({ fund, favList, watchList, compareList, onFav, onWatch, onCompare }: {
  fund: Fund;
  favList: ListItem[]; watchList: ListItem[]; compareList: ListItem[];
  onFav: (f: Fund) => void; onWatch: (f: Fund) => void; onCompare: (f: Fund) => void;
}) {
  const isFav     = hasItem(favList, fund.id);
  const isWatch   = hasItem(watchList, fund.id);
  const isCompare = hasItem(compareList, fund.id);
  return (
    <div className="flex items-center gap-1">
      <button onClick={() => onFav(fund)} title={isFav ? "取消收藏" : "加入收藏"}
        className={`w-7 h-7 rounded-lg flex items-center justify-center text-[13px] transition-all ${isFav ? "bg-[#F5B700]/20 text-[#F5B700]" : "bg-white/[0.04] text-slate-500 hover:bg-[#F5B700]/10 hover:text-[#F5B700]"}`}>
        ⭐
      </button>
      <button onClick={() => onWatch(fund)} title={isWatch ? "從觀察移除" : "加入觀察名單"}
        className={`w-7 h-7 rounded-lg flex items-center justify-center text-[13px] transition-all ${isWatch ? "bg-blue-500/20 text-blue-400" : "bg-white/[0.04] text-slate-500 hover:bg-blue-500/10 hover:text-blue-400"}`}>
        👀
      </button>
      <button onClick={() => onCompare(fund)} title={isCompare ? "從比較移除" : "加入比較"}
        className={`w-7 h-7 rounded-lg flex items-center justify-center text-[13px] transition-all ${isCompare ? "bg-emerald-500/20 text-emerald-400" : "bg-white/[0.04] text-slate-500 hover:bg-emerald-500/10 hover:text-emerald-400"}`}>
        📊
      </button>
    </div>
  );
}

// ── Pct ──────────────────────────────────────────────────────────────
function Pct({ v }: { v: number }) {
  return <span className={`font-semibold ${v >= 0 ? "text-emerald-400" : "text-red-400"}`}>{v >= 0 ? "+" : ""}{v.toFixed(1)}%</span>;
}

// ── Main ──────────────────────────────────────────────────────────────
// ── 基金熱門排行榜元件 ──────────────────────────────────────────────
type FundRankTab = "hot30" | "hot90" | "best1y";

function FundRanking() {
  const [tab, setTab] = useState<FundRankTab>("best1y");

  const ranked = useMemo(() => {
    const list = [...FUND_LIST];
    if (tab === "hot30")  return list.sort((a,b) => b.return1m - a.return1m).slice(0,10);
    if (tab === "hot90")  return list.sort((a,b) => b.return3m - a.return3m).slice(0,10);
    return               list.sort((a,b) => b.return1y - a.return1y).slice(0,10);
  }, [tab]);

  const tabs: { key: FundRankTab; label: string }[] = [
    { key:"best1y", label:"近1年績效最佳" },
    { key:"hot30",  label:"近30日熱門"   },
    { key:"hot90",  label:"近3個月熱門"  },
  ];

  return (
    <div className="mb-10 border border-white/[0.08] rounded-2xl overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]" style={{ background:"rgba(15,22,42,0.9)" }}>
        <div className="text-[18px] font-bold text-white">🏆 熱門基金排行榜</div>
        <div className="flex gap-2">
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded-lg text-[13px] font-semibold transition-colors ${tab===t.key?"bg-[#F5B700] text-[#0B1220]":"border border-white/15 text-slate-400 hover:border-[#F5B700]/50"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <table className="w-full text-left">
        <thead>
          <tr className="bg-white/[0.04] text-slate-500 text-[12px]">
            <th className="px-4 py-3 font-semibold w-[40px]">排名</th>
            <th className="px-4 py-3 font-semibold w-[60px]">公司</th>
            <th className="px-4 py-3 font-semibold">基金名稱</th>
            <th className="px-4 py-3 font-semibold text-center w-[70px]">晨星</th>
            <th className="px-4 py-3 font-semibold text-right w-[90px]">月配息率</th>
            <th className="px-4 py-3 font-semibold text-right w-[100px]">年化配息率</th>
            <th className="px-4 py-3 font-semibold text-right w-[90px]">近1年績效</th>
            <th className="px-4 py-3 font-semibold text-right w-[80px]">波動度</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((fund, i) => (
            <tr key={fund.id}
              className={`text-[13px] border-t border-white/[0.05] hover:bg-[#F5B700]/[0.04] transition-colors ${i%2===1?"bg-white/[0.015]":""}`}>
              <td className="px-4 py-2.5">
                <span className={`text-[15px] font-black ${i===0?"text-[#FFD700]":i===1?"text-[#C0C0C0]":i===2?"text-[#CD7F32]":"text-slate-600"}`}>
                  {i+1}
                </span>
              </td>
              <td className="px-4 py-2.5 font-bold text-white text-[12px]">{fund.company}</td>
              <td className="px-4 py-2.5 text-slate-200 truncate max-w-[220px]">{fund.name}</td>
              <td className="px-4 py-2.5 text-center text-[#F5B700] text-[13px]">{"★".repeat(fund.morningstar)}</td>
              <td className="px-4 py-2.5 text-right text-slate-300">{fund.dividendYieldM>0?`${fund.dividendYieldM.toFixed(2)}%`:"—"}</td>
              <td className="px-4 py-2.5 text-right font-semibold text-[#F5B700]">{fund.dividendYieldA>0?`${fund.dividendYieldA.toFixed(1)}%`:"—"}</td>
              <td className={`px-4 py-2.5 text-right font-bold ${fund.return1y>=0?"text-emerald-400":"text-red-400"}`}>
                {fund.return1y>=0?"+":""}{fund.return1y.toFixed(1)}%
              </td>
              <td className="px-4 py-2.5 text-right text-slate-500">{fund.volatility.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="px-6 py-3 border-t border-white/[0.06] text-[12px] text-slate-600">
        排行依選定期間績效排序，示意資料，非即時行情
      </div>
    </div>
  );
}


// ── 基金排行榜元件（使用 Ranking Service）──────────────────────
const FUND_RANK_TABS: { key: FundRankType; label: string }[] = [
  { key: "best1y", label: "近1年績效" },
  { key: "hot30",  label: "近30日熱門" },
  { key: "hot90",  label: "近3個月熱門" },
  { key: "yieldM", label: "月配息率" },
  { key: "yieldA", label: "年化配息率" },
  { key: "lowvol", label: "低波動" },
];

function FundRankingTable() {
  const [tab, setTab] = React.useState<FundRankType>("best1y");
  const ranked = React.useMemo(() => getTopFunds(tab, 10), [tab]);

  return (
    <div className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <div className="text-[17px] font-bold text-white">🏆 熱門基金排行榜</div>
        <div className="flex gap-2 flex-wrap justify-end">
          {FUND_RANK_TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ${
                tab === t.key
                  ? "bg-[#F5B700] text-[#0B1220]"
                  : "border border-white/[0.15] text-slate-400 hover:border-[#F5B700]/50 hover:text-[#F5B700]"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {ranked.map((fund, i) => (
          <div key={fund.id}
            className={`flex items-center gap-4 px-4 py-3 rounded-xl border transition-colors hover:border-[#F5B700]/20 ${
              i === 0 ? "bg-yellow-500/5 border-yellow-500/20" :
              i === 1 ? "bg-slate-400/5 border-slate-400/15" :
              i === 2 ? "bg-orange-500/5 border-orange-500/20" :
              "bg-white/[0.02] border-white/[0.06]"
            }`}>
            <div className="flex items-center justify-center w-8 shrink-0">
              {i === 0 ? <span className="text-[20px]">🥇</span> :
               i === 1 ? <span className="text-[20px]">🥈</span> :
               i === 2 ? <span className="text-[20px]">🥉</span> :
               <span className="w-7 h-7 rounded-full bg-white/[0.06] border border-white/[0.1] flex items-center justify-center text-[13px] font-bold text-slate-500">{i + 1}</span>}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-bold text-white">{fund.company}</span>
                <span className="text-[#F5B700] text-[12px]">{"★".repeat(fund.morningstar)}</span>
              </div>
              <div className="text-[12px] text-slate-400 truncate">{fund.name}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[11px] text-slate-500 mb-0.5">月配息率</div>
              <div className="text-[13px] font-semibold text-[#F5B700]">
                {fund.dividendYieldM > 0 ? `${fund.dividendYieldM.toFixed(2)}%` : "—"}
              </div>
            </div>
            <div className="text-right shrink-0 w-[72px]">
              <div className="text-[11px] text-slate-500 mb-0.5">近1年</div>
              <div className={`text-[15px] font-black ${fund.return1y >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {fund.return1y >= 0 ? "+" : ""}{fund.return1y.toFixed(1)}%
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[11px] text-slate-600 text-right">
        排行依選定指標排序・示意資料・非即時行情
      </div>
    </div>
  );
}


export default function FundsPage() {
  const router = useRouter();

  const [keyword,     setKeyword]     = useState("");
  const [company,     setCompany]     = useState("全部");
  const [category,    setCategory]    = useState("全部");
  const [region,      setRegion]      = useState("全部");
  const [sortKey,     setSortKey]     = useState<SortKey>("return1y");
  const [sortDir,     setSortDir]     = useState<SortDir>("desc");
  const [filterMode,  setFilterMode]  = useState<FilterMode>("all");
  const [chartFunds,  setChartFunds]  = useState<Fund[]>([]);

  const toggleChart = (fund: Fund) => {
    setChartFunds(prev =>
      prev.find(f => f.id === fund.id)
        ? prev.filter(f => f.id !== fund.id)
        : prev.length < MAX_CHART ? [...prev, fund] : prev
    );
  };
  const [chartPeriod, setChartPeriod] = useState<Period>("1Y");

  const {
    favList, watchList, compareList,
    toggleFav: _tFav, toggleWatch: _tWatch, toggleCompare: _tCompare,
    clearCompare, toast, showToast,
  } = useWatchlist("fund");
  const toggleFav     = useCallback((f: Fund) => _tFav({ id: f.id, type: "fund", name: f.name }), [_tFav]);
  const toggleWatch   = useCallback((f: Fund) => _tWatch({ id: f.id, type: "fund", name: f.name }), [_tWatch]);
  const toggleCompare = useCallback((f: Fund) => _tCompare({ id: f.id, type: "fund", name: f.name }), [_tCompare]);





  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  const filtered = useMemo(() => {
    let list = FUND_LIST;
    if (filterMode === "fav")   list = list.filter(f => hasItem(favList, f.id));
    if (filterMode === "watch") list = list.filter(f => hasItem(watchList, f.id));
    if (keyword.trim()) {
      const kw = keyword.trim().toLowerCase();
      list = list.filter(f => f.name.toLowerCase().includes(kw) || f.company.toLowerCase().includes(kw));
    }
    if (company  !== "全部") list = list.filter(f => f.company  === company);
    if (category !== "全部") list = list.filter(f => f.category === category);
    if (region   !== "全部") list = list.filter(f => f.region   === region);
    return [...list].sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return sortDir === "asc" ? diff : -diff;
    });
  }, [keyword, company, category, region, sortKey, sortDir, filterMode, favList, watchList]);

  function SortTh({ label, k }: { label: string; k: SortKey }) {
    return (
      <th onClick={() => handleSort(k)}
        className="px-3 py-3 font-semibold cursor-pointer select-none hover:text-[#F5B700] transition-colors whitespace-nowrap text-[12px]">
        <span className="flex items-center gap-1">
          {label}
          <span className="text-[10px] opacity-60">{sortKey === k ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span>
        </span>
      </th>
    );
  }

  // TrendChart
  function TrendChart({ funds, period }: { funds: Fund[]; period: Period }) {
    const W = 1100, H = 260;
    const pad = { top: 16, right: 16, bottom: 28, left: 48 };
    const series = funds.map(f => generateTrend(f, period));
    const all = series.flat();
    const minV = Math.min(...all), maxV = Math.max(...all), range = maxV - minV || 1;
    const cW = W - pad.left - pad.right, cH = H - pad.top - pad.bottom;
    const toX = (i: number, n: number) => pad.left + (i / (n - 1)) * cW;
    const toY = (v: number) => pad.top + cH - ((v - minV) / range) * cH;
    return (
      <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[260px]">
          {[0, 0.25, 0.5, 0.75, 1].map(t => {
            const y = pad.top + cH * t;
            return (
              <g key={t}>
                <line x1={pad.left} y1={y} x2={W - pad.right} y2={y} stroke="#1e293b" strokeWidth="1" />
                <text x={4} y={y + 4} fontSize="10" fill="#64748b">{(maxV - range * t).toFixed(0)}</text>
              </g>
            );
          })}
          {series.map((data, si) => (
            <polyline key={si}
              points={data.map((v, i) => `${toX(i, data.length)},${toY(v)}`).join(" ")}
              fill="none" stroke={LINE_COLORS[si]} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          ))}
        </svg>
      </div>
    );
  }

  const fundFavCount   = favList.length;
  const fundWatchCount = watchList.length;

  return (
    <main className="min-h-screen px-6 pt-32 pb-20">

      {/* NAVBAR */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#040a18]/85 backdrop-blur-xl border-b border-white/[0.08]">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <Link href="/">
            <div className="text-[28px] font-black text-white leading-none">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[11px] text-slate-400 mt-0.5">ETF & 基金資產配置分析平台</div>
          </Link>
          <nav className="hidden lg:flex gap-7 text-[14px] font-semibold text-slate-300">
            <Link href="/quiz"    className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf"     className="hover:text-white transition-colors">ETF篩選器</Link>
            <Link href="/funds"   className="text-[#F5B700]">基金篩選器</Link>
            <Link href="/compare" className="hover:text-white transition-colors">比較中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="hover:text-white transition-colors">方案</Link>
          </nav>
          <div className="flex items-center gap-3">
            <a href="#" className="text-[14px] font-semibold text-slate-300 border border-white/30 px-4 py-2 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5B700] hover:bg-[#e0a800] text-[#0B1220] px-5 py-2 rounded-lg font-bold text-[14px] transition-colors">免費註冊</Link>
          </div>
        </div>
      </header>

      <div className="max-w-[1600px] mx-auto">

        <div className="mb-8">
          <div className="tracking-[10px] text-[#F5B700] text-[14px] font-semibold mb-3">FUND DATABASE</div>
          <h1 className="text-[42px] font-black text-white">基金篩選器</h1>
          <p className="text-[15px] text-slate-400 mt-1">共 {FUND_LIST.length} 檔基金・前20大基金公司・支援收藏、觀察名單與比較</p>
        </div>

        {/* ══ 熱門基金排行榜 ══════════════════════════════════════ */}
        <FundRanking />

                {/* ══ 基金排行榜 ══ */}
        <FundRankingTable />

        {/* Compare bar */}
        {compareList.length > 0 && (
          <div className="flex items-center justify-between bg-emerald-900/30 border border-emerald-500/30 rounded-xl px-5 py-3 mb-5">
            <div className="text-[13px] text-emerald-300 font-semibold">
              📊 比較清單：{compareList.length} 檔
            </div>
            <div className="flex gap-3">
              <button onClick={() => clearCompare()}
                className="text-[12px] text-slate-500 hover:text-red-400 transition-colors">清除</button>
              <button onClick={() => router.push("/compare")}
                className="bg-emerald-700 hover:bg-emerald-600 text-white text-[12px] font-bold px-4 py-1.5 rounded-lg transition-colors">
                前往比較中心 →
              </button>
            </div>
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex gap-2 mb-5">
          {([
            { key: "all"   as FilterMode, label: `全部 (${FUND_LIST.length})` },
            { key: "fav"   as FilterMode, label: `⭐ 收藏 (${fundFavCount})` },
            { key: "watch" as FilterMode, label: `👀 觀察名單 (${fundWatchCount})` },
          ]).map(tab => (
            <button key={tab.key} onClick={() => setFilterMode(tab.key)}
              className={`px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors ${
                filterMode === tab.key ? "bg-[#F5B700] text-[#0B1220]" : "border border-white/15 text-slate-400 hover:border-white/30"
              }`}>
              {tab.label}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-4">
          <input type="text" value={keyword} onChange={e => setKeyword(e.target.value)}
            placeholder="搜尋基金名稱或公司"
            className="flex-1 min-w-[180px] bg-transparent border border-white/20 rounded-lg px-4 py-2.5 text-[14px] text-white placeholder:text-slate-500 focus:outline-none focus:border-[#F5B700]" />
          <select value={company} onChange={e => setCompany(e.target.value)}
            className="bg-[#040a18] border border-white/20 rounded-lg px-3 py-2.5 text-[14px] text-white focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部公司</option>
            {COMPANIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={category} onChange={e => setCategory(e.target.value)}
            className="bg-[#040a18] border border-white/20 rounded-lg px-3 py-2.5 text-[14px] text-white focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部類型</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={region} onChange={e => setRegion(e.target.value)}
            className="bg-[#040a18] border border-white/20 rounded-lg px-3 py-2.5 text-[14px] text-white focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部地區</option>
            {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>

        <div className="flex items-center justify-between mb-3">
          <div className="text-[12px] text-slate-600">符合條件：{filtered.length} 檔</div>
          {chartFunds.length > 0 && <div className="text-[12px] text-[#F5B700]">已選 {chartFunds.length} 檔走勢比較</div>}
        </div>

        {/* Table */}
        <div className="border border-white/10 rounded-2xl overflow-hidden mb-8">
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[1400px]">
              <thead>
                <tr className="bg-white/[0.06] text-slate-400 text-[12px]">
                  <th className="px-3 py-3 font-semibold w-[88px]">操作</th>
                  <th className="px-3 py-3 font-semibold w-[26px]">圖</th>
                  <th className="px-3 py-3 font-semibold min-w-[60px]">公司</th>
                  <th className="px-4 py-3 font-semibold min-w-[180px]">基金名稱</th>
                  <th className="px-3 py-3 font-semibold">類別</th>
                  <th className="px-3 py-3 font-semibold">地區</th>
                  <th className="px-3 py-3 font-semibold">晨星</th>
                  <th className="px-3 py-3 font-semibold">配息頻率</th>
                  <SortTh label="每單位配息" k="dividendPerUnit" />
                  <SortTh label="月配息率%" k="dividendYieldM" />
                  <SortTh label="年化配息率%" k="dividendYieldA" />
                  <SortTh label="今年以來%" k="returnYTD" />
                  <SortTh label="近1月%" k="return1m" />
                  <SortTh label="近3月%" k="return3m" />
                  <SortTh label="近6月%" k="return6m" />
                  <SortTh label="近1年%" k="return1y" />
                  <SortTh label="近3年%" k="return3y" />
                  <SortTh label="波動度%" k="volatility" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((fund, i) => {
                  const inChart  = chartFunds.find(f => f.id === fund.id);
                  const chartIdx = chartFunds.findIndex(f => f.id === fund.id);
                  return (
                    <tr key={fund.id}
                      className={`text-[12px] text-white border-t border-white/[0.04] hover:bg-[#F5B700]/[0.04] transition-colors ${i % 2 === 1 ? "bg-white/[0.015]" : ""}`}>
                      <td className="px-3 py-2.5">
                        <ActionBtns fund={fund} favList={favList} watchList={watchList} compareList={compareList}
                          onFav={toggleFav} onWatch={toggleWatch} onCompare={toggleCompare} />
                      </td>
                      <td className="px-2 py-2.5">
                        <button onClick={() => toggleChart(fund)}
                          disabled={!inChart && chartFunds.length >= MAX_CHART}
                          title={inChart ? "移除走勢" : "加入走勢比較"}
                          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center text-[9px] font-bold transition-all ${
                            inChart ? "border-transparent text-white" : "border-white/20 hover:border-[#F5B700] disabled:opacity-20"
                          }`}
                          style={inChart ? { backgroundColor: LINE_COLORS[chartIdx] } : {}}>
                          {inChart ? "✓" : ""}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 font-bold text-white">{fund.company}</td>
                      <td className="px-4 py-2.5 text-slate-300 max-w-[180px] truncate">{fund.name}</td>
                      <td className="px-3 py-2.5">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                          fund.category === "股票型" ? "bg-blue-900/60 text-blue-300" :
                          fund.category === "債券型" ? "bg-white/[0.06] text-slate-400" :
                          fund.category === "平衡型" ? "bg-purple-900/60 text-purple-300" :
                          "bg-emerald-900/60 text-emerald-300"
                        }`}>{fund.category}</span>
                      </td>
                      <td className="px-3 py-2.5 text-slate-500 text-[11px]">{fund.region}</td>
                      <td className="px-3 py-2.5"><Stars n={fund.morningstar} /></td>
                      <td className="px-3 py-2.5 text-slate-500 text-[11px]">{fund.dividendFreq}</td>
                      <td className="px-3 py-2.5 text-slate-300">{fund.dividendPerUnit > 0 ? fund.dividendPerUnit.toFixed(4) : "—"}</td>
                      <td className="px-3 py-2.5 text-slate-300">{fund.dividendYieldM > 0 ? `${fund.dividendYieldM.toFixed(3)}%` : "—"}</td>
                      <td className="px-3 py-2.5 font-semibold text-[#F5B700]">{fund.dividendYieldA > 0 ? `${fund.dividendYieldA.toFixed(1)}%` : "—"}</td>
                      <td className="px-3 py-2.5"><Pct v={fund.returnYTD} /></td>
                      <td className="px-3 py-2.5"><Pct v={fund.return1m} /></td>
                      <td className="px-3 py-2.5"><Pct v={fund.return3m} /></td>
                      <td className="px-3 py-2.5"><Pct v={fund.return6m} /></td>
                      <td className="px-3 py-2.5"><Pct v={fund.return1y} /></td>
                      <td className="px-3 py-2.5"><Pct v={fund.return3y} /></td>
                      <td className="px-3 py-2.5 text-slate-400">{fund.volatility.toFixed(1)}%</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={18} className="px-5 py-12 text-center text-slate-600">
                    {filterMode === "fav"   ? "尚未收藏任何基金，點擊 ⭐ 加入收藏" :
                     filterMode === "watch" ? "觀察名單是空的，點擊 👀 加入" :
                     "找不到符合條件的基金"}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* 走勢比較圖 */}
        {chartFunds.length > 0 ? (
          <div className="border border-white/10 rounded-2xl p-7 mb-8">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
              <div className="text-[18px] font-bold text-white">走勢比較（起點＝100）</div>
              <div className="flex gap-2">
                {PERIODS.map(p => (
                  <button key={p.key} onClick={() => setChartPeriod(p.key)}
                    className={`px-4 py-1.5 rounded-lg text-[12px] font-semibold transition-colors ${
                      chartPeriod === p.key ? "bg-[#F5B700] text-[#0B1220]" : "border border-white/20 text-slate-400 hover:border-[#F5B700]"
                    }`}>{p.label}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-4 mb-4">
              {chartFunds.map((fund, i) => (
                <div key={fund.id} className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: LINE_COLORS[i] }} />
                  <span className="text-[12px] font-semibold text-white">{fund.company}</span>
                  <span className="text-[11px] text-slate-500 truncate max-w-[110px]">{fund.name}</span>
                  <button onClick={() => toggleChart(fund)} className="text-slate-600 hover:text-red-400 text-[10px] ml-1">✕</button>
                </div>
              ))}
              <button onClick={() => setChartFunds([])} className="text-slate-600 text-[11px] hover:text-red-400">清除</button>
            </div>
            <TrendChart funds={chartFunds} period={chartPeriod} />
            <p className="text-[11px] text-slate-700 mt-2">走勢為示意模擬，非真實歷史淨值。</p>
          </div>
        ) : (
          <div className="border border-dashed border-white/[0.06] rounded-2xl p-5 mb-8 text-center text-slate-700 text-[12px]">
            點擊表格「圖」欄圓圈，加入最多 {MAX_CHART} 檔基金進行走勢比較
          </div>
        )}

        <p className="text-[11px] text-slate-700 mt-4 text-center">以上資料為示意範例，不構成投資建議。</p>

        <div className="flex justify-center mt-8 gap-4">
          <Link href="/compare" className="border border-white/20 text-white px-7 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[14px]">ETF+基金比較中心</Link>
          <Link href="/"        className="border border-white/20 text-white px-7 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[14px]">回到首頁</Link>
        </div>
      </div>

      {toast && <Toast msg={toast} onClose={() => {}} />}
    </main>
  );
}