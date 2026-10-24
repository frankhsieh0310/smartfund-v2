import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";

// Bond detail page -- one of the "六類詳情頁" (2026-10-24 scope: the four core-universe product
// categories split out individually, plus 股票/債券). Bonds are not a product sold on this
// platform (see CLAUDE.md "第一條": they're market data the four core categories need, e.g. for
// bond-ETF holdings lookthrough), so this reads the same market_master/market_data tables as the
// existing indices detail page (app/indices/[symbol]/page.tsx), not a purchasable-product table --
// there is no tw_purchasable_classification row for BOND and none is expected.
const periods = { "1M": 31, "3M": 93, "6M": 186, "YTD": 365, "1Y": 366, "3Y": 1096, "5Y": 1827, MAX: null } as const;
type Period = keyof typeof periods;
const fmt = (v: number | null, d = 2) => (v == null ? "—" : new Intl.NumberFormat("zh-TW", { maximumFractionDigits: d }).format(v));

type Row = { date: Date; close: number; source: string | null };

export default async function BondDetailPage({ params, searchParams }: { params: Promise<{ symbol: string }>; searchParams: Promise<{ period?: string }> }) {
  const { symbol } = await params;
  const { period: raw } = await searchParams;
  const period = (raw && raw in periods ? raw : "1Y") as Period;
  const decoded = decodeURIComponent(symbol);
  const days = periods[period];
  const since = days ? new Date(Date.now() - days * 86400000) : undefined;

  // Two independent bond-yield sources feed this one page: market_master/market_data (US Treasury
  // daily par yield curve, symbols like US10Y) and economic_series/economic_values (FRED series
  // like DGS10 -- the one actually linked from app/markets/page.tsx's "公債殖利率" tab via
  // lib/data-platform/web/homeMarketService.ts's economicCards()). Try marketMaster first, fall
  // back to economicSeries, rather than forcing both callers to know which table their symbol
  // lives in.
  const master = await prisma.marketMaster.findFirst({ where: { symbol: decoded, assetType: "BOND", isActive: true } });
  let name = master?.nameZh ?? master?.name ?? null;
  let currency = master?.currency ?? null;
  let unit: string | null = null;
  let source: string | null = master?.provider ?? null;
  let history: Row[] = [];

  if (master) {
    const rows = await prisma.marketData.findMany({ where: { symbol: master.symbol, type: "BOND", ...(since ? { date: { gte: since } } : {}) }, orderBy: { date: "asc" }, take: 5000 });
    history = rows.map((row) => ({ date: row.date, close: Number(row.close), source: row.source }));
  } else {
    const series = await prisma.economicSeries.findFirst({ where: { seriesId: decoded, enabled: true } });
    if (!series) notFound();
    name = series.name;
    unit = series.unit;
    source = series.provider || series.source;
    const rows = await prisma.economicValue.findMany({ where: { seriesId: series.id, ...(since ? { date: { gte: since } } : {}) }, orderBy: { date: "asc" }, take: 5000 });
    history = rows.filter((row) => row.value !== null).map((row) => ({ date: row.date, close: Number(row.value), source: null }));
  }
  if (!master && history.length === 0 && name === null) notFound();

  const values = history.map((row) => row.close);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const span = max - min || 1;
  const points = history.map((row, i) => `${history.length < 2 ? 0 : (i / (history.length - 1)) * 1000},${260 - ((Number(row.close) - min) / span) * 230}`).join(" ");
  const last = values.at(-1) ?? null;
  const first = values[0] ?? null;
  const periodChangePts = last != null && first != null ? last - first : null;
  const latestRow = history.at(-1);

  return (
    <main className="min-h-screen bg-[#071321] text-[#f7f3e8]">
      <header className="border-b border-white/10 bg-[#06111e]">
        <div className="mx-auto flex h-20 max-w-[1400px] items-center justify-between px-8">
          <Link href="/" className="text-[28px] font-black">Smart<span className="text-[#f5b700]">Match</span></Link>
          <Link href="/markets" className="text-[15px] text-slate-300">返回市場總覽</Link>
        </div>
      </header>
      <div className="mx-auto max-w-[1320px] px-8 py-10">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="text-[14px] font-bold text-[#f5b700]">公債殖利率{currency ? ` · ${currency === "USD" ? "美元" : currency}` : ""}</div>
            <h1 className="mt-2 text-[42px] font-black">{name}</h1>
            <div className="mt-2 font-mono text-[16px] text-slate-400">{decoded}</div>
          </div>
          <div className="text-right">
            <div className="text-[42px] font-black">{fmt(last)}{unit ?? "%"}</div>
            <div className={`mt-1 text-[17px] ${(periodChangePts ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
              {periodChangePts != null ? `${periodChangePts > 0 ? "+" : ""}${fmt(periodChangePts)} 百分點（${period}）` : "—"}
            </div>
            <div className="mt-2 text-[14px] text-slate-400">資料日期：{latestRow?.date.toISOString().slice(0, 10) ?? master?.latestDate?.toISOString().slice(0, 10) ?? "—"}</div>
          </div>
        </div>

        <section className="mt-8 rounded-2xl border border-white/10 bg-[#0b1b2d] p-6">
          <div className="flex flex-wrap gap-2">
            {Object.keys(periods).map((p) => (
              <Link key={p} href={`/bonds/${encodeURIComponent(decoded)}?period=${p}`} className={`rounded-lg px-4 py-2 text-[14px] font-bold ${period === p ? "bg-[#f5b700] text-[#071321]" : "bg-white/[0.05] text-slate-300"}`}>{p}</Link>
            ))}
          </div>
          {history.length < 2 ? (
            <div className="mt-6 py-16 text-center text-slate-400">這段期間資料不足，無法繪製走勢圖。</div>
          ) : (
            <svg viewBox="0 0 1000 280" className="mt-6 h-[340px] w-full" role="img" aria-label={`${name} 殖利率走勢`}>
              <defs><linearGradient id="bondArea" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#38a9e8" stopOpacity=".32" /><stop offset="1" stopColor="#38a9e8" stopOpacity="0" /></linearGradient></defs>
              <path d={`M0 280 L${points.replaceAll(" ", " L")} L1000 280 Z`} fill="url(#bondArea)" />
              <polyline points={points} fill="none" stroke="#55b9ef" strokeWidth="3" />
            </svg>
          )}
          <div className="mt-4 grid gap-4 border-t border-white/10 pt-5 sm:grid-cols-3">
            <Metric label="目前殖利率" value={`${fmt(last)}%`} />
            <Metric label={`${period} 變動`} value={periodChangePts == null ? "—" : `${periodChangePts > 0 ? "+" : ""}${fmt(periodChangePts)} 百分點`} />
            <Metric label="歷史資料筆數" value={`${history.length.toLocaleString("zh-TW")} 筆`} />
          </div>
        </section>
        <div className="mt-5 text-[14px] text-slate-400">
          資料來源：{source ?? "—"} · 非購買標的，僅供債券 ETF／基金持股穿透參考。
        </div>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[12px] text-slate-500">{label}</div><div className="mt-1 text-[20px] font-bold">{value}</div></div>;
}
