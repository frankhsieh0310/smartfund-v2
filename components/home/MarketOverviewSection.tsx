"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { HomeMarketCard, HomeMarketOverview, HomeMarketTab } from "@/lib/data-platform/web/homeMarketService";

const TABS: Array<{ id: HomeMarketTab; label: string }> = [
  { id: "stocks", label: "指數" },
  { id: "bonds", label: "債券與利率" },
  { id: "fx", label: "外匯" },
  { id: "commodities", label: "商品" },
  { id: "crypto", label: "加密資產" },
];

const EMPTY: Record<HomeMarketTab, HomeMarketCard[]> = { stocks: [], bonds: [], fx: [], commodities: [], crypto: [] };

const marketName=(symbol:string|null,label:string)=>({"^GSPC":"標普500指數","^IXIC":"那斯達克綜合指數","^N225":"日經225指數","^TWII":"台灣加權指數","^VIX":"CBOE波動率指數","VIX":"CBOE波動率指數"}[symbol??""]??label);
function formatValue(card: HomeMarketCard) {
  if (card.value === null) return null;
  return card.value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatChange(card: HomeMarketCard) {
  if (card.changePercent !== null) return `${card.changePercent > 0 ? "+" : ""}${(card.changePercent * 100).toFixed(2)}%`;
  if (card.change !== null) return `${card.change > 0 ? "+" : ""}${card.change.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
  return "—";
}

export function MarketOverviewSection() {
  const [activeTab, setActiveTab] = useState<HomeMarketTab>("stocks");
  const [tabs, setTabs] = useState(EMPTY);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/home-market-overview", { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<HomeMarketOverview> : Promise.reject())
      .then((payload) => setTabs(payload.tabs))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const cards = tabs[activeTab];

  return (
    <section className="relative z-10 overflow-hidden bg-[#07111f] py-16 md:py-20">
      <div className="mx-auto max-w-[1600px] px-6 sm:px-8 md:px-10">
        <div className="mb-8 flex items-end justify-between gap-6">
          <div>
            <div className="mb-3 text-[12px] font-semibold tracking-[0.32em] text-[#F5B700] md:text-[13px]">即時市場資料</div>
            <h2 className="text-[32px] font-black tracking-[-0.02em] text-white md:text-[40px]">全球市場總覽</h2>
            <p className="mt-2 text-[15px] text-slate-400 md:text-[16px]">掌握全球跨資產市場的最新概況。</p>
          </div>
          <Link href="/markets" className="hidden whitespace-nowrap text-[15px] font-semibold text-[#F5B700] transition-colors hover:text-[#ffd04a] sm:block">查看全球市場 →</Link>
        </div>

        <div className="mb-6 flex gap-2 overflow-x-auto pb-1">
          {TABS.map((tab) => (
            <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} className={`shrink-0 rounded-full border px-4 py-2 text-[14px] font-semibold transition-colors ${activeTab === tab.id ? "border-[#F5B700]/60 bg-[#F5B700]/15 text-[#F5B700]" : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-white"}`}>
              {tab.label}
            </button>
          ))}
        </div>

        <div className="grid grid-flow-col auto-cols-[calc(50%-0.375rem)] gap-3 overflow-x-auto pb-4 sm:auto-cols-[230px] md:auto-cols-[250px] md:gap-4">
          {(cards.length ? cards : [null]).map((card, index) => {
            const value = card ? formatValue(card) : null;
            const positive = card && (card.changePercent ?? card.change ?? 0) > 0;
            const negative = card && (card.changePercent ?? card.change ?? 0) < 0;
            return (
              <article key={card?.id ?? `pending-${index}`} className="min-h-[170px] rounded-2xl border border-white/[0.09] bg-white/[0.045] p-4 backdrop-blur-xl md:min-h-[184px] md:p-5">
                <div className="text-[15px] font-bold text-white md:text-[16px]">{card?marketName(card.symbolOrCode,card.label):"資料更新中"}</div>
                <div className="mt-1 text-[11px] font-semibold tracking-[0.12em] text-slate-500">{card?.symbolOrCode ?? "—"}</div>
                {value ? (
                  <>
                    <div className="mt-5 text-[25px] font-bold tracking-[-0.02em] text-white md:text-[28px]">{value}{card?.unit === "%" || card?.unit?.toLowerCase() === "percent" ? "%" : ""}</div>
                    <div className="mt-3 flex items-center justify-between gap-2 text-[11px] md:text-[12px]">
                      <span className={positive ? "text-emerald-400" : negative ? "text-rose-400" : "text-slate-500"}>{formatChange(card!)}</span>
                      <span className="truncate text-slate-500">{card?.asOfDate ? new Date(card.asOfDate).toLocaleDateString("zh-TW") : "日期未提供"}</span>
                    </div>
                    
                  </>
                ) : (
                  <div className="mt-8 text-[12px] font-semibold tracking-[0.16em] text-slate-500">暫無可用資料</div>
                )}
              </article>
            );
          })}
        </div>

        <Link href="/markets" className="mt-2 inline-block text-[14px] font-semibold text-[#F5B700] sm:hidden">查看全球市場 →</Link>
      </div>
    </section>
  );
}
