"use client";

import Link from "next/link";
import { AuthButton } from "@/components/auth/AuthButton";
import { useEffect, useRef, useState } from "react";


const investmentItems = [
  { label: "股票" }, { label: "ETF", href: "/etf" }, { label: "基金", href: "/funds" },
  { label: "債券" }, { label: "REITs" }, { label: "指數" }, { label: "外匯" },
  { label: "商品" }, { label: "加密貨幣" }, { label: "期貨" },
];
const researchItems = [
  { label: "SmartMatch", href: "/quiz" }, { label: "篩選器", href: "/etf" },
  { label: "商品比較", href: "/compare" }, { label: "配息資訊與試算", href: "/dividend-center" }, { label: "新商品", href: "/new-listings" }, { label: "投資日曆", href: "/calendar" }, { label: "投資組合健檢", href: "/portfolio" },
];
function HeaderDropdown({ label, items, open, onToggle, onClose }: {
  label: string;
  items: ReadonlyArray<{ label: string; href?: string }>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
}) {
  return (
    <details className="group relative" open={open}>
      <summary onClick={(event) => { event.preventDefault(); onToggle(); }} className="flex cursor-pointer list-none items-center gap-1 whitespace-nowrap py-7 transition-colors hover:text-white [&::-webkit-details-marker]:hidden">
        {label}<span className="text-[10px] text-slate-500 transition-transform group-open:rotate-180">▼</span>
      </summary>
      <div className="absolute left-1/2 top-[68px] w-48 -translate-x-1/2 rounded-xl border border-white/[0.12] bg-[#07111f]/[0.98] p-2 shadow-[0_18px_55px_rgba(0,0,0,0.45)] backdrop-blur-xl">
        {items.map((item) => item.href ? (
          <Link key={item.label} href={item.href} onClick={onClose} className="block rounded-lg px-3 py-2.5 text-[14px] font-medium text-slate-300 transition-colors hover:bg-white/[0.07] hover:text-white">{item.label}</Link>
        ) : (
          <span key={item.label} onClick={onClose} className="block rounded-lg px-3 py-2.5 text-[14px] font-medium text-slate-500">{item.label}</span>
        ))}
      </div>
    </details>
  );
}

// 排行榜 -- 接上既有、本來就在跑的正式資料 API（/api/rankings/performance，App 的排行中心
// src/ranking/service.ts 早就在用同一支）。只是網站這邊的畫面從沒接過，一直顯示「資料準備中」。
// ETF/FUND 維度、期間、資產類別跟 App 版用同一套清單，保持兩邊一致。
type AssetType = "ETF" | "FUND";
type RankingType = "PERFORMANCE" | "AUM" | "VOLUME" | "DIVIDEND_YIELD" | "BETA" | "MORNINGSTAR";
type Period = "1M" | "3M" | "6M" | "YTD" | "1Y" | "3Y" | "5Y";
type AssetCategory = "STOCK" | "BOND" | "COMMODITY" | "MIXED";
type RankingRow = { id: string; code: string | null; name: string; metricValue: number; metricDisplay: string; price: number | null; priceDate: string | null; classificationBasis?: "OFFICIAL" | "KEYWORD_FALLBACK" | "UNCLASSIFIED" };
type RankingResponse = { assetType: AssetType; rankingType: RankingType; period?: Period; supported: boolean; total: number; results: RankingRow[]; reason?: string };

const ETF_DIMENSIONS: { key: RankingType; label: string }[] = [
  { key: "PERFORMANCE", label: "績效" }, { key: "AUM", label: "規模" }, { key: "VOLUME", label: "交易" },
  { key: "DIVIDEND_YIELD", label: "配息" }, { key: "BETA", label: "Beta" },
];
const FUND_DIMENSIONS: { key: RankingType; label: string }[] = [
  { key: "PERFORMANCE", label: "績效" }, { key: "MORNINGSTAR", label: "晨星評等" },
];
const CATEGORIES: { key: AssetCategory | "ALL"; label: string }[] = [
  { key: "ALL", label: "全部" }, { key: "STOCK", label: "股票型" }, { key: "BOND", label: "債券型" }, { key: "COMMODITY", label: "商品型" },
];
const CANDIDATE_PERIODS: Period[] = ["1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y"];

async function fetchRanking(assetType: AssetType, rankingType: RankingType, opts: { period?: Period; category?: AssetCategory | "ALL" } = {}, signal?: AbortSignal): Promise<RankingResponse> {
  const params = new URLSearchParams({ assetType, rankingType, limit: "30", page: "1" });
  if (opts.period) params.set("period", opts.period);
  if (opts.category && opts.category !== "ALL") params.set("category", opts.category);
  const res = await fetch(`/api/rankings/performance?${params.toString()}`, { signal });
  return res.json();
}

function RankingTable() {
  const [assetType, setAssetType] = useState<AssetType>("ETF");
  const [dimension, setDimension] = useState<RankingType>("PERFORMANCE");
  const [period, setPeriod] = useState<Period>("1Y");
  const [category, setCategory] = useState<AssetCategory | "ALL">("ALL");
  const [availablePeriods, setAvailablePeriods] = useState<Period[] | null>(null);
  const [state, setState] = useState<{ status: "loading" | "error" | "ready"; data?: RankingResponse }>({ status: "loading" });

  const dimensions = assetType === "ETF" ? ETF_DIMENSIONS : FUND_DIMENSIONS;

  useEffect(() => {
    if (dimension !== "PERFORMANCE") { setAvailablePeriods(null); return; }
    let cancelled = false;
    (async () => {
      const checks = await Promise.all(CANDIDATE_PERIODS.map((p) => fetchRanking(assetType, "PERFORMANCE", { period: p }).then((r) => (r.supported ? p : null)).catch(() => null)));
      if (cancelled) return;
      const real = checks.filter((p): p is Period => p !== null);
      setAvailablePeriods(real);
      if (real.length && !real.includes(period)) setPeriod(real[0]);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetType, dimension]);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    fetchRanking(assetType, dimension, { ...(dimension === "PERFORMANCE" ? { period } : {}), category }, controller.signal)
      .then((data) => !controller.signal.aborted && setState({ status: "ready", data }))
      .catch(() => !controller.signal.aborted && setState({ status: "error" }));
    return () => controller.abort();
  }, [assetType, dimension, period, category]);

  const detailHref = (row: RankingRow) => (assetType === "ETF" ? `/etf/${encodeURIComponent(row.code ?? row.id)}` : `/funds/${encodeURIComponent(row.id)}`);

  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.03]">
      <div className="flex flex-wrap gap-2 border-b border-white/[0.08] p-5">
        {(["ETF", "FUND"] as const).map((t) => (
          <button key={t} onClick={() => { setAssetType(t); setDimension("PERFORMANCE"); }} className={`rounded-full px-4 py-2 text-[13px] font-bold ${assetType === t ? "bg-[#F5B700] text-[#0B1220]" : "bg-white/[0.06] text-slate-300"}`}>{t === "ETF" ? "ETF" : "基金"}</button>
        ))}
        <span className="mx-2 self-center text-slate-600">|</span>
        {dimensions.map((d) => (
          <button key={d.key} onClick={() => setDimension(d.key)} className={`rounded-full px-4 py-2 text-[13px] font-bold ${dimension === d.key ? "bg-white/[0.14] text-white" : "bg-white/[0.06] text-slate-400"}`}>{d.label}</button>
        ))}
        <span className="mx-2 self-center text-slate-600">|</span>
        {CATEGORIES.map((c) => (
          <button key={c.key} onClick={() => setCategory(c.key)} className={`rounded-full px-3 py-1.5 text-[12px] font-bold ${category === c.key ? "bg-white/[0.14] text-white" : "bg-white/[0.04] text-slate-500"}`}>{c.label}</button>
        ))}
      </div>
      {dimension === "PERFORMANCE" && availablePeriods && availablePeriods.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-white/[0.06] px-5 py-3">
          {availablePeriods.map((p) => (
            <button key={p} onClick={() => setPeriod(p)} className={`rounded-lg px-3 py-1.5 text-[12px] font-bold ${period === p ? "bg-[#F5B700] text-[#0B1220]" : "bg-white/[0.05] text-slate-400"}`}>{p}</button>
          ))}
        </div>
      )}
      {state.status === "loading" ? (
        <div className="py-16 text-center text-slate-500">載入中…</div>
      ) : state.status === "error" ? (
        <div className="py-16 text-center text-slate-500">排行資料暫時無法載入，請稍後再試。</div>
      ) : !state.data?.supported ? (
        <div className="py-16 text-center text-slate-500">這個維度目前沒有真實資料可供排行。</div>
      ) : state.data.results.length === 0 ? (
        <div className="py-16 text-center text-slate-500">目前沒有符合的資料。</div>
      ) : (
        <div className="divide-y divide-white/[0.05]">
          {state.data.results.map((row, idx) => (
            <Link key={row.id} href={detailHref(row)} className="flex items-center gap-4 px-5 py-4 hover:bg-white/[0.03]">
              <span className="w-6 text-[13px] text-slate-600">{idx + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold text-white">{row.name}</div>
                <div className="mt-0.5 text-[12px] text-slate-500">{row.code ?? ""}{row.priceDate ? `・${row.priceDate}` : ""}{row.classificationBasis === "KEYWORD_FALLBACK" ? "・分類依名稱關鍵字判斷" : ""}</div>
              </div>
              <span className="text-[16px] font-bold text-[#F5B700]">{row.metricDisplay}</span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export default function RankingsPage() {
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);
  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setActiveDropdown(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveDropdown(null);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <main className="min-h-screen bg-[#07111f] text-white">
      <header ref={headerRef} className="fixed left-0 top-0 z-50 w-full border-b border-white/[0.08] bg-[#040a18]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-[1600px] items-center justify-between px-6 sm:px-10">
          <Link href="/">
            <div className="text-[28px] font-black leading-none text-white sm:text-[32px]">Smart<span className="text-[#F5B700]">Fund</span></div>
            <div className="mt-0.5 text-[11px] text-slate-400 sm:text-[12px]">全球投資研究平台</div>
          </Link>
          <nav className="hidden items-center gap-5 text-[15px] font-semibold text-slate-300 lg:flex">
            <Link href="/markets" className="whitespace-nowrap py-7 transition-colors hover:text-white">市場總覽</Link>
            <HeaderDropdown label="投資商品" items={investmentItems} open={activeDropdown === "investment"} onToggle={() => setActiveDropdown((value) => value === "investment" ? null : "investment")} onClose={() => setActiveDropdown(null)} />
            <HeaderDropdown label="研究工具" items={researchItems} open={activeDropdown === "research"} onToggle={() => setActiveDropdown((value) => value === "research" ? null : "research")} onClose={() => setActiveDropdown(null)} />
            <Link href="/rankings" className="whitespace-nowrap py-7 text-white">排行榜</Link>
            <Link href="/portfolio" className="whitespace-nowrap py-7 transition-colors hover:text-white">投資組合</Link>
            <Link href="/pricing" className="whitespace-nowrap py-7 transition-colors hover:text-[#F5B700]">會員專區</Link>
          </nav>
          <div className="flex items-center gap-2 sm:gap-4">
            <AuthButton className="hidden rounded-lg border border-white/30 px-5 py-2.5 text-[15px] font-semibold text-slate-300 transition-colors hover:bg-white/10 sm:block" />
            <Link href="/quiz" className="rounded-lg bg-[#F5B700] px-4 py-2.5 text-[14px] font-bold text-[#0B1220] transition-colors hover:bg-[#e0a800] sm:px-6 sm:text-[15px]">開始建立</Link>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-6 pb-20 pt-32 sm:px-8 md:px-10">
        <section className="flex flex-col justify-between gap-7 border-b border-white/[0.08] pb-9 md:flex-row md:items-end">
          <div>
            <div className="text-[12px] font-semibold tracking-[0.3em] text-[#F5B700]">GLOBAL RANKINGS</div>
            <h1 className="mt-4 text-[42px] font-black tracking-[-0.03em] md:text-[52px]">全球排行榜</h1>
            <p className="mt-4 text-[17px] leading-8 text-slate-400">快速探索不同市場與投資商品的表現排行。</p>
          </div>
          <div className="text-[13px] text-slate-500">資料更新時間：—</div>
        </section>

        {/* 2026-10-24: 接上 /api/rankings/performance（既有、已上線、App 排行中心本來就在用的
            同一支 API），取代之前永遠顯示「資料準備中」的死畫面。 */}
        <RankingTable />

        <section className="mt-10 flex flex-col justify-between gap-7 rounded-2xl border border-[#F5B700]/20 bg-[#F5B700]/[0.055] p-7 md:flex-row md:items-center md:p-9">
          <div>
            <div className="inline-flex rounded-full border border-[#F5B700]/25 bg-[#F5B700]/10 px-3 py-1 text-[9px] font-bold tracking-[0.14em] text-[#F5B700]">PREMIUM</div>
            <h2 className="mt-4 text-[24px] font-black">進階排行榜</h2>
            <p className="mt-3 max-w-3xl text-[13px] leading-7 text-slate-400">未來可支援多期間、風險調整後、資產類別、區域與自訂條件排行。</p>
          </div>
          <Link href="/pricing" className="shrink-0 rounded-xl border border-[#F5B700]/35 px-6 py-3 text-center text-[14px] font-bold text-[#F5B700] transition-colors hover:bg-[#F5B700]/10">查看 Premium</Link>
        </section>
      </div>
    </main>
  );
}
