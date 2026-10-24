"use client";

// Compare UI built on the existing backend (lib/data-platform/web/compareService.ts +
// app/api/compare/route.ts) -- that backend already supported stocks/ETFs/funds/indices/FX/
// crypto, but had no frontend (see git history on this file for the prior "COMING SOON"
// placeholder and why). This page only lets users pick ETF or FUND (the two product types among
// the four core categories -- see CLAUDE.md "第一條" -- a user can directly browse and compare;
// STOCK/INDEX/FX are market data the platform uses internally, not products sold here).
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";

type PickerAssetType = "ETF" | "FUND";
type PickerResult = { assetType: PickerAssetType; canonicalId: string; symbolOrCode: string | null; displayName: string; currency: string | null };
type SelectedItem = { assetType: PickerAssetType; canonicalEntityId: string; label: string; symbol: string | null };

const PERIODS = ["1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "MAX"] as const;
type Period = (typeof PERIODS)[number];

const ISO_CURRENCY_ZH: Record<string, string> = { TWD: "新台幣", USD: "美元", EUR: "歐元", JPY: "日圓", GBP: "英鎊", HKD: "港幣", CNY: "人民幣", AUD: "澳幣", CAD: "加幣", CHF: "瑞士法郎", SGD: "新加坡幣" };
const currencyZh = (currency: string | null | undefined) => (currency ? ISO_CURRENCY_ZH[currency] ?? currency : "—");
const pct = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${(value * 100).toFixed(2)}%`);
const CHART_COLORS = ["#F5B700", "#4DA3FF", "#7CE38B", "#FF7A7A", "#C792EA", "#5EEAD4", "#F0ABFC", "#FDBA74", "#A3E635", "#93C5FD"];

type CompareMetrics = { cumulativeReturn: { value: number | null }; annualizedReturn: { value: number | null }; volatility: { value: number | null }; maxDrawdown: { value: number | null } };
type CompareItemData = { identity: { assetType: PickerAssetType; canonicalEntityId: string; symbolOrCode: string; name: string; currency: string | null }; currentValue: number | null; currency: string | null; metrics: CompareMetrics; normalizedGrowth: { date: string; value: number }[]; coverageStatus: string };
type CompareApiItem = { status: "AVAILABLE"; data: CompareItemData } | { status: string; request: { assetType: string; canonicalEntityId: string }; error: { message: string } };
type CompareApiResponse = { data: CompareApiItem[]; meta: { partial: boolean; period: string }; error: { message: string } | null };

export default function ComparePage() {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<PickerResult[]>([]);
  const [selected, setSelected] = useState<SelectedItem[]>([]);
  const [period, setPeriod] = useState<Period>("1Y");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<CompareApiResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  const runSearch = useCallback(async (value: string) => {
    setQuery(value);
    if (!value.trim()) { setResults([]); return; }
    setSearching(true);
    try {
      const [etfRes, fundRes] = await Promise.all([
        fetch(`/api/search?q=${encodeURIComponent(value)}&type=ETF&limit=8`).then((r) => (r.ok ? r.json() : { data: [] })),
        fetch(`/api/search?q=${encodeURIComponent(value)}&type=FUND&limit=8`).then((r) => (r.ok ? r.json() : { data: [] })),
      ]);
      type RawRow = { assetType: PickerAssetType; canonicalId: string; symbolOrCode: string | null; displayName: string; currency: string | null };
      const rows: RawRow[] = [...(etfRes.data ?? []), ...(fundRes.data ?? [])];
      setResults(rows.map((row) => ({ assetType: row.assetType, canonicalId: row.canonicalId, symbolOrCode: row.symbolOrCode, displayName: row.displayName, currency: row.currency })));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const addItem = (row: PickerResult) => {
    if (selected.length >= 10) return;
    if (selected.some((item) => item.assetType === row.assetType && item.canonicalEntityId === row.canonicalId)) return;
    setSelected((prev) => [...prev, { assetType: row.assetType, canonicalEntityId: row.canonicalId, label: row.displayName, symbol: row.symbolOrCode }]);
    setQuery("");
    setResults([]);
  };
  const removeItem = (item: SelectedItem) => setSelected((prev) => prev.filter((candidate) => !(candidate.assetType === item.assetType && candidate.canonicalEntityId === item.canonicalEntityId)));

  const runCompare = useCallback(async () => {
    setRequestError(null);
    if (selected.length < 2) { setRequestError("請至少選擇 2 檔商品才能比較。"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: selected.map(({ assetType, canonicalEntityId }) => ({ assetType, canonicalEntityId })), period, alignmentPolicy: "EXACT_INTERSECTION", normalizationPolicy: "NATIVE_NOT_NORMALIZED" }),
      });
      const body = (await res.json()) as CompareApiResponse;
      if (!res.ok) { setRequestError(body.error?.message ?? "比較失敗，請稍後再試。"); setResponse(null); return; }
      setResponse(body);
    } catch {
      setRequestError("比較服務暫時無法使用，請稍後再試。");
    } finally {
      setLoading(false);
    }
  }, [selected, period]);

  const availableItems = useMemo(() => (response?.data.filter((item): item is CompareApiItem & { status: "AVAILABLE"; data: CompareItemData } => item.status === "AVAILABLE") ?? []), [response]);
  const chartPath = useMemo(() => buildChartPaths(availableItems.map((item) => item.data.normalizedGrowth)), [availableItems]);

  return (
    <main className="min-h-screen bg-[#07111f] text-white">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#040a18]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-[1600px] items-center justify-between px-4 sm:px-10">
          <Link href="/"><div className="text-[28px] font-black leading-none sm:text-[32px]">Smart<span className="text-[#F5B700]">Match</span></div></Link>
          <nav className="hidden gap-7 text-sm font-semibold text-slate-300 lg:flex">
            <Link href="/markets" className="hover:text-white">市場總覽</Link>
            <Link href="/etf" className="hover:text-white">ETF</Link>
            <Link href="/funds" className="hover:text-white">基金</Link>
            <Link href="/compare" className="text-white">比較</Link>
            <Link href="/rankings" className="hover:text-white">排行榜</Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-[1200px] px-4 pb-24 pt-32 sm:px-8">
        <div className="text-xs font-semibold tracking-[0.3em] text-[#F5B700]">比較中心</div>
        <h1 className="mt-3 text-[32px] font-black tracking-[-0.02em] md:text-[40px]">比較 ETF 與基金</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-slate-400">搜尋並選擇 2 到 10 檔 ETF 或基金，比較累積報酬、年化報酬、波動度與最大回檔。</p>

        <section className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.03] p-5">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => runSearch(e.target.value)}
              placeholder="搜尋 ETF 或基金名稱、代碼"
              className="h-14 w-full rounded-xl border border-white/[0.16] bg-white/[0.97] px-4 text-[15px] font-medium text-slate-900 outline-none placeholder:text-slate-500 focus:border-[#F5B700]/70"
            />
            {query && (
              <div className="absolute z-10 mt-2 max-h-80 w-full overflow-y-auto rounded-xl border border-white/10 bg-[#0B1B34] shadow-2xl">
                {searching ? (
                  <div className="px-4 py-3 text-sm text-slate-400">搜尋中…</div>
                ) : results.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-slate-500">找不到符合的 ETF 或基金</div>
                ) : (
                  results.map((row) => (
                    <button key={`${row.assetType}:${row.canonicalId}`} onClick={() => addItem(row)} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-white/[0.06]">
                      <span className="font-semibold text-white">{row.displayName}</span>
                      <span className="ml-3 flex items-center gap-2 text-xs text-slate-400">
                        <span className="rounded-full border border-[#F5B700]/20 bg-[#F5B700]/[0.07] px-2 py-0.5 font-bold text-[#F5B700]">{row.assetType === "ETF" ? "ETF" : "基金"}</span>
                        {row.symbolOrCode ?? "—"}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {selected.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {selected.map((item, index) => (
                <span key={`${item.assetType}:${item.canonicalEntityId}`} className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-semibold" style={{ borderColor: `${CHART_COLORS[index % CHART_COLORS.length]}55`, color: CHART_COLORS[index % CHART_COLORS.length] }}>
                  {item.label}
                  <button onClick={() => removeItem(item)} className="text-slate-400 hover:text-white">✕</button>
                </span>
              ))}
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap gap-1.5">
              {PERIODS.map((p) => (
                <button key={p} onClick={() => setPeriod(p)} className={`rounded-lg px-3 py-1.5 text-[13px] font-bold ${period === p ? "bg-[#F5B700] text-[#0B1B34]" : "bg-white/[0.06] text-slate-300 hover:bg-white/[0.1]"}`}>{p}</button>
              ))}
            </div>
            <button onClick={runCompare} disabled={loading || selected.length < 2} className="rounded-xl bg-[#F5B700] px-6 py-3 text-sm font-bold text-[#0B1B34] disabled:opacity-40">
              {loading ? "比較中…" : `開始比較（${selected.length}）`}
            </button>
          </div>
          {requestError && <div className="mt-3 text-sm text-red-400">{requestError}</div>}
        </section>

        {response && availableItems.length > 0 && (
          <section className="mt-8 space-y-6">
            <div className="rounded-2xl border border-white/[0.09] bg-white/[0.03] p-5">
              <div className="mb-4 flex items-center justify-between text-xs text-slate-500">
                <span>績效走勢（起始日 = 100）</span>
                {response.meta.partial && <span className="text-amber-300">部分商品資料不足，僅顯示可用結果</span>}
              </div>
              <svg viewBox="0 0 800 320" className="w-full">
                {chartPath.gridLines.map((y, i) => <line key={i} x1={40} x2={780} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" />)}
                {chartPath.paths.map((d, i) => <path key={i} d={d} fill="none" stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2} />)}
              </svg>
              <div className="mt-3 flex flex-wrap gap-4 text-[12px] text-slate-400">
                {availableItems.map((item, i) => (
                  <span key={i} className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />{item.data.identity.name}</span>
                ))}
              </div>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-white/[0.09] bg-white/[0.03]">
              <table className="w-full min-w-[720px] text-left text-[14px]">
                <thead className="border-b border-white/[0.08] text-slate-400">
                  <tr><th className="px-5 py-4">商品</th><th className="px-5 py-4">幣別</th><th className="px-5 py-4 text-right">累積報酬</th><th className="px-5 py-4 text-right">年化報酬</th><th className="px-5 py-4 text-right">波動度</th><th className="px-5 py-4 text-right">最大回檔</th></tr>
                </thead>
                <tbody>
                  {availableItems.map((item, i) => (
                    <tr key={i} className="border-t border-white/[0.05]">
                      <td className="px-5 py-4 font-bold text-white">{item.data.identity.name}<span className="ml-2 font-mono text-xs text-[#F5B700]">{item.data.identity.symbolOrCode}</span></td>
                      <td className="px-5 py-4 text-slate-300">{currencyZh(item.data.currency)}</td>
                      <td className="px-5 py-4 text-right">{pct(item.data.metrics.cumulativeReturn.value)}</td>
                      <td className="px-5 py-4 text-right">{pct(item.data.metrics.annualizedReturn.value)}</td>
                      <td className="px-5 py-4 text-right">{pct(item.data.metrics.volatility.value)}</td>
                      <td className="px-5 py-4 text-right text-red-300">{pct(item.data.metrics.maxDrawdown.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function buildChartPaths(series: { date: string; value: number }[][]) {
  const flat = series.flat();
  if (flat.length === 0) return { paths: [], gridLines: [60, 140, 220, 300] };
  const minV = Math.min(...flat.map((p) => p.value));
  const maxV = Math.max(...flat.map((p) => p.value));
  const range = maxV - minV || 1;
  const width = 740, height = 280, left = 40, top = 20;
  const paths = series.map((points) => {
    if (points.length === 0) return "";
    return points.map((point, i) => {
      const x = left + (i / Math.max(points.length - 1, 1)) * width;
      const y = top + height - ((point.value - minV) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  });
  return { paths, gridLines: [top, top + height / 3, top + (2 * height) / 3, top + height] };
}
