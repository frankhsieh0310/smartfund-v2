"use client";
import React from "react";

import { useMemo, useState, useEffect, useCallback } from "react";
import { useWatchlist, KEY_FAV, KEY_WATCH, KEY_COMPARE, MAX_COMPARE, loadList, saveList, hasItem, toggleItem, type ListItem } from "@/lib/hooks/useWatchlist";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ETF_LIST, REGIONS, SECTORS, type Etf } from "./data";
import { getTopEtfs, type EtfRankType } from "@/lib/services/rankingService";

// ── localStorage 共用 Hook（lib/hooks/useWatchlist）────────────────

// ── Types ─────────────────────────────────────────────────────────────
type SortKey = "dividendYield" | "dividendPerUnit" | "returnYTD" | "return1m" | "return3m" | "return6m" | "return1y" | "return3y" | "volatility";
type SortDir = "asc" | "desc";
type FilterMode = "all" | "fav" | "watch";

// ── Toast ─────────────────────────────────────────────────────────────
function Toast({ msg, onClose }: { msg: string; onClose: () => void }) {
  useEffect(() => {
    const t = setTimeout(onClose, 2000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[999] bg-[#1a2540] border border-white/20 text-white text-[14px] font-semibold px-6 py-3 rounded-full shadow-xl">
      {msg}
    </div>
  );
}

// ── Action buttons ────────────────────────────────────────────────────
function ActionBtns({
  etf, favList, watchList, compareList,
  onFav, onWatch, onCompare,
}: {
  etf: Etf;
  favList: ListItem[]; watchList: ListItem[]; compareList: ListItem[];
  onFav: (etf: Etf) => void;
  onWatch: (etf: Etf) => void;
  onCompare: (etf: Etf) => void;
}) {
  const isFav     = hasItem(favList, etf.code);
  const isWatch   = hasItem(watchList, etf.code);
  const isCompare = hasItem(compareList, etf.code);
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => onFav(etf)} title={isFav ? "取消收藏" : "加入收藏"}
        className={`w-8 h-8 rounded-lg flex items-center justify-center text-[14px] transition-all ${isFav ? "bg-[#F5B700]/20 text-[#F5B700]" : "bg-white/[0.04] text-slate-500 hover:bg-[#F5B700]/10 hover:text-[#F5B700]"}`}>
        ⭐
      </button>
      <button onClick={() => onWatch(etf)} title={isWatch ? "從觀察移除" : "加入觀察名單"}
        className={`w-8 h-8 rounded-lg flex items-center justify-center text-[14px] transition-all ${isWatch ? "bg-blue-500/20 text-blue-400" : "bg-white/[0.04] text-slate-500 hover:bg-blue-500/10 hover:text-blue-400"}`}>
        👀
      </button>
      <button onClick={() => onCompare(etf)} title={isCompare ? "從比較移除" : "加入比較"}
        className={`w-8 h-8 rounded-lg flex items-center justify-center text-[14px] transition-all ${isCompare ? "bg-emerald-500/20 text-emerald-400" : "bg-white/[0.04] text-slate-500 hover:bg-emerald-500/10 hover:text-emerald-400"}`}>
        📊
      </button>
    </div>
  );
}

// ── Pct ──────────────────────────────────────────────────────────────
function Pct({ v }: { v: number }) {
  return (
    <span className={`font-semibold ${v >= 0 ? "text-emerald-400" : "text-red-400"}`}>
      {v >= 0 ? "+" : ""}{v.toFixed(1)}%
    </span>
  );
}

// ── Main ──────────────────────────────────────────────────────────────
// ── ETF 熱門排行榜元件 ───────────────────────────────────────────────
type RankTab = "hot30" | "hot90" | "best1y";

function EtfRanking() {
  const [tab, setTab] = useState<RankTab>("best1y");

  const ranked = useMemo(() => {
    const list = [...ETF_LIST];
    if (tab === "hot30")  return list.sort((a,b) => b.return1m  - a.return1m).slice(0,10);
    if (tab === "hot90")  return list.sort((a,b) => b.return3m  - a.return3m).slice(0,10);
    return               list.sort((a,b) => b.return1y  - a.return1y).slice(0,10);
  }, [tab]);

  const tabs: { key: RankTab; label: string }[] = [
    { key:"best1y", label:"近1年績效最佳" },
    { key:"hot30",  label:"近30日熱門"   },
    { key:"hot90",  label:"近3個月熱門"  },
  ];

  return (
    <div className="mb-10 border border-white/[0.08] rounded-2xl overflow-hidden">
      {/* 標題列 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.08]" style={{ background:"rgba(15,22,42,0.9)" }}>
        <div className="text-[18px] font-bold text-white">🏆 熱門 ETF 排行榜</div>
        <div className="flex gap-2">
          {tabs.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded-lg text-[13px] font-semibold transition-colors ${tab===t.key?"bg-[#F5B700] text-[#0B1220]":"border border-white/15 text-slate-400 hover:border-[#F5B700]/50"}`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* 表格 */}
      <table className="w-full text-left">
        <thead>
          <tr className="bg-white/[0.04] text-slate-500 text-[12px]">
            <th className="px-5 py-3 font-semibold w-[40px]">排名</th>
            <th className="px-5 py-3 font-semibold w-[80px]">代碼</th>
            <th className="px-5 py-3 font-semibold">商品名稱</th>
            <th className="px-5 py-3 font-semibold text-right">殖利率</th>
            <th className="px-5 py-3 font-semibold text-right">近1年績效</th>
            <th className="px-5 py-3 font-semibold text-right">近3年績效</th>
            <th className="px-5 py-3 font-semibold text-right">波動度</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((etf, i) => (
            <tr key={etf.code}
              className={`text-[14px] border-t border-white/[0.05] hover:bg-[#F5B700]/[0.04] transition-colors ${i%2===1?"bg-white/[0.015]":""}`}>
              <td className="px-5 py-3">
                <span className={`text-[15px] font-black ${i===0?"text-[#FFD700]":i===1?"text-[#C0C0C0]":i===2?"text-[#CD7F32]":"text-slate-600"}`}>
                  {i+1}
                </span>
              </td>
              <td className="px-5 py-3 font-bold text-[#F5B700]">{etf.code}</td>
              <td className="px-5 py-3 text-slate-200 truncate max-w-[240px]">{etf.name}</td>
              <td className="px-5 py-3 text-right text-slate-300">{etf.dividendYield>0?`${etf.dividendYield.toFixed(1)}%`:"—"}</td>
              <td className={`px-5 py-3 text-right font-bold ${etf.return1y>=0?"text-emerald-400":"text-red-400"}`}>
                {etf.return1y>=0?"+":""}{etf.return1y.toFixed(1)}%
              </td>
              <td className={`px-5 py-3 text-right font-semibold ${etf.return3y>=0?"text-emerald-400":"text-red-400"}`}>
                {etf.return3y>=0?"+":""}{etf.return3y.toFixed(1)}%
              </td>
              <td className="px-5 py-3 text-right text-slate-500">{etf.volatility.toFixed(1)}%</td>
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


// ── ETF 排行榜元件（使用 Ranking Service）──────────────────────
const ETF_RANK_TABS: { key: EtfRankType; label: string }[] = [
  { key: "best1y", label: "近1年績效" },
  { key: "hot30",  label: "近30日熱門" },
  { key: "hot90",  label: "近3個月熱門" },
  { key: "yield",  label: "殖利率最高" },
  { key: "lowvol", label: "低波動" },
];

function RankBadge({ rank }: { rank: number }) {
  if (rank === 0) return <span className="text-[20px]">🥇</span>;
  if (rank === 1) return <span className="text-[20px]">🥈</span>;
  if (rank === 2) return <span className="text-[20px]">🥉</span>;
  return (
    <span className="w-7 h-7 rounded-full bg-white/[0.06] border border-white/[0.1] flex items-center justify-center text-[13px] font-bold text-slate-500">
      {rank + 1}
    </span>
  );
}

function EtfRankingTable() {
  const [tab, setTab] = React.useState<EtfRankType>("best1y");
  const ranked = React.useMemo(() => getTopEtfs(tab, 10), [tab]);

  return (
    <div className="mb-10">
      {/* 標題列 */}
      <div className="flex items-center justify-between mb-4">
        <div className="text-[17px] font-bold text-white">🏆 熱門 ETF 排行榜</div>
        <div className="flex gap-2 flex-wrap justify-end">
          {ETF_RANK_TABS.map(t => (
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

      {/* Card Grid */}
      <div className="space-y-2">
        {ranked.map((etf, i) => (
          <div key={etf.code}
            className={`flex items-center gap-4 px-4 py-3 rounded-xl border transition-colors hover:border-[#F5B700]/20 ${
              i === 0 ? "bg-yellow-500/5 border-yellow-500/20" :
              i === 1 ? "bg-slate-400/5 border-slate-400/15" :
              i === 2 ? "bg-orange-500/5 border-orange-500/20" :
              "bg-white/[0.02] border-white/[0.06]"
            }`}>
            <div className="flex items-center justify-center w-8 shrink-0">
              <RankBadge rank={i} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-bold text-[#F5B700]">{etf.code}</span>
                <span className="text-[11px] text-slate-500 bg-white/[0.05] px-1.5 py-0.5 rounded">{etf.sector}</span>
              </div>
              <div className="text-[13px] text-slate-400 truncate">{etf.name}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[11px] text-slate-500 mb-0.5">殖利率</div>
              <div className="text-[13px] font-semibold text-slate-300">
                {etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—"}
              </div>
            </div>
            <div className="text-right shrink-0 w-[72px]">
              <div className="text-[11px] text-slate-500 mb-0.5">近1年</div>
              <div className={`text-[15px] font-black ${etf.return1y >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {etf.return1y >= 0 ? "+" : ""}{etf.return1y.toFixed(1)}%
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


export default function EtfDatabasePage() {
  const router = useRouter();

  const [keyword,     setKeyword]    = useState("");
  const [region,      setRegion]     = useState("全部");
  const [sector,      setSector]     = useState("全部");
  const [sortKey,     setSortKey]    = useState<SortKey>("return1y");
  const [sortDir,     setSortDir]    = useState<SortDir>("desc");
  const [filterMode,  setFilterMode] = useState<FilterMode>("all");

  const {
    favList, watchList, compareList,
    toggleFav: _toggleFav, toggleWatch: _toggleWatch, toggleCompare: _toggleCompare,
    clearCompare, toast,
    showToast,
  } = useWatchlist("etf");
  // wrapper handlers
  const toggleFav     = useCallback((etf: Etf) => _toggleFav({ id: etf.code, type: "etf", name: etf.name }), [_toggleFav]);
  const toggleWatch   = useCallback((etf: Etf) => _toggleWatch({ id: etf.code, type: "etf", name: etf.name }), [_toggleWatch]);
  const toggleCompare = useCallback((etf: Etf) => _toggleCompare({ id: etf.code, type: "etf", name: etf.name }), [_toggleCompare]);



  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  const filtered = useMemo(() => {
    let list: Etf[] = ETF_LIST;
    if (filterMode === "fav")   list = list.filter(e => hasItem(favList, e.code));
    if (filterMode === "watch") list = list.filter(e => hasItem(watchList, e.code));
    if (keyword.trim()) {
      const kw = keyword.trim().toLowerCase();
      list = list.filter(e => e.code.toLowerCase().includes(kw) || e.name.toLowerCase().includes(kw));
    }
    if (region !== "全部") list = list.filter(e => e.region === region);
    if (sector !== "全部") list = list.filter(e => e.sector === sector);
    return [...list].sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return sortDir === "asc" ? diff : -diff;
    });
  }, [keyword, region, sector, sortKey, sortDir, filterMode, favList, watchList]);

  function Th({ label, k }: { label: string; k: SortKey }) {
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

  const etfFavCount  = favList.length;
  const etfWatchCount = watchList.length;

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
            <Link href="/etf"     className="text-[#F5B700]">ETF篩選器</Link>
            <Link href="/funds"   className="hover:text-white transition-colors">基金篩選器</Link>
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
          <div className="tracking-[10px] text-[#F5B700] text-[14px] font-semibold mb-3">ETF DATABASE</div>
          <h1 className="text-[42px] font-black text-white">ETF 篩選器</h1>
          <p className="text-[15px] text-slate-400 mt-1">共 {ETF_LIST.length} 檔 ETF，支援搜尋、篩選、排序與收藏</p>
        </div>

        {/* ══ 熱門 ETF 排行榜 ══════════════════════════════════════ */}
        <EtfRanking />

                {/* ══ ETF 排行榜 ══ */}
        <EtfRankingTable />

        {/* Compare bar */}
        {compareList.length > 0 && (
          <div className="flex items-center justify-between bg-emerald-900/30 border border-emerald-500/30 rounded-xl px-5 py-3 mb-5">
            <div className="text-[13px] text-emerald-300 font-semibold">
              📊 比較清單：{compareList.length} 檔
              <span className="text-emerald-600 ml-2 font-normal">
                {compareList.slice(0,3).map(i=>i.name.slice(0,6)).join("、")}{compareList.length > 3 ? "…" : ""}
              </span>
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
            { key: "all"   as FilterMode, label: `全部 (${ETF_LIST.length})` },
            { key: "fav"   as FilterMode, label: `⭐ 收藏 (${etfFavCount})` },
            { key: "watch" as FilterMode, label: `👀 觀察名單 (${etfWatchCount})` },
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
            placeholder="搜尋代碼或名稱，例如 VOO、高股息"
            className="flex-1 min-w-[220px] bg-transparent border border-white/20 rounded-lg px-4 py-2.5 text-[14px] text-white placeholder:text-slate-500 focus:outline-none focus:border-[#F5B700]" />
          <select value={region} onChange={e => setRegion(e.target.value)}
            className="bg-[#040a18] border border-white/20 rounded-lg px-4 py-2.5 text-[14px] text-white focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部地區</option>
            {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select value={sector} onChange={e => setSector(e.target.value)}
            className="bg-[#040a18] border border-white/20 rounded-lg px-4 py-2.5 text-[14px] text-white focus:outline-none focus:border-[#F5B700]">
            <option value="全部">全部類型</option>
            {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <div className="text-[12px] text-slate-600 mb-3">符合條件：{filtered.length} 檔</div>

        {/* Table */}
        <div className="border border-white/10 rounded-2xl overflow-hidden overflow-x-auto">
          <table className="w-full text-left min-w-[1300px]">
            <thead>
              <tr className="bg-white/[0.06] text-slate-400 text-[12px]">
                <th className="px-4 py-3 font-semibold w-[108px]">操作</th>
                <th className="px-3 py-3 font-semibold w-[80px]">代碼</th>
                <th className="px-3 py-3 font-semibold">商品名稱</th>
                <th className="px-3 py-3 font-semibold">類型</th>
                <th className="px-3 py-3 font-semibold">配息頻率</th>
                <Th label="每單位配息" k="dividendPerUnit" />
                <Th label="殖利率%" k="dividendYield" />
                <Th label="今年以來%" k="returnYTD" />
                <Th label="近1月%" k="return1m" />
                <Th label="近3月%" k="return3m" />
                <Th label="近6月%" k="return6m" />
                <Th label="近1年%" k="return1y" />
                <Th label="近3年%" k="return3y" />
                <Th label="波動度%" k="volatility" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((etf, i) => (
                <tr key={etf.code}
                  className={`text-[13px] text-white border-t border-white/[0.04] hover:bg-[#F5B700]/[0.04] transition-colors ${i % 2 === 1 ? "bg-white/[0.015]" : ""}`}>
                  <td className="px-4 py-2.5">
                    <ActionBtns etf={etf}
                      favList={favList} watchList={watchList} compareList={compareList}
                      onFav={toggleFav} onWatch={toggleWatch} onCompare={toggleCompare} />
                  </td>
                  <td className="px-3 py-2.5 font-bold text-[#F5B700] text-[12px]">{etf.code}</td>
                  <td className="px-3 py-2.5 text-slate-200 max-w-[200px] truncate text-[12px]">{etf.name}</td>
                  <td className="px-3 py-2.5 text-slate-500 text-[11px]">{etf.sector}</td>
                  <td className="px-3 py-2.5 text-slate-500 text-[11px]">{etf.dividendFreq}</td>
                  <td className="px-3 py-2.5 text-slate-300">{etf.dividendPerUnit > 0 ? etf.dividendPerUnit.toFixed(2) : "—"}</td>
                  <td className="px-3 py-2.5 text-slate-300">{etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—"}</td>
                  <td className="px-3 py-2.5"><Pct v={etf.returnYTD} /></td>
                  <td className="px-3 py-2.5"><Pct v={etf.return1m} /></td>
                  <td className="px-3 py-2.5"><Pct v={etf.return3m} /></td>
                  <td className="px-3 py-2.5"><Pct v={etf.return6m} /></td>
                  <td className="px-3 py-2.5"><Pct v={etf.return1y} /></td>
                  <td className="px-3 py-2.5"><Pct v={etf.return3y} /></td>
                  <td className="px-3 py-2.5 text-slate-400">{etf.volatility.toFixed(1)}%</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={14} className="px-5 py-12 text-center text-slate-600">
                  {filterMode === "fav"   ? "尚未收藏任何 ETF，點擊 ⭐ 加入收藏" :
                   filterMode === "watch" ? "觀察名單是空的，點擊 👀 加入" :
                   "找不到符合條件的 ETF"}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-slate-700 mt-4">以上資料為示意範例，非即時市場數據，不構成投資建議。</p>

        <div className="flex justify-center mt-8">
          <Link href="/" className="border border-white/20 text-white px-10 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">
            回到首頁
          </Link>
        </div>
      </div>

      {toast && <Toast msg={toast} onClose={() => { /* hook manages timeout */ }} />}
    </main>
  );
}