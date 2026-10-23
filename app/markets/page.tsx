"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// 2026-10-14 QA round 4: replaced hardcoded placeholder index/commodity/bond numbers with real
// data from /api/home-market-overview (same real, already-built source now powering
// components/home/MarketOverviewSection.tsx). Sections are grouped by asset class (what the API
// actually provides: stocks/bonds/commodities/crypto) rather than by country, since the real data
// isn't broken out by country. The FX tab currently has 0 real rows, so it's simply not shown.

type HomeMarketCard = {
  assetType: string;
  id: string;
  label: string;
  symbolOrCode: string | null;
  value: number | null;
  change: number | null;
  changePercent: number | null;
  unit: string | null;
  currency: string | null;
  asOfDate: string | null;
};

// 2026-10-23（使用者核准，台灣買不到的就不要放）: crypto tab移除。
type HomeMarketOverview = { tabs: Record<"stocks" | "bonds" | "fx" | "commodities", HomeMarketCard[]> };

type MktItem = { name: string; value: string; pts: string; pct: string; up: boolean; asOfDate: string | null };
type MktSection = { id: string; label: string; emoji: string; items: MktItem[] };

function fmtValue(v: number | null, unit: string | null): string {
  if (v === null) return "—";
  return unit === "%" ? `${v.toFixed(2)}%` : v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : 2 });
}
function fmtChange(v: number | null): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
// COMMODITY/CRYPTO/VOLATILITY rows store changePercent as a raw fraction (e.g. -0.0064 = -0.64%),
// confirmed against their own change/value ratio; INDEX/YIELD/RATE rows already store an actual
// percent (e.g. -0.17 = -0.17%). This only corrects the unit each field is already documented to be
// in -- it does not derive a new figure from anything the source didn't already report.
const FRACTION_UNIT_TYPES = new Set(["COMMODITY", "CRYPTO", "VOLATILITY"]);
function fmtPct(v: number | null, assetType: string): string {
  if (v === null) return "—";
  const pct = FRACTION_UNIT_TYPES.has(assetType) ? v * 100 : v;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}
function toItem(c: HomeMarketCard): MktItem {
  const pct = c.changePercent === null ? null : (FRACTION_UNIT_TYPES.has(c.assetType) ? c.changePercent * 100 : c.changePercent);
  return { name: c.label, value: fmtValue(c.value, c.unit), pts: fmtChange(c.change), pct: fmtPct(c.changePercent, c.assetType), up: (pct ?? 0) >= 0, asOfDate: c.asOfDate };
}

// ── Sparkline (direction indicator only, not a real price series) ──────────
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

function MktBlock({ section }: { section: MktSection }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] overflow-hidden mb-4"
      style={{ background: "rgba(17,24,39,0.75)", backdropFilter: "blur(16px)" }}>
      <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]">
        <span className="text-[22px]">{section.emoji}</span>
        <span className="text-[18px] font-bold text-white">{section.label}</span>
        <span className="ml-auto text-[12px] text-slate-500">{section.items.length} 個指標</span>
      </div>
      <div className="flex items-center gap-4 px-5 py-2 text-[11px] text-slate-600 tracking-wide border-b border-white/[0.04]">
        <span className="w-6 shrink-0">#</span>
        <span className="flex-1">名稱</span>
        <span className="w-28 text-right shrink-0">最新值</span>
        <span className="w-36 text-right shrink-0">漲跌</span>
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
  const [data, setData] = useState<HomeMarketOverview | null>(null);
  const [error, setError] = useState(false);
  const [asOfDate, setAsOfDate] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/home-market-overview")
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((j: HomeMarketOverview) => {
        if (cancelled) return;
        setData(j);
        const dates = Object.values(j.tabs).flat().map((c) => c.asOfDate).filter(Boolean) as string[];
        setAsOfDate(dates.sort().at(-1) ?? null);
      })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  const SECTIONS: MktSection[] = data ? [
    { id: "stocks", label: "股市指數", emoji: "📈", items: data.tabs.stocks.map(toItem) },
    { id: "bonds", label: "公債殖利率", emoji: "📊", items: data.tabs.bonds.map(toItem) },
    { id: "commodities", label: "大宗商品", emoji: "🥇", items: data.tabs.commodities.map(toItem) },
  ].filter((s) => s.items.length > 0) : [];

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
            {data ? `涵蓋股市指數、公債殖利率、大宗商品，共 ${totalCount} 個市場指標` : "資料載入中…"}
          </p>
        </div>

        {error && (
          <div className="text-center py-20 text-slate-500">市場資料暫時無法載入，請稍後再試。</div>
        )}

        {data && (
          <>
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
                {asOfDate ? `資料基準日 ${asOfDate.slice(0, 10)}` : ""}
              </div>
            </div>

            {/* 搜尋 */}
            <div className="mb-8">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="搜尋指數名稱，例如：那斯達克、黃金"
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
              本站資料僅供參考，不構成投資建議。實際行情請參考各交易所或專業金融資訊平台。
            </p>
          </>
        )}

        <div className="flex justify-center mt-8">
          <Link href="/" className="border border-white/20 text-white px-8 py-3 rounded-lg hover:bg-white/[0.03] transition-colors font-semibold text-[15px]">
            回到首頁
          </Link>
        </div>

      </div>
    </main>
  );
}
