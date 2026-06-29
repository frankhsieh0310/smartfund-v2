"use client";
// ============================================================
// app/etf/page.tsx
// PRD-A2-V3.0: ETF Product Differentiation
// ============================================================

import React, { useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ETF_LIST, type Etf } from "./data";
import { getTopEtfs, type EtfRankType } from "@/lib/services/rankingService";
import { useWatchlist, hasItem, type ListItem } from "@/lib/hooks/useWatchlist";
import { Toast, Pct } from "@/components/shared";

// ── Types ─────────────────────────────────────────────────────
type SortKey = "dividendYield" | "dividendPerUnit" | "returnYTD" | "return1m" | "return3m" | "return6m" | "return1y" | "return3y" | "volatility";
type SortDir = "asc" | "desc";
type FilterMode = "all" | "fav" | "watch";

// ── Task 1: SmartMatch Score（假資料）────────────────────────
const SM_SCORES: Record<string, number> = {};
[...ETF_LIST].sort((a, b) => b.return1y - a.return1y).forEach((etf, i) => {
  SM_SCORES[etf.code] = Math.max(60, 98 - i * 0.42);
});

function StarScore({ score }: { score: number }) {
  const stars = score >= 95 ? 5 : score >= 88 ? 4 : score >= 78 ? 3 : score >= 68 ? 2 : 1;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className="text-[14px] font-black text-[#F5C542] leading-none">{Math.round(score)}</span>
      <span className="text-[#F5C542] leading-none text-[10px] tracking-[-1px]">{"★".repeat(stars)}{"☆".repeat(5 - stars)}</span>
    </div>
  );
}

// ── Task 2: Why Matched Tags（假資料，依 ETF 真實欄位）────────
function getWhyMatched(etf: Etf): string[] {
  const tags: string[] = [];
  if (etf.dividendFreq === "月配") tags.push("月配息");
  else if (etf.dividendFreq === "季配") tags.push("季配息");
  if (etf.region && etf.region !== "全球") tags.push(etf.region);
  if (etf.sector) tags.push(etf.sector);
  return tags.slice(0, 3);
}

// ── Investment Criteria Options ───────────────────────────────
interface Criterion { id: string; label: string; filter: (e: Etf) => boolean; }

const CRITERIA_OPTIONS: Criterion[] = [
  { id: "freq_monthly",   label: "月配息",      filter: e => e.dividendFreq === "月配" },
  { id: "freq_quarterly", label: "季配息",      filter: e => e.dividendFreq === "季配" },
  { id: "yield_3",        label: "殖利率 > 3%", filter: e => e.dividendYield > 3 },
  { id: "yield_5",        label: "殖利率 > 5%", filter: e => e.dividendYield > 5 },
  { id: "yield_7",        label: "殖利率 > 7%", filter: e => e.dividendYield > 7 },
  { id: "yield_9",        label: "殖利率 > 9%", filter: e => e.dividendYield > 9 },
  { id: "sector_high_div",label: "高股息",       filter: e => e.sector === "高股息" },
  { id: "sector_tech",    label: "科技",         filter: e => e.sector === "科技" },
  { id: "sector_semi",    label: "半導體",       filter: e => e.sector === "半導體" },
  { id: "sector_bond",    label: "債券",         filter: e => e.sector === "債券" },
  { id: "sector_esg",     label: "ESG",          filter: e => e.sector === "ESG" },
  { id: "region_tw",      label: "台灣",         filter: e => e.region === "台灣" },
  { id: "region_us",      label: "美國",         filter: e => e.region === "美國" },
  { id: "region_asia",    label: "亞洲",         filter: e => e.region === "亞洲" },
  { id: "region_global",  label: "全球",         filter: e => e.region === "全球" },
  { id: "ret1y_10",       label: "近1年 > 10%",  filter: e => e.return1y > 10 },
  { id: "ret1y_20",       label: "近1年 > 20%",  filter: e => e.return1y > 20 },
  { id: "ret1y_30",       label: "近1年 > 30%",  filter: e => e.return1y > 30 },
  { id: "vol_low",        label: "低波動 < 15%", filter: e => e.volatility < 15 },
  { id: "vol_mid",        label: "波動 < 20%",   filter: e => e.volatility < 20 },
];

const CRITERIA_GROUPS = [
  { label: "配息頻率", ids: ["freq_monthly", "freq_quarterly"] },
  { label: "殖利率",   ids: ["yield_3", "yield_5", "yield_7", "yield_9"] },
  { label: "類型",     ids: ["sector_high_div", "sector_tech", "sector_semi", "sector_bond", "sector_esg"] },
  { label: "地區",     ids: ["region_tw", "region_us", "region_asia", "region_global"] },
  { label: "近1年績效",ids: ["ret1y_10", "ret1y_20", "ret1y_30"] },
  { label: "波動度",   ids: ["vol_low", "vol_mid"] },
];

// ── RankBadge ─────────────────────────────────────────────────
function RankBadge({ rank }: { rank: number }) {
  if (rank === 0) return <span className="text-[18px]">🥇</span>;
  if (rank === 1) return <span className="text-[18px]">🥈</span>;
  if (rank === 2) return <span className="text-[18px]">🥉</span>;
  return <span className="w-6 h-6 rounded-full bg-white/[0.06] border border-white/[0.1] flex items-center justify-center text-[11px] font-bold text-slate-500">{rank + 1}</span>;
}

// ── ETF Ranking ───────────────────────────────────────────────
const ETF_RANK_TABS: { key: EtfRankType; label: string }[] = [
  { key: "best1y", label: "近1年績效" },
  { key: "hot30",  label: "近30日" },
  { key: "hot90",  label: "近3個月" },
  { key: "yield",  label: "殖利率" },
  { key: "lowvol", label: "低波動" },
];

function EtfRankingSection() {
  const [tab, setTab] = React.useState<EtfRankType>("best1y");
  const ranked = React.useMemo(() => getTopEtfs(tab, 10), [tab]);

  function getValue(etf: Etf): string {
    switch (tab) {
      case "best1y": return `${etf.return1y >= 0 ? "+" : ""}${etf.return1y.toFixed(1)}%`;
      case "hot30":  return `${etf.return1m >= 0 ? "+" : ""}${etf.return1m.toFixed(1)}%`;
      case "hot90":  return `${etf.return3m >= 0 ? "+" : ""}${etf.return3m.toFixed(1)}%`;
      case "yield":  return etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—";
      case "lowvol": return `${etf.volatility.toFixed(1)}%`;
    }
  }

  function getLabel(): string {
    switch (tab) {
      case "best1y": return "近1年"; case "hot30": return "近30日";
      case "hot90":  return "近3月"; case "yield": return "殖利率";
      case "lowvol": return "波動度";
    }
  }

  function getColor(etf: Etf): string {
    if (tab === "lowvol") return "text-blue-400";
    if (tab === "yield")  return "text-[#F5C542]";
    const v = tab === "hot30" ? etf.return1m : tab === "hot90" ? etf.return3m : etf.return1y;
    return v >= 0 ? "text-emerald-400" : "text-red-400";
  }

  return (
    <div className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[16px] font-bold text-white">ETF 排行榜 <span className="text-[12px] text-slate-600 font-normal ml-1">Top 10</span></h2>
        <div className="flex gap-1.5 flex-wrap justify-end">
          {ETF_RANK_TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-3 py-1 rounded text-[11px] font-semibold transition-colors ${
                tab === t.key ? "bg-[#F5C542] text-[#0B1220]" : "border border-white/[0.1] text-slate-500 hover:border-[#F5C542]/30 hover:text-[#F5C542]"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {ranked.map((etf, i) => (
          <div key={etf.code}
            className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border ${
              i === 0 ? "bg-yellow-500/[0.05] border-yellow-500/20" :
              i === 1 ? "bg-slate-400/[0.03] border-slate-400/12" :
              i === 2 ? "bg-orange-500/[0.03] border-orange-500/12" :
              "bg-white/[0.015] border-white/[0.05]"
            }`}>
            <div className="w-6 shrink-0 flex items-center justify-center"><RankBadge rank={i} /></div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="text-[12px] font-bold text-[#F5C542]">{etf.code}</span>
                <span className="text-[10px] text-slate-600 bg-white/[0.04] px-1 py-0.5 rounded">{etf.sector}</span>
              </div>
              <div className="text-[11px] text-slate-600 truncate">{etf.name}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[10px] text-slate-600 mb-0.5">{getLabel()}</div>
              <div className={`text-[13px] font-black ${getColor(etf)}`}>{getValue(etf)}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-[10px] text-slate-700 text-right">示意資料・非即時行情</div>
    </div>
  );
}

// ── Investment Criteria Builder ───────────────────────────────
function CriteriaBuilder({
  selected, onToggle, keyword, onKeyword, resultCount,
}: {
  selected: Set<string>;
  onToggle: (id: string) => void;
  keyword: string;
  onKeyword: (v: string) => void;
  resultCount: number;
}) {
  return (
    <div className="mb-0 border border-white/[0.08] rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-white/[0.06]" style={{ background: "rgba(12,18,36,0.95)" }}>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-[15px] font-bold text-white mb-0.5">Investment Criteria</div>
            <div className="text-[12px] text-slate-500">建立你的投資條件。符合所有條件的 ETF 才會出現在搜尋結果中。</div>
          </div>
          {selected.size > 0 && (
            <button onClick={() => Array.from(selected).forEach(onToggle)}
              className="text-[11px] text-slate-600 hover:text-red-400 transition-colors shrink-0 ml-4 mt-1">清除全部</button>
          )}
        </div>
      </div>

      <div className="px-5 pt-4 pb-3">
        <input type="text" value={keyword} onChange={e => onKeyword(e.target.value)}
          placeholder="代碼或名稱，例如 0050、00878"
          className="w-full bg-white/[0.03] border border-white/[0.08] rounded-lg px-3.5 py-2.5 text-[13px] text-white placeholder:text-slate-600 focus:outline-none focus:border-[#F5C542]/40 transition-colors" />
      </div>

      <div className="px-5 pb-4 space-y-3">
        {CRITERIA_GROUPS.map(group => {
          const options = CRITERIA_OPTIONS.filter(o => group.ids.includes(o.id));
          return (
            <div key={group.label} className="flex items-start gap-3">
              <div className="text-[11px] font-semibold text-slate-600 w-[60px] shrink-0 pt-1.5">{group.label}</div>
              <div className="flex flex-wrap gap-1.5">
                {options.map(opt => {
                  const active = selected.has(opt.id);
                  return (
                    <button key={opt.id} onClick={() => onToggle(opt.id)}
                      className={`px-3 py-1 rounded text-[12px] font-semibold transition-all border ${
                        active
                          ? "bg-[#F5C542] text-[#0B1220] border-[#F5C542]"
                          : "bg-transparent text-slate-400 border-white/[0.1] hover:border-[#F5C542]/40 hover:text-[#F5C542]"
                      }`}>
                      {active && "✓ "}{opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {selected.size > 0 && (
        <div className="px-5 py-2 border-t border-white/[0.06] flex items-center gap-2 flex-wrap" style={{ background: "rgba(245,197,66,0.03)" }}>
          {Array.from(selected).map(id => {
            const opt = CRITERIA_OPTIONS.find(o => o.id === id);
            return opt ? (
              <span key={id} className="text-[11px] text-[#F5C542] bg-[#F5C542]/[0.08] border border-[#F5C542]/20 px-2 py-0.5 rounded flex items-center gap-1">
                {opt.label}
                <button onClick={() => onToggle(id)} className="opacity-50 hover:opacity-100 ml-0.5">✕</button>
              </span>
            ) : null;
          })}
        </div>
      )}

      {/* Task 5: Criteria Match Banner */}
      <div className="flex items-center justify-between px-5 py-2.5 border-t border-[#F5C542]/20"
        style={{ background: "rgba(245,197,66,0.07)", minHeight: "40px" }}>
        <span className="text-[12px] text-[#F5C542] font-semibold">Your Investment Criteria currently matches</span>
        <span className="text-[16px] font-black text-[#F5C542] ml-3">{resultCount} ETFs</span>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────
export default function EtfDatabasePage() {
  const router = useRouter();
  const [keyword,    setKeyword]   = useState("");
  const [selected,   setSelected]  = useState<Set<string>>(new Set());
  const [sortKey,    setSortKey]   = useState<SortKey>("return1y");
  const [sortDir,    setSortDir]   = useState<SortDir>("desc");
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  // Task 4: Quick Preview expanded row
  const [expandedRow, setExpandedRow] = useState<string | null>(null);

  const {
    favList, watchList, compareList,
    toggleFav: _toggleFav, toggleWatch: _toggleWatch, toggleCompare: _toggleCompare,
    clearCompare, toast, showToast,
  } = useWatchlist("etf");

  const toggleFav     = useCallback((etf: Etf) => _toggleFav({ id: etf.code, type: "etf", name: etf.name }), [_toggleFav]);
  const toggleWatch   = useCallback((etf: Etf) => _toggleWatch({ id: etf.code, type: "etf", name: etf.name }), [_toggleWatch]);
  const toggleCompare = useCallback((etf: Etf) => _toggleCompare({ id: etf.code, type: "etf", name: etf.name }), [_toggleCompare]);

  function toggleCriterion(id: string) {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
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
    if (selected.size > 0) {
      const criteria = CRITERIA_OPTIONS.filter(o => selected.has(o.id));
      list = list.filter(e => criteria.every(c => c.filter(e)));
    }
    return [...list].sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return sortDir === "asc" ? diff : -diff;
    });
  }, [keyword, selected, sortKey, sortDir, filterMode, favList, watchList]);

  // Task 6: Table header helper
  function Th({ label, k, bold }: { label: string; k: SortKey; bold?: boolean }) {
    const active = sortKey === k;
    return (
      <th onClick={() => handleSort(k)}
        className={`px-3 py-3 cursor-pointer select-none whitespace-nowrap text-[11px] transition-colors ${
          active ? "text-[#F5C542] bg-[#F5C542]/[0.05]" : "text-slate-500 hover:text-[#F5C542]"
        }`}
        style={{ fontWeight: bold ? 700 : 500 }}>
        <span className="flex items-center gap-0.5">
          {label}<span className="text-[9px] ml-0.5">{active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span>
        </span>
      </th>
    );
  }

  return (
    <main className="min-h-screen pb-24" style={{ paddingTop: "80px" }}>

      {/* NAVBAR（禁止修改）*/}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#040a18]/90 backdrop-blur-xl border-b border-white/[0.08]">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <Link href="/">
            <div className="text-[28px] font-black text-white leading-none">Smart<span className="text-[#F5C542]">Match</span></div>
            <div className="text-[11px] text-slate-400 mt-0.5">Investment Intelligence Platform</div>
          </Link>
          <nav className="hidden lg:flex gap-7 text-[14px] font-semibold text-slate-300">
            <Link href="/quiz"    className="hover:text-white transition-colors">投資人格分析</Link>
            <Link href="/etf"     className="text-[#F5C542]">ETF篩選器</Link>
            <Link href="/funds"   className="hover:text-white transition-colors">基金篩選器</Link>
            <Link href="/compare" className="hover:text-white transition-colors">比較中心</Link>
            <Link href="/clients" className="hover:text-white transition-colors">客戶管理</Link>
            <Link href="/pricing" className="hover:text-white transition-colors">方案</Link>
          </nav>
          <div className="flex items-center gap-3">
            <a href="#" className="text-[14px] font-semibold text-slate-300 border border-white/30 px-4 py-2 rounded-lg hover:bg-white/10 transition-colors">登入</a>
            <Link href="/quiz" className="bg-[#F5C542] hover:bg-[#e0a800] text-[#0B1220] px-5 py-2 rounded-lg font-bold text-[14px] transition-colors">免費註冊</Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative flex items-end" style={{
        height: "350px",
        backgroundImage: "url('https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?q=80&w=2600')",
        backgroundSize: "cover", backgroundPosition: "center top",
      }}>
        <div className="absolute inset-0" style={{ background: "linear-gradient(rgba(6,10,20,.75), rgba(6,10,20,.88))" }} />
        <div className="relative z-10 w-full max-w-[1600px] mx-auto px-10 pb-8">
          <div className="text-[11px] text-slate-600 mb-3">
            <Link href="/" className="hover:text-slate-400 transition-colors">SmartMatch</Link>
            <span className="mx-2">/</span>
            <span className="text-slate-500">ETF Database</span>
          </div>
          <h1 className="text-[34px] font-black text-white leading-tight mb-2">
            Find ETFs That Match<br />
            <span className="text-[#F5C542]">Your Investment Criteria</span>
          </h1>
          <p className="text-[14px] text-slate-400">建立投資條件，快速找出真正符合策略的 ETF。</p>
        </div>
      </section>

      {/* Main */}
      <div className="max-w-[1600px] mx-auto px-10 pt-8">

        <EtfRankingSection />

        {/* Compare bar */}
        {compareList.length > 0 && (
          <div className="flex items-center justify-between bg-emerald-900/20 border border-emerald-500/20 rounded-lg px-4 py-2.5 mb-6">
            <div className="text-[12px] text-emerald-400 font-semibold">
              📊 比較清單：{compareList.length} 檔
              <span className="text-emerald-700 ml-2 font-normal">
                {compareList.slice(0, 3).map((i: ListItem) => i.name.slice(0, 6)).join("、")}{compareList.length > 3 ? "…" : ""}
              </span>
            </div>
            <div className="flex gap-3">
              <button onClick={() => clearCompare()} className="text-[11px] text-slate-600 hover:text-red-400 transition-colors">清除</button>
              <button onClick={() => router.push("/compare")}
                className="bg-emerald-800 hover:bg-emerald-700 text-white text-[11px] font-bold px-3 py-1 rounded-md transition-colors">
                前往比較中心 →
              </button>
            </div>
          </div>
        )}

        {/* Investment Criteria + Task 5 Banner */}
        <CriteriaBuilder selected={selected} onToggle={toggleCriterion} keyword={keyword} onKeyword={setKeyword} resultCount={filtered.length} />

        {/* Result bar */}
        <div className="flex items-center justify-between py-3 mb-2 border-b border-white/[0.05]">
          <div className="flex gap-1.5">
            {([
              { key: "all"   as FilterMode, label: `全部` },
              { key: "fav"   as FilterMode, label: `⭐ ${favList.length}` },
              { key: "watch" as FilterMode, label: `👀 ${watchList.length}` },
            ]).map(tab => (
              <button key={tab.key} onClick={() => setFilterMode(tab.key)}
                className={`px-3 py-1 rounded text-[11px] font-semibold transition-colors ${
                  filterMode === tab.key ? "bg-[#F5C542] text-[#0B1220]" : "border border-white/[0.08] text-slate-500 hover:border-white/15 hover:text-white"
                }`}>
                {tab.label}
              </button>
            ))}
          </div>
          <button disabled className="text-[11px] font-semibold text-slate-700 border border-white/[0.05] px-4 py-1 rounded cursor-not-allowed">
            Export ↗
          </button>
        </div>

        {/* Table */}
        <div className="border border-white/[0.07] rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-left" style={{ minWidth: "1380px" }}>
            <thead>
              <tr className="border-b border-white/[0.06]" style={{ background: "rgba(10,16,32,0.97)" }}>
                {/* Task 1: Score header（bold, Task 6: 最高優先）*/}
                <th className="px-3 py-3 text-[11px] w-[68px]" style={{ fontWeight: 700, color: "#F5C542" }}>Score</th>
                {/* Task 6: ETF 代碼 */}
                <th className="px-3 py-3 text-[11px] text-slate-400 w-[68px]" style={{ fontWeight: 600 }}>代碼</th>
                <th className="px-3 py-3 text-[11px] text-slate-400" style={{ fontWeight: 500 }}>名稱</th>
                {/* Task 2: Why Matched */}
                <th className="px-3 py-3 text-[11px] text-slate-400 w-[140px]" style={{ fontWeight: 600 }}>Why Matched</th>
                {/* Task 9(V2): 配息率 bold */}
                <th onClick={() => handleSort("dividendYield")}
                  className={`px-3 py-3 cursor-pointer select-none text-[11px] whitespace-nowrap transition-colors ${sortKey === "dividendYield" ? "text-[#F5C542] bg-[#F5C542]/[0.05]" : "text-slate-300 hover:text-[#F5C542]"}`}
                  style={{ fontWeight: 700 }}>
                  <span className="flex items-center gap-0.5">配息率% <span className="text-[9px]">{sortKey === "dividendYield" ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span></span>
                </th>
                <th className="px-3 py-3 text-[11px] text-slate-500 w-[44px]" style={{ fontWeight: 500 }}>配息</th>
                <Th label="近1月%" k="return1m" />
                <Th label="近3月%" k="return3m" />
                <Th label="近1年%" k="return1y" bold />
                <Th label="近3年%" k="return3y" />
                <Th label="波動度%" k="volatility" />
                {/* Task 4: Quick View header */}
                <th className="px-3 py-3 text-[11px] text-slate-600 w-[64px]" style={{ fontWeight: 500 }}>Quick View</th>
                {/* Actions */}
                <th className="px-3 py-3 text-[11px] text-slate-600 w-[90px]" style={{ fontWeight: 500 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((etf, i) => {
                const score = SM_SCORES[etf.code] ?? 70;
                const isTop3 = i < 3;
                const isCompared = hasItem(compareList, etf.code);
                const isExpanded = expandedRow === etf.code;
                const whyTags = getWhyMatched(etf);

                return (
                  <React.Fragment key={etf.code}>
                    {/* Task 7: Transition 150ms, Task 3: 比較後淡黃色背景 */}
                    <tr
                      style={{
                        borderLeft: isTop3 ? "3px solid #F5C542" : "3px solid transparent",
                        background: isCompared ? "rgba(245,197,66,0.04)" : undefined,
                        transition: "background-color 150ms ease",
                      }}
                      className={`text-[12px] text-white border-t border-white/[0.04] hover:bg-[#F5C542]/[0.03] ${
                        i % 2 === 1 && !isCompared ? "bg-white/[0.012]" : ""
                      }`}>
                      {/* Task 1: SmartMatch Score */}
                      <td className="px-3 py-2.5">
                        <StarScore score={score} />
                      </td>
                      {/* ETF Code */}
                      <td className="px-3 py-2.5 font-bold text-[#F5C542] text-[12px]">{etf.code}</td>
                      {/* Name */}
                      <td className="px-3 py-2.5 text-slate-300 max-w-[160px] truncate text-[12px]">{etf.name}</td>
                      {/* Task 2: Why Matched */}
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {whyTags.map(tag => (
                            <span key={tag} className="text-[10px] text-emerald-400 border border-emerald-500/30 bg-emerald-500/[0.07] px-1.5 py-0.5 rounded">
                              ✓ {tag}
                            </span>
                          ))}
                        </div>
                      </td>
                      {/* 配息率（Task 9 bold）*/}
                      <td className={`px-3 py-2.5 text-slate-200 font-semibold ${sortKey === "dividendYield" ? "bg-[#F5C542]/[0.04]" : ""}`}>
                        {etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-slate-600 text-[11px]">{etf.dividendFreq}</td>
                      <td className={`px-3 py-2.5 ${sortKey === "return1m"  ? "bg-[#F5C542]/[0.04]" : ""}`}><Pct v={etf.return1m} /></td>
                      <td className={`px-3 py-2.5 ${sortKey === "return3m"  ? "bg-[#F5C542]/[0.04]" : ""}`}><Pct v={etf.return3m} /></td>
                      <td className={`px-3 py-2.5 ${sortKey === "return1y"  ? "bg-[#F5C542]/[0.04]" : ""}`}><Pct v={etf.return1y} /></td>
                      <td className={`px-3 py-2.5 ${sortKey === "return3y"  ? "bg-[#F5C542]/[0.04]" : ""}`}><Pct v={etf.return3y} /></td>
                      <td className={`px-3 py-2.5 text-slate-400 ${sortKey === "volatility" ? "bg-[#F5C542]/[0.04]" : ""}`}>{etf.volatility.toFixed(1)}%</td>
                      {/* Task 4: Quick View toggle */}
                      <td className="px-3 py-2.5">
                        <button
                          onClick={() => setExpandedRow(isExpanded ? null : etf.code)}
                          className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                            isExpanded ? "border-[#F5C542]/40 text-[#F5C542]" : "border-white/[0.1] text-slate-600 hover:border-white/20 hover:text-white"
                          }`}>
                          {isExpanded ? "收起" : "展開"}
                        </button>
                      </td>
                      {/* Task 7: Hover Actions (♡ ⇄ 👁) */}
                      <td className="px-2 py-2.5">
                        <div className="flex items-center gap-0.5">
                          <button onClick={() => toggleFav(etf)}
                            className={`w-7 h-7 rounded flex items-center justify-center text-[13px] transition-all ${hasItem(favList, etf.code) ? "text-[#F5C542]" : "text-slate-600 hover:text-[#F5C542]"}`}>♡</button>
                          {/* Task 3: 比較 icon 改黃色 */}
                          <button onClick={() => toggleCompare(etf)}
                            className={`w-7 h-7 rounded flex items-center justify-center text-[12px] transition-all ${isCompared ? "text-[#F5C542]" : "text-slate-600 hover:text-[#F5C542]"}`}>⇄</button>
                          <button onClick={() => toggleWatch(etf)}
                            className={`w-7 h-7 rounded flex items-center justify-center text-[12px] transition-all ${hasItem(watchList, etf.code) ? "text-blue-400" : "text-slate-600 hover:text-blue-400"}`}>👁</button>
                        </div>
                      </td>
                    </tr>
                    {/* Task 4: Quick Preview Accordion */}
                    {isExpanded && (
                      <tr className="border-t border-[#F5C542]/10" style={{ background: "rgba(245,197,66,0.04)" }}>
                        <td colSpan={13} className="px-6 py-3">
                          <div className="flex gap-8 text-[12px]">
                            <div>
                              <div className="text-[10px] text-slate-600 mb-0.5">配息率</div>
                              <div className="text-[#F5C542] font-semibold">{etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—"}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-600 mb-0.5">Region</div>
                              <div className="text-slate-300">{etf.region}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-600 mb-0.5">Asset Class</div>
                              <div className="text-slate-300">{etf.sector}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-600 mb-0.5">配息頻率</div>
                              <div className="text-slate-300">{etf.dividendFreq || "—"}</div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-600 mb-0.5">近1年績效</div>
                              <div className={etf.return1y >= 0 ? "text-emerald-400" : "text-red-400"}>
                                {etf.return1y >= 0 ? "+" : ""}{etf.return1y.toFixed(1)}%
                              </div>
                            </div>
                            <div>
                              <div className="text-[10px] text-slate-600 mb-0.5">SmartMatch Score</div>
                              <div className="text-[#F5C542] font-bold">{Math.round(SM_SCORES[etf.code] ?? 70)}</div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={13} className="px-5 py-12 text-center text-slate-600 text-[13px]">
                  {filterMode === "fav" ? "尚未收藏任何 ETF" : filterMode === "watch" ? "觀察名單是空的" : "無符合條件的 ETF，請調整條件"}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[10px] text-slate-700 mt-4">示意資料，非即時市場數據，不構成投資建議。</p>

        <div className="flex justify-center mt-8">
          <Link href="/" className="border border-white/10 text-slate-500 px-8 py-2.5 rounded-lg hover:border-white/20 hover:text-white transition-colors text-[13px]">
            ← 回到首頁
          </Link>
        </div>
      </div>

      {toast && <Toast msg={toast} onClose={() => showToast("")} />}
    </main>
  );
}