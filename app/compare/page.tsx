"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { CompareAssetType, CompareItemResult } from "@/lib/data-platform/web/compareService";
import type { SearchType, UnifiedSearchResult } from "@/lib/data-platform/web/searchService";

type SelectedItem = Pick<UnifiedSearchResult, "assetType" | "canonicalId" | "symbolOrCode" | "displayName" | "currency">;
type CompareResponse = { data: CompareItemResult[]; meta: { crossCurrency: boolean; currencyHandling: string; datesAligned: boolean; partial: boolean } };

const METRICS = [
  ["CURRENT_VALUE", "目前數值"], ["PERFORMANCE_1M", "1M 報酬"], ["PERFORMANCE_3M", "3M 報酬"], ["PERFORMANCE_1Y", "1Y 報酬"],
  ["VOLATILITY_1Y", "1Y 波動度"], ["MAX_DRAWDOWN_1Y", "最大回撤"], ["RISK_RATING", "風險評級"], ["AUM", "資產規模 AUM"], ["FEE", "費用"], ["CATEGORY", "資產類別"],
] as const;

const formatMetric = (item: CompareItemResult, code: string) => {
  const metric = item.data?.metrics.find((value) => value.metricCode === code);
  if (!metric?.available || metric.value === null) return <span className="text-slate-600">—</span>;
  const value = typeof metric.value === "number" ? metric.value.toLocaleString("en-US", { maximumFractionDigits: 4 }) : metric.value;
  return <><div className="font-semibold text-slate-200">{value}{metric.unit === "%" ? "%" : ""}</div><div className="mt-1 text-[9px] text-slate-600">{metric.semantics}</div></>;
};

export default function ComparePage() {
  const [selected, setSelected] = useState<SelectedItem[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<SearchType>("ALL");
  const [results, setResults] = useState<UnifiedSearchResult[]>([]);
  const [comparison, setComparison] = useState<CompareResponse | null>(null);
  const itemParam = useMemo(() => selected.map((item) => `${item.assetType}:${item.canonicalId}`).join(","), [selected]);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("items");
    if (!value) return;
    const parsed = value.split(",").flatMap((token) => {
      const separator = token.indexOf(":");
      const assetType = token.slice(0, separator).toUpperCase() as CompareAssetType;
      const canonicalId = token.slice(separator + 1).trim();
      return separator > 0 && (["STOCK", "ETF", "FUND"] as string[]).includes(assetType) && canonicalId
        ? [{ assetType, canonicalId, symbolOrCode: canonicalId, displayName: canonicalId, currency: null }]
        : [];
    }).slice(0, 4);
    if (parsed.length >= 2) setSelected(parsed);
  }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => fetch(`/api/search?q=${encodeURIComponent(query)}&type=ALL&limit=20`, { signal: controller.signal }).then((response) => response.ok ? response.json() : Promise.reject()).then((payload) => { const rows = ((payload.data ?? []) as UnifiedSearchResult[]).filter((row) => row.publicReady); const exact = query.trim().toUpperCase(); setResults(type === "ALL" ? rows : rows.filter((row) => row.symbolOrCode?.toUpperCase() === exact || row.assetType === type)); }).catch(() => undefined), 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, type]);

  useEffect(() => {
    if (selected.length < 2) { setComparison(null); return; }
    const controller = new AbortController();
    fetch(`/api/compare?items=${encodeURIComponent(itemParam)}`, { signal: controller.signal }).then((response) => response.ok ? response.json() : Promise.reject()).then((payload: CompareResponse) => {
      setComparison(payload);
      setSelected((items) => items.map((item, index) => {
        const identity = payload.data[index]?.data?.identity;
        return identity ? { assetType: identity.assetType, canonicalId: identity.canonicalId, symbolOrCode: identity.symbolOrCode, displayName: identity.displayName, currency: identity.currency } : item;
      }));
    }).catch(() => setComparison(null));
    window.history.replaceState(null, "", `/compare?items=${encodeURIComponent(itemParam)}`);
    return () => controller.abort();
  }, [itemParam, selected.length]);

  const addItem = (result: UnifiedSearchResult) => {
    if (!(["STOCK", "ETF", "FUND"] as string[]).includes(result.assetType) || selected.length >= 4 || selected.some((item) => item.assetType === result.assetType && item.canonicalId === result.canonicalId)) return;
    setSelected((items) => [...items, result as SelectedItem]); setPickerOpen(false); setQuery(""); setResults([]);
  };

  return (
    <main className="min-h-screen bg-[#07111f] text-white">
      <header className="fixed left-0 top-0 z-50 w-full border-b border-white/[0.08] bg-[#040a18]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-[1600px] items-center justify-between px-6 sm:px-10">
          <Link href="/"><div className="text-[28px] font-black leading-none sm:text-[32px]">Smart<span className="text-[#F5B700]">Match</span></div><div className="mt-0.5 text-[11px] text-slate-400">全球投資研究平台</div></Link>
          <nav className="hidden items-center gap-6 text-[15px] font-semibold text-slate-300 lg:flex"><Link href="/markets">市場總覽</Link><Link href="/search">投資商品</Link><Link href="/screener">研究工具</Link><Link href="/rankings">排行榜</Link><Link href="/portfolio">投資組合</Link><Link href="/pricing" className="text-[#F5B700]">會員專區</Link></nav>
          <Link href="/search" className="rounded-lg border border-white/20 px-4 py-2 text-sm text-slate-300">搜尋</Link>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-6 pb-20 pt-32 sm:px-8 md:px-10">
        <section className="border-b border-white/[0.08] pb-9"><div className="text-[12px] font-semibold tracking-[0.3em] text-[#F5B700]">全球商品比較</div><h1 className="mt-4 text-[42px] font-black tracking-[-0.03em] md:text-[52px]">全球商品比較</h1><p className="mt-4 text-[17px] leading-8 text-slate-400">以一致且透明的語意，比較股票、ETF 與基金的 正式資料。</p></section>

        <section className="mt-7">
          <div className="flex flex-wrap items-center justify-between gap-4"><div className="text-sm text-slate-400">選擇 2–4 個商品</div><div className="text-[12px] text-slate-600">已選 {selected.length} / 4</div></div>
          <div className="mt-5 overflow-x-auto pb-2"><div className="grid min-w-[780px] grid-cols-4 gap-3">{[0, 1, 2, 3].map((slot) => { const item = selected[slot]; return item ? <article key={`${item.assetType}:${item.canonicalId}`} className="relative min-h-[118px] rounded-2xl border border-[#F5B700]/25 bg-[#F5B700]/[0.05] p-5"><button type="button" aria-label={`移除 ${item.displayName}`} onClick={() => setSelected((items) => items.filter((_, index) => index !== slot))} className="absolute right-3 top-3 text-slate-500 hover:text-white">×</button><div className="text-[10px] font-bold tracking-[0.15em] text-[#F5B700]">{item.assetType}</div><div className="mt-3 truncate font-bold">{item.displayName}</div><div className="mt-1 text-xs text-slate-500">{item.symbolOrCode} · {item.currency ?? "—"}</div></article> : <button key={slot} type="button" onClick={() => setPickerOpen(true)} disabled={selected.length >= 4} className="flex min-h-[118px] flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.13] bg-white/[0.025] text-slate-500 transition-colors hover:border-[#F5B700]/35 hover:text-[#F5B700]"><span className="text-[24px]">＋</span><span className="mt-2 text-[13px] font-semibold">加入比較商品</span><span className="mt-1 text-[10px] text-slate-700">股票 / ETF / 基金</span></button>; })}</div></div>
        </section>

        {pickerOpen && <section className="mt-5 rounded-2xl border border-white/[0.1] bg-[#0b1523] p-5"><div className="flex flex-col gap-3 sm:flex-row"><select value={type} onChange={(event) => setType(event.target.value as SearchType)} className="rounded-xl border border-white/10 bg-[#07111f] px-4 py-3 text-sm"><option value="ALL">全部資產</option><option value="STOCK">股票</option><option value="ETF">ETF</option><option value="FUND">基金</option><option value="INDEX">指數</option><option value="DERIVATIVES">衍生品</option><option value="FIXED_INCOME">固定收益</option><option value="FX">貨幣對</option><option value="MACRO">總體經濟</option><option value="COMMODITY">商品與實體資產</option><option value="CRYPTO">加密資產</option></select><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋名稱、代碼或 ISIN" className="flex-1 rounded-xl border border-white/10 bg-[#07111f] px-4 py-3 text-sm outline-none focus:border-[#F5B700]/50"/><button type="button" onClick={() => setPickerOpen(false)} className="px-4 text-sm text-slate-500">關閉</button></div><div className="mt-3 divide-y divide-white/[0.06]">{results.map((result) => <button key={`${result.assetType}:${result.canonicalId}`} type="button" onClick={() => addItem(result)} className="flex w-full items-center justify-between gap-4 px-3 py-3 text-left hover:bg-white/[0.04]"><span><span className="font-semibold">{result.displayName}</span><span className="ml-2 text-xs text-slate-500">{result.symbolOrCode}</span></span><span className="text-xs text-[#F5B700]">{(["STOCK","ETF","FUND"] as string[]).includes(result.assetType)?"加入比較":`${result.assetType} 商品`}</span></button>)}{query && results.length === 0 && <div className="px-3 py-5 text-sm text-slate-600">未找到符合條件的商品</div>}</div></section>}

        {comparison?.meta.crossCurrency && <div className="mt-6 rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-5 py-3 text-sm text-amber-200">CROSS_CURRENCY_NOT_NORMALIZED：不同幣別數值不換算、不排序。</div>}
        {comparison && !comparison.meta.datesAligned && <div className="mt-3 text-xs text-slate-500">各商品觀察日期不同；每欄保留自身 一致 as-of date。</div>}

        <section className="mt-8 overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.025]"><div className="overflow-x-auto"><table className="w-full min-w-[920px]"><thead><tr className="border-b border-white/[0.08] bg-white/[0.03]"><th className="sticky left-0 z-10 bg-[#0b1523] px-5 py-5 text-left text-[13px] text-slate-500">比較指標</th>{[0, 1, 2, 3].map((slot) => <th key={slot} className="min-w-[180px] px-5 py-5 text-center text-[13px] text-slate-400">{comparison?.data[slot]?.data?.identity.displayName ?? selected[slot]?.displayName ?? `商品 ${slot + 1}`}</th>)}</tr></thead><tbody>{METRICS.map(([code, label]) => <tr key={code} className="border-b border-white/[0.055]"><th className="sticky left-0 z-10 min-w-[175px] bg-[#091321] px-5 py-3.5 text-left text-[13px] font-semibold text-slate-400">{label}</th>{[0, 1, 2, 3].map((slot) => <td key={slot} className="min-w-[180px] px-5 py-3.5 text-center text-[13px]">{comparison?.data[slot] ? formatMetric(comparison.data[slot], code) : <span className="text-slate-700">—</span>}</td>)}</tr>)}</tbody><tbody><tr className="border-b border-white/[0.055]"><th className="sticky left-0 z-10 bg-[#091321] px-5 py-3.5 text-left text-[13px] text-slate-400">資料日期 / 來源</th>{[0,1,2,3].map((slot) => { const identity=comparison?.data[slot]?.data?.identity; return <td key={slot} className="px-5 py-3.5 text-center text-[10px] text-slate-500">{identity ? <>{identity.asOfDate ? new Date(identity.asOfDate).toLocaleDateString("zh-TW") : "—"}<br/>{identity.source ?? "來源未提供"}<br/>{identity.freshnessStatus}</> : "—"}</td>; })}</tr></tbody></table></div></section>

        {selected.length < 2 && <section className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.03] px-6 py-14 text-center"><div className="text-[11px] font-bold tracking-[0.2em] text-[#F5B700]/70">正式比較資料</div><h2 className="mt-4 text-[20px] font-black">請至少加入 2 個商品</h2><p className="mt-3 text-[13px] text-slate-500">比較資料會直接取自 SmartMatch 正式資料服務。</p></section>}
      </div>
    </main>
  );
}
