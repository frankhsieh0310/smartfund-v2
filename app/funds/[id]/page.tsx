import Link from "next/link";
import { notFound } from "next/navigation";
import { getFundDetail, type FundDetailData, type FundDetailRange, type FundSectionCoverage } from "../../../lib/data-platform/web/fundService.ts";
import { WebDataError } from "../../../lib/data-platform/web/errors.ts";
import { prisma } from "../../../lib/prisma.ts";
import { HoldingsTablePanel, ConcentrationPanel, HoldingsDiffPanel, type HoldingsTableApiResponse, type ConcentrationApiResponse, type HoldingsDiffApiResponse } from "../../../components/holdings/HoldingsAnalysisPanels.tsx";
import { computeConcentration } from "../../../lib/holdings/concentration.ts";
import { getFundHoldingsTableAsOf, getFundHoldingsDiffLatestVsPrevious } from "../../../lib/holdings/holdingsQueries.ts";

export const dynamic = "force-dynamic";

// Read-only, additive — a failure here must never affect whether the rest of the page renders.
async function loadFundHoldingsPanels(fundId: string): Promise<{ table: HoldingsTableApiResponse; concentration: ConcentrationApiResponse; diff: HoldingsDiffApiResponse } | null> {
  try {
    const [table, diff] = await Promise.all([
      getFundHoldingsTableAsOf(prisma, fundId),
      getFundHoldingsDiffLatestVsPrevious(prisma, fundId),
    ]);
    if (!table.rows.length) return null;
    const concentration = computeConcentration(table.rows);
    return {
      table: {
        ok: true, productType: "FUND", productId: table.productId, asOfDate: table.asOfDate, source: table.source,
        coverageDepth: table.coverage.coverage_depth, isFullHoldings: table.coverage.is_full_holdings,
        holdingCount: table.coverage.holding_count, incompleteDataWarning: !table.coverage.is_full_holdings,
        rows: table.rows.map((r) => ({ key: r.key, name: r.name, ticker: r.ticker, weightPct: r.weightPct, sector: r.sector ?? null, country: r.country ?? null })),
      },
      concentration: {
        ok: true, productType: "FUND", productId: table.productId, asOfDate: table.asOfDate,
        coverageDepth: table.coverage.coverage_depth, isFullHoldings: table.coverage.is_full_holdings,
        basisNote: table.coverage.is_full_holdings ? "基於完整持股計算" : "依目前可取得持股計算（非完整持股，實際集中度可能不同）",
        top10Pct: concentration.top10Pct, top20Pct: concentration.top20Pct, largestHolding: concentration.largestHolding,
        sectorConcentration: concentration.sectorConcentration, countryConcentration: concentration.countryConcentration,
      },
      diff: {
        ok: true, productType: "FUND", productId: diff.productId, hasEnoughHistory: diff.hasEnoughHistory,
        previousDate: diff.previousDate, latestDate: diff.latestDate,
        added: diff.entries.filter((e) => e.change === "ADDED"),
        increased: diff.entries.filter((e) => e.change === "INCREASED"),
        decreased: diff.entries.filter((e) => e.change === "DECREASED"),
        removed: diff.entries.filter((e) => e.change === "REMOVED"),
      },
    };
  } catch {
    return null;
  }
}

const ranges: FundDetailRange[] = ["1M", "3M", "6M", "1Y", "3Y", "5Y", "MAX"];
const date = (value: string | null) => value ? new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium" }).format(new Date(value)) : "—";
const number = (value: number | null, digits = 2) => value === null ? "—" : new Intl.NumberFormat("zh-TW", { maximumFractionDigits: digits }).format(value);
const percent = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${number(value, 2)}%`;
const text = (value: string | null | undefined) => value?.trim() || "未提供";

export default async function FundDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ range?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const range = ranges.includes((query.range ?? "1Y").toUpperCase() as FundDetailRange) ? (query.range ?? "1Y").toUpperCase() as FundDetailRange : "1Y";
  let response;
  try { response = await getFundDetail(id, 20, range); }
  catch (error) {
    if (error instanceof WebDataError && error.code === "NOT_FOUND") notFound();
    return <ErrorState />;
  }
  const fund = response.data;
  if (!fund) return <ErrorState />;
  const history = fund.history.data;
  const panels = await loadFundHoldingsPanels(fund.identity.id);
  return <main className="min-h-screen overflow-x-hidden bg-[#040a18] pb-20 text-slate-200 [&_section]:min-w-0">
    <Header />
    <div className="mx-auto max-w-[1500px] px-4 pt-28 sm:px-8">
      <Link href="/funds" className="text-xs font-semibold text-slate-500 hover:text-white">← 返回基金列表</Link>
      <section className="mt-5 border-b border-white/[0.08] pb-8">
        <div className="flex flex-wrap items-start justify-between gap-6"><div className="max-w-4xl"><p className="font-mono text-xs text-[#F5B700]">{text(fund.identity.code)}{fund.identity.isin ? ` · ISIN ${fund.identity.isin}` : ""}</p><h1 className="mt-3 text-3xl font-black tracking-tight text-white sm:text-5xl">{fund.identity.name}</h1><p className="mt-4 text-sm text-slate-400">{text(fund.company)} · {text(fund.assetClass)} · {text(fund.category)}</p></div><Coverage value={response.meta.coverageStatus} /></div>
      </section>
      <section className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Summary label="最新 NAV" value={`${number(fund.nav.data.value, 4)} ${fund.nav.data.currency ?? ""}`} note={date(fund.nav.data.date)} />
        <Summary label="1Y NAV 報酬" value={percent(fund.performance.data.return1Y)} note="以 NAV 計算" />
        <Summary label="風險等級" value={fund.riskRating === null ? "—" : `等級 ${fund.riskRating}`} note="來源未提供時不推估" />
        <Summary label="資料狀態" value={response.meta.freshnessStatus} note={`更新 ${date(response.meta.lastUpdated)}`} />
      </section>
      <section className="mt-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <Panel title="NAV 走勢" section={fund.history} footer><div className="mb-5 flex gap-2 overflow-x-auto pb-1">{ranges.map((item) => <Link key={item} href={`?range=${item}`} className={`shrink-0 rounded-full border px-3 py-1.5 text-xs ${range === item ? "border-[#F5B700]/70 bg-[#F5B700]/10 text-[#F5B700]" : "border-white/10 text-slate-500"}`}>{item}</Link>)}</div>{history.length > 1 ? <NavChart points={history} /> : <Empty title="尚無足夠 NAV 歷史資料" detail="不會以假數值繪製走勢。" />}</Panel>
        <Panel title="期間績效" section={fund.performance} footer><div className="grid grid-cols-2 gap-3">{[["1M", fund.performance.data.return1M], ["3M", fund.performance.data.return3M], ["6M", fund.performance.data.return6M], ["YTD", fund.performance.data.returnYtd], ["1Y", fund.performance.data.return1Y], ["3Y 年化", fund.performance.data.return3YAnnualized], ["5Y 年化", fund.performance.data.return5YAnnualized]].map(([label, value]) => <Metric key={label as string} label={`${label} NAV Return`} value={percent(value as number | null)} />)}</div></Panel>
      </section>
      <section className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel title="風險指標" section={fund.riskMetrics} footer>{fund.riskMetrics.data.length ? <div className="grid gap-3 sm:grid-cols-2">{fund.riskMetrics.data.map((item) => <Metric key={`${item.metricCode}-${item.period}`} label={`${item.metricCode} · ${item.period}`} value={number(item.value, 4)} detail={`${date(item.asOfDate)} · n=${item.observationCount} · ${item.calculationMethod}`} />)}</div> : <Empty title="尚無風險指標" />}</Panel>
        <Panel title="Share Classes" section={fund.shareClasses} footer>{fund.shareClasses.data.length ? <div className="space-y-3">{fund.shareClasses.data.map((item) => <div key={item.id} className="rounded-xl border border-white/[0.07] p-4"><div className="font-semibold text-white">{item.name}</div><div className="mt-2 text-xs leading-6 text-slate-500">{text(item.isin ?? item.code)} · {text(item.currency)} · {text(item.accumulationDistribution ?? item.distributionType)} · {item.hedged === null ? "避險未提供" : item.hedged ? `避險 ${text(item.hedgedCurrency)}` : "未避險"}</div></div>)}</div> : <Empty title="尚無 share class 資料" />}</Panel>
      </section>
      <Panel title="費用與條款" section={fund.feesTerms} footer className="mt-6">{fund.feesTerms.data.length ? <div className="overflow-x-auto"><table className="min-w-[950px] w-full text-left text-xs"><thead className="text-slate-500"><tr>{["Share Class", "管理費", "持續費用", "TER", "前收", "後收", "績效費", "最低投資", "配息頻率", "避險"].map((h) => <th key={h} className="px-3 py-3">{h}</th>)}</tr></thead><tbody>{fund.feesTerms.data.map((item) => <tr key={item.shareClass} className="border-t border-white/[0.06]"><td className="px-3 py-3 text-white">{item.shareClass}</td>{[item.managementFee, item.ongoingCharges, item.ter, item.salesChargeFront, item.salesChargeBack, item.performanceFee].map((value, index) => <td key={index} className="px-3 py-3">{percent(value)}</td>)}<td className="px-3 py-3">{number(item.minimumInitialInvestment)}</td><td className="px-3 py-3">{text(item.distributionFrequency)}</td><td className="px-3 py-3">{text(item.hedgingTerms)}</td></tr>)}</tbody></table></div> : <Empty title="尚無費用與條款" />}</Panel>
      <section className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel title="分類與 Benchmark" section={fund.classifications} footer>{fund.classifications.data.length ? <div className="space-y-3">{fund.classifications.data.map((item) => <div key={`${item.type}-${item.name}`} className="rounded-xl border border-white/[0.07] p-4"><div className="flex justify-between gap-4"><span className="text-slate-500">{item.type}</span><span className="text-right text-white">{item.value ?? item.name}</span></div>{item.benchmarkName && <p className="mt-2 text-xs text-slate-500">Benchmark：{item.benchmarkName}{item.benchmarkCode ? ` (${item.benchmarkCode})` : ""} · 僅識別資訊</p>}</div>)}</div> : <Empty title="尚無分類資料" />}</Panel>
        <Panel title="官方文件" section={fund.documents} footer>{fund.documents.data.length ? <div className="space-y-3">{fund.documents.data.map((item) => <a key={`${item.type}-${item.url}`} href={item.url} target="_blank" rel="noreferrer" className="block rounded-xl border border-white/[0.07] p-4 hover:border-white/20"><div className="font-semibold text-white">{item.title ?? item.type}</div><div className="mt-2 text-xs text-slate-500">{item.type} · {date(item.date)} · {text(item.language)}</div></a>)}</div> : <Empty title="尚無可驗證官方文件" />}</Panel>
      </section>
      <Panel title="最新持倉" section={fund.holdings} footer className="mt-6"><p className="mb-4 text-xs text-slate-500">報告日：{date(fund.holdings.data.reportDate)}</p>{fund.holdings.data.items.length ? <div className="overflow-x-auto"><table className="min-w-[760px] w-full text-left text-xs"><thead className="text-slate-500"><tr><th className="px-3 py-3">持倉</th><th className="px-3 py-3">Security ID</th><th className="px-3 py-3 text-right">權重</th><th className="px-3 py-3 text-right">市值</th><th className="px-3 py-3">幣別</th></tr></thead><tbody>{fund.holdings.data.items.map((item, index) => <tr key={`${item.securityId}-${index}`} className="border-t border-white/[0.06]"><td className="px-3 py-3 text-white">{text(item.holdingName)}</td><td className="px-3 py-3 font-mono text-slate-500">{text(item.securityId)}</td><td className="px-3 py-3 text-right">{percent(item.weight)}</td><td className="px-3 py-3 text-right">{number(item.marketValue)}</td><td className="px-3 py-3">{text(item.currency)}</td></tr>)}</tbody></table></div> : <Empty title="尚無 holdings 資料" />}</Panel>
      <Panel title="Fund Flows" section={fund.flows} footer className="mt-6"><Empty title="來源準備中" detail="SOURCE_PENDING；目前不以零值或推估值呈現。" /></Panel>
      {panels && (
        <>
          <HoldingsTablePanel data={panels.table} />
          <ConcentrationPanel data={panels.concentration} />
          <HoldingsDiffPanel data={panels.diff} />
        </>
      )}
    </div>
  </main>;
}

function Header() { return <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#040a18]/90 backdrop-blur-xl"><div className="mx-auto flex h-20 max-w-[1700px] items-center justify-between px-4 sm:px-10"><Link href="/" className="text-[26px] font-black text-white">Smart<span className="text-[#F5B700]">Fund</span></Link><nav className="hidden gap-7 text-sm font-semibold text-slate-300 lg:flex"><Link href="/">市場總覽</Link><Link href="/etf">ETF</Link><Link href="/funds" className="text-[#F5B700]">基金</Link><Link href="/compare">商品比較</Link><Link href="/rankings">排行榜</Link></nav><Link href="/search" className="rounded-lg border border-white/20 px-4 py-2 text-sm">搜尋</Link></div></header>; }
function Panel<T>({ title, section, children, footer, className = "" }: { title: string; section: { coverage: FundSectionCoverage; provenance: { source: string | null; asOfDate: string | null; lastUpdated: string | null; provenanceStatus: string } }; children: React.ReactNode; footer?: boolean; className?: string }) { return <section className={`rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5 sm:p-6 ${className}`}><div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-lg font-bold text-white">{title}</h2><Coverage value={section.coverage} /></div>{children}{footer && <div className="mt-6 border-t border-white/[0.06] pt-4 text-[10px] leading-5 text-slate-600">Source: {text(section.provenance.source)} · As of: {date(section.provenance.asOfDate)} · Updated: {date(section.provenance.lastUpdated)} · Provenance: {section.provenance.provenanceStatus}</div>}</section>; }
function Coverage({ value }: { value: string }) { const active = value === "AVAILABLE" || value === "CURRENT" || value === "PARTIAL_CURRENT"; return <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold tracking-wide ${active ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400" : "border-amber-500/25 bg-amber-500/10 text-amber-300"}`}>{value}</span>; }
function Summary({ label, value, note }: { label: string; value: string; note: string }) { return <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5"><p className="text-xs text-slate-500">{label}</p><p className="mt-3 break-words text-xl font-bold text-white">{value}</p><p className="mt-2 text-[10px] text-slate-600">{note}</p></div>; }
function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) { return <div className="rounded-xl border border-white/[0.07] p-4"><p className="text-xs text-slate-500">{label}</p><p className="mt-2 text-lg font-bold text-white">{value}</p>{detail && <p className="mt-2 text-[10px] leading-4 text-slate-600">{detail}</p>}</div>; }
function Empty({ title, detail }: { title: string; detail?: string }) { return <div className="flex min-h-32 items-center justify-center rounded-xl border border-dashed border-white/10 p-6 text-center"><div><p className="text-sm font-semibold text-slate-400">{title}</p>{detail && <p className="mt-2 text-xs text-slate-600">{detail}</p>}</div></div>; }
function ErrorState() { return <main className="flex min-h-screen items-center justify-center bg-[#040a18] px-6 text-center text-white"><div><h1 className="text-3xl font-black">基金資料暫時無法載入</h1><p className="mt-3 text-sm text-slate-400">請稍後再試，或返回基金列表。</p><Link href="/funds" className="mt-7 inline-flex rounded-lg border border-white/15 px-5 py-2.5 text-sm">返回基金列表</Link></div></main>; }
function NavChart({ points }: { points: FundDetailData["history"]["data"] }) { const values = points.flatMap((point) => point.nav === null ? [] : [point.nav]); if (values.length < 2) return <Empty title="尚無足夠 NAV 歷史資料" />; const min = Math.min(...values), max = Math.max(...values), span = max - min || 1; const coords = points.flatMap((point, index) => point.nav === null ? [] : [`${(index / Math.max(points.length - 1, 1)) * 100},${94 - ((point.nav - min) / span) * 82}`]).join(" "); return <div><svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-64 w-full" role="img" aria-label="基金 NAV 走勢"><defs><linearGradient id="nav-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#F5B700" stopOpacity=".22"/><stop offset="1" stopColor="#F5B700" stopOpacity="0"/></linearGradient></defs><polygon points={`0,100 ${coords} 100,100`} fill="url(#nav-area)"/><polyline points={coords} fill="none" stroke="#F5B700" strokeWidth="1.5" vectorEffect="non-scaling-stroke"/></svg><div className="mt-2 flex justify-between text-[10px] text-slate-600"><span>{date(points[0]?.date ?? null)}</span><span>{date(points.at(-1)?.date ?? null)}</span></div></div>; }
