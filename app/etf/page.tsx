"use client";
// ============================================================
// app/etf/page.tsx
// SmartMatch ETF 篩選器
// Phase A2：排行榜、Investment Criteria 條件搜尋、欄位 Highlight、閱讀體驗
// ============================================================

import React, { useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ETF_LIST, REGIONS, SECTORS, type Etf } from "./data";
import { getTopEtfs, type EtfRankType } from "@/lib/services/rankingService";
import { useWatchlist, hasItem, type ListItem } from "@/lib/hooks/useWatchlist";
import { Toast, Pct } from "@/components/shared";

// ── Types ─────────────────────────────────────────────────────
type SortKey = "dividendYield" | "dividendPerUnit" | "returnYTD" | "return1m" | "return3m" | "return6m" | "return1y" | "return3y" | "volatility";
type SortDir = "asc" | "desc";
type FilterMode = "all" | "fav" | "watch";

// ── Criteria Chip ─────────────────────────────────────────────
interface Criterion {
  id: string;
  label: string;
  filter: (e: Etf) => boolean;
}

const CRITERIA_OPTIONS: Criterion[] = [
  // 配息頻率
  { id: "freq_monthly",  label: "月配息",     filter: e => e.dividendFreq === "月配" },
  { id: "freq_quarterly",label: "季配息",     filter: e => e.dividendFreq === "季配" },
  // 殖利率
  { id: "yield_3",  label: "殖利率 > 3%",  filter: e => e.dividendYield > 3  },
  { id: "yield_5",  label: "殖利率 > 5%",  filter: e => e.dividendYield > 5  },
  { id: "yield_7",  label: "殖利率 > 7%",  filter: e => e.dividendYield > 7  },
  { id: "yield_9",  label: "殖利率 > 9%",  filter: e => e.dividendYield > 9  },
  // 類型
  { id: "sector_high_div", label: "高股息",   filter: e => e.sector === "高股息" },
  { id: "sector_tech",     label: "科技",     filter: e => e.sector === "科技" },
  { id: "sector_semi",     label: "半導體",   filter: e => e.sector === "半導體" },
  { id: "sector_bond",     label: "債券",     filter: e => e.sector === "債券" },
  { id: "sector_esg",      label: "ESG",      filter: e => e.sector === "ESG" },
  // 地區
  { id: "region_tw",   label: "台灣",      filter: e => e.region === "台灣" },
  { id: "region_us",   label: "美國",      filter: e => e.region === "美國" },
  { id: "region_asia", label: "亞洲",      filter: e => e.region === "亞洲" },
  { id: "region_global",label: "全球",     filter: e => e.region === "全球" },
  // 績效
  { id: "ret1y_10",  label: "近1年 > 10%", filter: e => e.return1y > 10 },
  { id: "ret1y_20",  label: "近1年 > 20%", filter: e => e.return1y > 20 },
  { id: "ret1y_30",  label: "近1年 > 30%", filter: e => e.return1y > 30 },
  // 波動度
  { id: "vol_low",   label: "低波動 < 15%", filter: e => e.volatility < 15 },
  { id: "vol_mid",   label: "波動 < 20%",   filter: e => e.volatility < 20 },
];

const CRITERIA_GROUPS = [
  { label: "配息頻率", ids: ["freq_monthly", "freq_quarterly"] },
  { label: "殖利率",   ids: ["yield_3", "yield_5", "yield_7", "yield_9"] },
  { label: "類型",     ids: ["sector_high_div", "sector_tech", "sector_semi", "sector_bond", "sector_esg"] },
  { label: "地區",     ids: ["region_tw", "region_us", "region_asia", "region_global"] },
  { label: "近1年績效",ids: ["ret1y_10", "ret1y_20", "ret1y_30"] },
  { label: "波動度",   ids: ["vol_low", "vol_mid"] },
];

// ── ActionBtns ────────────────────────────────────────────────
function ActionBtns({ etf, favList, watchList, compareList, onFav, onWatch, onCompare }: {
  etf: Etf;
  favList: ListItem[]; watchList: ListItem[]; compareList: ListItem[];
  onFav: (e: Etf) => void; onWatch: (e: Etf) => void; onCompare: (e: Etf) => void;
}) {
  const isFav     = hasItem(favList, etf.code);
  const isWatch   = hasItem(watchList, etf.code);
  const isCompare = hasItem(compareList, etf.code);
  return (
    <div className="flex items-center gap-1.5">
      <button onClick={() => onFav(etf)} title={isFav ? "取消收藏" : "加入收藏"}
        className={`w-8 h-8 rounded-lg flex items-center justify-center text-[14px] transition-all ${
          isFav ? "bg-[#F5B700]/20 text-[#F5B700]" : "bg-white/[0.04] text-slate-500 hover:bg-[#F5B700]/10 hover:text-[#F5B700]"
        }`}>⭐</button>
      <button onClick={() => onWatch(etf)} title={isWatch ? "移除觀察" : "加入觀察"}
        className={`w-8 h-8 rounded-lg flex items-center justify-center text-[14px] transition-all ${
          isWatch ? "bg-blue-500/20 text-blue-400" : "bg-white/[0.04] text-slate-500 hover:bg-blue-500/10 hover:text-blue-400"
        }`}>👀</button>
      <button onClick={() => onCompare(etf)} title={isCompare ? "移除比較" : "加入比較"}
        className={`w-8 h-8 rounded-lg flex items-center justify-center text-[14px] transition-all ${
          isCompare ? "bg-emerald-500/20 text-emerald-400" : "bg-white/[0.04] text-slate-500 hover:bg-emerald-500/10 hover:text-emerald-400"
        }`}>📊</button>
    </div>
  );
}

// ── RankBadge ─────────────────────────────────────────────────
function RankBadge({ rank }: { rank: number }) {
  if (rank === 0) return <span className="text-[22px]">🥇</span>;
  if (rank === 1) return <span className="text-[22px]">🥈</span>;
  if (rank === 2) return <span className="text-[22px]">🥉</span>;
  return (
    <span className="w-7 h-7 rounded-full bg-white/[0.06] border border-white/[0.1] flex items-center justify-center text-[12px] font-bold text-slate-500">
      {rank + 1}
    </span>
  );
}

// ── 排行榜 ────────────────────────────────────────────────────
const ETF_RANK_TABS: { key: EtfRankType; label: string }[] = [
  { key: "best1y", label: "近1年績效" },
  { key: "hot30",  label: "近30日" },
  { key: "hot90",  label: "近3個月" },
  { key: "yield",  label: "殖利率最高" },
  { key: "lowvol", label: "低波動" },
];

function EtfRankingSection() {
  const [tab, setTab] = React.useState<EtfRankType>("best1y");
  const ranked = React.useMemo(() => getTopEtfs(tab, 10), [tab]);

  function getMetricValue(etf: Etf): string {
    switch (tab) {
      case "best1y": return `${etf.return1y >= 0 ? "+" : ""}${etf.return1y.toFixed(1)}%`;
      case "hot30":  return `${etf.return1m >= 0 ? "+" : ""}${etf.return1m.toFixed(1)}%`;
      case "hot90":  return `${etf.return3m >= 0 ? "+" : ""}${etf.return3m.toFixed(1)}%`;
      case "yield":  return etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—";
      case "lowvol": return `${etf.volatility.toFixed(1)}%`;
    }
  }

  function getMetricLabel(): string {
    switch (tab) {
      case "best1y": return "近1年績效";
      case "hot30":  return "近30日";
      case "hot90":  return "近3月";
      case "yield":  return "殖利率";
      case "lowvol": return "波動度";
    }
  }

  function getMetricColor(etf: Etf): string {
    if (tab === "lowvol") return "text-blue-400";
    if (tab === "yield")  return "text-[#F5B700]";
    const v = tab === "hot30" ? etf.return1m : tab === "hot90" ? etf.return3m : etf.return1y;
    return v >= 0 ? "text-emerald-400" : "text-red-400";
  }

  return (
    <div className="mb-14">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-[20px] font-bold text-white">🏆 ETF 排行榜</h2>
        <div className="flex gap-2 flex-wrap justify-end">
          {ETF_RANK_TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded-lg text-[13px] font-semibold transition-colors ${
                tab === t.key
                  ? "bg-[#F5B700] text-[#0B1220]"
                  : "border border-white/[0.15] text-slate-400 hover:border-[#F5B700]/50 hover:text-[#F5B700]"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {ranked.map((etf, i) => (
          <div key={etf.code}
            className={`flex items-center gap-4 px-5 py-4 rounded-xl border transition-all hover:border-[#F5B700]/30 ${
              i === 0 ? "bg-yellow-500/[0.06] border-yellow-500/25" :
              i === 1 ? "bg-slate-400/[0.04] border-slate-400/20" :
              i === 2 ? "bg-orange-500/[0.04] border-orange-500/20" :
              "bg-white/[0.02] border-white/[0.07]"
            }`}>
            <div className="w-9 shrink-0 flex items-center justify-center">
              <RankBadge rank={i} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[15px] font-bold text-[#F5B700]">{etf.code}</span>
                <span className="text-[11px] text-slate-500 bg-white/[0.05] px-1.5 py-0.5 rounded">{etf.sector}</span>
              </div>
              <div className="text-[12px] text-slate-400 truncate">{etf.name}</div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[11px] text-slate-500 mb-0.5">{getMetricLabel()}</div>
              <div className={`text-[17px] font-black ${getMetricColor(etf)}`}>{getMetricValue(etf)}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 text-[11px] text-slate-600 text-right">示意資料・非即時行情</div>
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
    <div className="mb-8 border border-white/[0.08] rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]"
        style={{ background: "rgba(15,22,42,0.95)" }}>
        <div>
          <div className="text-[15px] font-bold text-white">投資條件篩選</div>
          <div className="text-[12px] text-slate-500 mt-0.5">選擇多個條件，交集搜尋符合的 ETF</div>
        </div>
        <div className="flex items-center gap-3">
          {selected.size > 0 && (
            <div className="flex items-center gap-3">
              <div className="text-[24px] font-black text-[#F5B700] leading-none">{resultCount}</div>
              <div className="text-[12px] text-slate-400 leading-tight">檔符合<br />條件</div>
            </div>
          )}
          {selected.size > 0 && (
            <button onClick={() => Array.from(selected).forEach(onToggle)}
              className="text-[12px] text-slate-500 hover:text-red-400 transition-colors border border-white/[0.1] px-3 py-1.5 rounded-lg">
              清除全部
            </button>
          )}
        </div>
      </div>

      {/* 關鍵字搜尋 */}
      <div className="px-6 pt-5 pb-3">
        <input type="text" value={keyword} onChange={e => onKeyword(e.target.value)}
          placeholder="搜尋代碼或名稱，例如 VOO、00878、高股息"
          className="w-full bg-white/[0.04] border border-white/[0.1] rounded-xl px-4 py-3 text-[14px] text-white placeholder:text-slate-600 focus:outline-none focus:border-[#F5B700]/50 transition-colors" />
      </div>

      {/* 條件群組 */}
      <div className="px-6 pb-5 space-y-4">
        {CRITERIA_GROUPS.map(group => {
          const options = CRITERIA_OPTIONS.filter(o => group.ids.includes(o.id));
          return (
            <div key={group.label}>
              <div className="text-[11px] font-semibold text-slate-500 tracking-[2px] uppercase mb-2">
                {group.label}
              </div>
              <div className="flex flex-wrap gap-2">
                {options.map(opt => {
                  const active = selected.has(opt.id);
                  return (
                    <button key={opt.id} onClick={() => onToggle(opt.id)}
                      className={`px-3.5 py-1.5 rounded-full text-[13px] font-semibold transition-all border ${
                        active
                          ? "bg-[#F5B700] text-[#0B1220] border-[#F5B700]"
                          : "bg-white/[0.03] text-slate-400 border-white/[0.1] hover:border-[#F5B700]/40 hover:text-[#F5B700]"
                      }`}>
                      {active && <span className="mr-1 text-[11px]">✓</span>}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* 已選條件摘要 */}
      {selected.size > 0 && (
        <div className="px-6 py-3 border-t border-white/[0.06] flex items-center gap-2 flex-wrap"
          style={{ background: "rgba(245,183,0,0.04)" }}>
          <span className="text-[11px] text-slate-500">已選條件：</span>
          {Array.from(selected).map(id => {
            const opt = CRITERIA_OPTIONS.find(o => o.id === id);
            return opt ? (
              <span key={id} className="text-[12px] text-[#F5B700] bg-[#F5B700]/10 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                {opt.label}
                <button onClick={() => onToggle(id)} className="text-[10px] opacity-60 hover:opacity-100">✕</button>
              </span>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────
export default function EtfDatabasePage() {
  const router = useRouter();

  const [keyword,     setKeyword]    = useState("");
  const [selected,    setSelected]   = useState<Set<string>>(new Set());
  const [sortKey,     setSortKey]    = useState<SortKey>("return1y");
  const [sortDir,     setSortDir]    = useState<SortDir>("desc");
  const [filterMode,  setFilterMode] = useState<FilterMode>("all");

  const {
    favList, watchList, compareList,
    toggleFav: _toggleFav, toggleWatch: _toggleWatch, toggleCompare: _toggleCompare,
    clearCompare, toast, showToast,
  } = useWatchlist("etf");

  const toggleFav     = useCallback((etf: Etf) => _toggleFav({ id: etf.code, type: "etf", name: etf.name }), [_toggleFav]);
  const toggleWatch   = useCallback((etf: Etf) => _toggleWatch({ id: etf.code, type: "etf", name: etf.name }), [_toggleWatch]);
  const toggleCompare = useCallback((etf: Etf) => _toggleCompare({ id: etf.code, type: "etf", name: etf.name }), [_toggleCompare]);

  function toggleCriterion(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  }

  const filtered = useMemo(() => {
    let list: Etf[] = ETF_LIST;

    // filterMode
    if (filterMode === "fav")   list = list.filter(e => hasItem(favList, e.code));
    if (filterMode === "watch") list = list.filter(e => hasItem(watchList, e.code));

    // 關鍵字
    if (keyword.trim()) {
      const kw = keyword.trim().toLowerCase();
      list = list.filter(e => e.code.toLowerCase().includes(kw) || e.name.toLowerCase().includes(kw));
    }

    // Investment Criteria（交集）
    if (selected.size > 0) {
      const criteria = CRITERIA_OPTIONS.filter(o => selected.has(o.id));
      list = list.filter(e => criteria.every(c => c.filter(e)));
    }

    return [...list].sort((a, b) => {
      const diff = a[sortKey] - b[sortKey];
      return sortDir === "asc" ? diff : -diff;
    });
  }, [keyword, selected, sortKey, sortDir, filterMode, favList, watchList]);

  // Task 2：排序欄位 Highlight
  function Th({ label, k }: { label: string; k: SortKey }) {
    const active = sortKey === k;
    return (
      <th onClick={() => handleSort(k)}
        className={`px-3 py-3.5 font-semibold cursor-pointer select-none transition-colors whitespace-nowrap text-[12px] ${
          active
            ? "text-[#F5B700] bg-[#F5B700]/[0.06]"
            : "text-slate-400 hover:text-[#F5B700]"
        }`}>
        <span className="flex items-center gap-1">
          {label}
          <span className="text-[10px]">{active ? (sortDir === "asc" ? "▲" : "▼") : "↕"}</span>
        </span>
      </th>
    );
  }

  return (
    <main className="min-h-screen px-6 pt-32 pb-24">

      {/* NAVBAR */}
      <header className="fixed top-0 left-0 w-full z-50 bg-[#040a18]/90 backdrop-blur-xl border-b border-white/[0.08]">
        <div className="max-w-[1700px] mx-auto h-20 px-10 flex items-center justify-between">
          <Link href="/">
            <div className="text-[28px] font-black text-white leading-none">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="text-[11px] text-slate-400 mt-0.5">Investment Intelligence Platform</div>
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

        {/* Page Header（Task 7：產品定位放在 Page Header）*/}
        <div className="mb-12">
          <div className="tracking-[10px] text-[#F5B700] text-[13px] font-semibold mb-3">ETF DATABASE</div>
          <h1 className="text-[40px] font-black text-white mb-2">ETF 篩選器</h1>
          <p className="text-[16px] text-slate-400 max-w-[600px] leading-relaxed">
            建立你的投資條件，快速找出符合需求的 ETF。
            條件可以自由組合，所有結果即時更新。
          </p>
          <div className="flex items-center gap-6 mt-4 text-[14px] text-slate-500">
            <span>共 <span className="text-white font-semibold">{ETF_LIST.length}</span> 檔 ETF</span>
            <span>·</span>
            <span>示意資料・非即時行情</span>
          </div>
        </div>

        {/* 排行榜 */}
        <EtfRankingSection />

        {/* Compare bar */}
        {compareList.length > 0 && (
          <div className="flex items-center justify-between bg-emerald-900/30 border border-emerald-500/30 rounded-xl px-5 py-3 mb-8">
            <div className="text-[13px] text-emerald-300 font-semibold">
              📊 比較清單：{compareList.length} 檔
              <span className="text-emerald-600 ml-2 font-normal">
                {compareList.slice(0, 3).map(i => i.name.slice(0, 6)).join("、")}{compareList.length > 3 ? "…" : ""}
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

        {/* Investment Criteria Builder（Task 3）*/}
        <CriteriaBuilder
          selected={selected}
          onToggle={toggleCriterion}
          keyword={keyword}
          onKeyword={setKeyword}
          resultCount={filtered.length}
        />

        {/* Filter tabs（收藏 / 觀察）*/}
        <div className="flex items-center justify-between mb-5">
          <div className="flex gap-2">
            {([
              { key: "all"   as FilterMode, label: `全部 (${ETF_LIST.length})` },
              { key: "fav"   as FilterMode, label: `⭐ 收藏 (${favList.length})` },
              { key: "watch" as FilterMode, label: `👀 觀察 (${watchList.length})` },
            ]).map(tab => (
              <button key={tab.key} onClick={() => setFilterMode(tab.key)}
                className={`px-4 py-2 rounded-lg text-[13px] font-semibold transition-colors ${
                  filterMode === tab.key
                    ? "bg-[#F5B700] text-[#0B1220]"
                    : "border border-white/[0.12] text-slate-400 hover:border-white/30 hover:text-white"
                }`}>
                {tab.label}
              </button>
            ))}
          </div>
          <div className="text-[13px] text-slate-500">
            符合條件：<span className="text-white font-semibold">{filtered.length}</span> 檔
          </div>
        </div>

        {/* Table（Task 2：Highlight 整欄）*/}
        <div className="border border-white/[0.08] rounded-2xl overflow-hidden overflow-x-auto">
          <table className="w-full text-left min-w-[1300px]">
            <thead>
              <tr className="border-b border-white/[0.06]" style={{ background: "rgba(15,22,42,0.9)" }}>
                <th className="px-4 py-3.5 text-[12px] font-semibold text-slate-400 w-[108px]">操作</th>
                <th className="px-3 py-3.5 text-[12px] font-semibold text-slate-400 w-[80px]">代碼</th>
                <th className="px-3 py-3.5 text-[12px] font-semibold text-slate-400">名稱</th>
                <th className="px-3 py-3.5 text-[12px] font-semibold text-slate-500">類型</th>
                <th className="px-3 py-3.5 text-[12px] font-semibold text-slate-500">配息</th>
                <Th label="每單位配息" k="dividendPerUnit" />
                <Th label="殖利率%" k="dividendYield" />
                <Th label="今年%" k="returnYTD" />
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
                  className={`text-[13px] text-white border-t border-white/[0.04] hover:bg-[#F5B700]/[0.03] transition-colors ${
                    i % 2 === 1 ? "bg-white/[0.015]" : ""
                  }`}>
                  <td className="px-4 py-3">
                    <ActionBtns etf={etf}
                      favList={favList} watchList={watchList} compareList={compareList}
                      onFav={toggleFav} onWatch={toggleWatch} onCompare={toggleCompare} />
                  </td>
                  <td className="px-3 py-3 font-bold text-[#F5B700]">{etf.code}</td>
                  <td className="px-3 py-3 text-slate-200 max-w-[200px] truncate">{etf.name}</td>
                  <td className="px-3 py-3 text-slate-500 text-[11px]">{etf.sector}</td>
                  <td className="px-3 py-3 text-slate-500 text-[11px]">{etf.dividendFreq}</td>
                  {/* Highlight 整欄（排序中的欄位背景略亮）*/}
                  <td className={`px-3 py-3 text-slate-300 ${sortKey === "dividendPerUnit" ? "bg-[#F5B700]/[0.04]" : ""}`}>
                    {etf.dividendPerUnit > 0 ? etf.dividendPerUnit.toFixed(2) : "—"}
                  </td>
                  <td className={`px-3 py-3 text-slate-300 ${sortKey === "dividendYield" ? "bg-[#F5B700]/[0.04]" : ""}`}>
                    {etf.dividendYield > 0 ? `${etf.dividendYield.toFixed(1)}%` : "—"}
                  </td>
                  <td className={`px-3 py-3 ${sortKey === "returnYTD"  ? "bg-[#F5B700]/[0.04]" : ""}`}><Pct v={etf.returnYTD} /></td>
                  <td className={`px-3 py-3 ${sortKey === "return1m"   ? "bg-[#F5B700]/[0.04]" : ""}`}><Pct v={etf.return1m} /></td>
                  <td className={`px-3 py-3 ${sortKey === "return3m"   ? "bg-[#F5B700]/[0.04]" : ""}`}><Pct v={etf.return3m} /></td>
                  <td className={`px-3 py-3 ${sortKey === "return6m"   ? "bg-[#F5B700]/[0.04]" : ""}`}><Pct v={etf.return6m} /></td>
                  <td className={`px-3 py-3 ${sortKey === "return1y"   ? "bg-[#F5B700]/[0.04]" : ""}`}><Pct v={etf.return1y} /></td>
                  <td className={`px-3 py-3 ${sortKey === "return3y"   ? "bg-[#F5B700]/[0.04]" : ""}`}><Pct v={etf.return3y} /></td>
                  <td className={`px-3 py-3 text-slate-400 ${sortKey === "volatility" ? "bg-[#F5B700]/[0.04]" : ""}`}>
                    {etf.volatility.toFixed(1)}%
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={14} className="px-5 py-16 text-center text-slate-600">
                  {filterMode === "fav"   ? "尚未收藏任何 ETF，點擊 ⭐ 加入收藏" :
                   filterMode === "watch" ? "觀察名單是空的，點擊 👀 加入" :
                   "找不到符合條件的 ETF，請嘗試放寬條件"}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-slate-700 mt-5">
          以上資料為示意範例，非即時市場數據，不構成投資建議。
        </p>

        <div className="flex justify-center mt-10">
          <Link href="/" className="border border-white/20 text-white px-10 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">
            回到首頁
          </Link>
        </div>
      </div>

      {toast && <Toast msg={toast} onClose={() => showToast("")} />}
    </main>
  );
}