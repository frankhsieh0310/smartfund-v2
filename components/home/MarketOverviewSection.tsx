"use client";
// ============================================================
// components/home/MarketOverviewSection.tsx
// 全球市場概況 Section（首頁 ZONE 5）
// 2026-10-14 QA round 4: replaced hardcoded placeholder numbers with real data from
// /api/home-market-overview (lib/data-platform/web/homeMarketService.ts -- already queries
// MarketMaster/economic-series tables, no new backend work needed). Grouped by asset class
// (what the API actually provides), not by country, since the real data isn't broken out that way.
// The FX tab currently returns 0 rows (no FX data loaded into that source yet) -- that group is
// simply omitted rather than showing a fabricated placeholder.
// ============================================================

import { useEffect, useState } from "react";
import Link from "next/link";

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

type HomeMarketOverview = { tabs: Record<"stocks" | "bonds" | "fx" | "commodities", HomeMarketCard[]> };

function fmtValue(v: number | null, unit: string | null): string {
  if (v === null) return "—";
  const n = unit === "%" ? `${v.toFixed(2)}%` : v.toLocaleString("en-US", { maximumFractionDigits: v >= 1000 ? 0 : 2 });
  return n;
}
function fmtChange(v: number | null): string {
  if (v === null) return "—";
  return `${v >= 0 ? "+" : ""}${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
// COMMODITY/CRYPTO/VOLATILITY rows store changePercent as a raw fraction (e.g. -0.0064 = -0.64%,
// confirmed against their own change/value ratio); INDEX/YIELD/RATE rows already store an actual
// percent. This only corrects the unit each field is already documented to be in, never derives a
// new figure.
const FRACTION_UNIT_TYPES = new Set(["COMMODITY", "CRYPTO", "VOLATILITY"]);
function fmtPct(v: number | null, assetType: string): string {
  if (v === null) return "—";
  const pct = FRACTION_UNIT_TYPES.has(assetType) ? v * 100 : v;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

// ── Sparkline (purely decorative direction indicator, not a real price series) ──
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

function GroupRow({ emoji, label, sublabel, items }: { emoji: string; label: string; sublabel: string; items: HomeMarketCard[] }) {
  if (items.length === 0) return null;
  return (
    <div className="border border-white/[0.08] rounded-2xl overflow-hidden mb-4"
      style={{ background: "rgba(15,22,42,0.85)", backdropFilter: "blur(20px)" }}>
      <div className="px-7 py-5">
        <div className="flex items-center gap-6">
          <div className="w-[140px] shrink-0 flex items-center gap-3">
            <span className="text-[26px]">{emoji}</span>
            <div>
              <div className="text-[17px] font-bold text-white leading-tight">{label}</div>
              <div className="text-[10px] tracking-[3px] text-white/35 mt-0.5">{sublabel}</div>
            </div>
          </div>
          <div className="w-px h-12 bg-white/[0.08] shrink-0" />
          <div className="flex flex-1 gap-0 min-w-0 flex-wrap">
            {items.map((item, i) => {
              const up = (item.changePercent ?? 0) >= 0;
              return (
                <div key={item.id} className="flex items-center gap-5 flex-1 min-w-[180px] px-5">
                  {i > 0 && <div className="w-px h-10 bg-white/[0.06] shrink-0 -ml-5" />}
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] text-white/50 mb-1 truncate">{item.label}</div>
                    <div className="text-[24px] font-bold text-white leading-none mb-1">{fmtValue(item.value, item.unit)}</div>
                    <div className={`text-[15px] font-semibold ${up ? "text-[#22C55E]" : "text-[#EF4444]"}`}>
                      {item.change !== null ? (up ? "▲" : "▼") : ""} {fmtChange(item.change)} <span className="text-[13px]">{fmtPct(item.changePercent, item.assetType)}</span>
                    </div>
                  </div>
                  <Sparkline up={up} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MarketOverviewSection() {
  const [data, setData] = useState<HomeMarketOverview | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/home-market-overview")
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((j) => { if (!cancelled) setData(j); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);

  if (error) return null; // real-data-only section: hide rather than show nothing useful
  if (!data) return null;

  const { stocks, bonds, commodities } = data.tabs;

  return (
    <section className="relative z-10 py-20" style={{ backgroundColor: "#0a1628" }}>
      <div className="max-w-[1600px] mx-auto px-10">
        <div className="flex items-end justify-between mb-8">
          <div>
            <div className="text-[14px] tracking-[10px] text-[#F5B700] font-semibold mb-3">GLOBAL MARKETS</div>
            <h2 className="text-[40px] font-black text-white">全球市場概況</h2>
          </div>
          <Link href="/markets" className="text-[16px] font-semibold text-[#F5B700] border border-[#F5B700]/40 px-5 py-2.5 rounded-lg hover:bg-[#F5B700]/10 transition-colors">
            完整市場中心 →
          </Link>
        </div>
        <GroupRow emoji="📈" label="股市指數" sublabel="STOCK INDICES" items={stocks} />
        <GroupRow emoji="📊" label="公債殖利率" sublabel="BOND YIELDS" items={bonds} />
        <GroupRow emoji="🥇" label="大宗商品" sublabel="COMMODITIES" items={commodities} />
      </div>
    </section>
  );
}
