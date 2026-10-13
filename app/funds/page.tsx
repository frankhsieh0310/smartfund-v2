import Link from "next/link";

import { getFundFilterOptions, getFundList, type FundListQuery } from "@/lib/data-platform/web/fundService";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const positiveInt = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const display = (value: string | null | undefined, fallback = "資料未提供") => value?.trim() || fallback;
const dateLabel = (value: string | null) => value ? new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value)) : "—";
const numberLabel = (value: number | null, digits = 2) => value === null ? "—" : new Intl.NumberFormat("zh-TW", { maximumFractionDigits: digits }).format(value);
const percentLabel = (value: number | null) => value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

const asHref = (current: URLSearchParams, changes: Record<string, string | number | null>) => {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") next.delete(key);
    else next.set(key, String(value));
  }
  return `/funds${next.size ? `?${next.toString()}` : ""}`;
};

export default async function FundsPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const query = first(raw.q)?.trim() || undefined;
  const company = first(raw.company)?.trim() || undefined;
  const currency = first(raw.currency)?.trim() || undefined;
  const category = first(raw.category)?.trim() || undefined;
  const risk = positiveInt(first(raw.risk), 0) || undefined;
  const page = positiveInt(first(raw.page), 1);
  const requestedSize = positiveInt(first(raw.pageSize), 50);
  const pageSize = Math.min(requestedSize, 200);
  const sortValue = first(raw.sort);
  const sort: FundListQuery["sort"] = sortValue === "latestNavDate" || sortValue === "performance1Y" ? sortValue : "name";
  const direction: FundListQuery["direction"] = first(raw.direction) === "desc" ? "desc" : "asc";
  const current = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const normalized = first(value);
    if (normalized) current.set(key, normalized);
  }

  let result: Awaited<ReturnType<typeof getFundList>> | null = null;
  let options: Awaited<ReturnType<typeof getFundFilterOptions>> = { companies: [], currencies: [], categories: [], riskLevels: [] };
  let loadError = false;
  try {
    [result, options] = await Promise.all([
      getFundList({ query, company, currency, category, riskLevel: risk, sort, direction, page, pageSize }),
      getFundFilterOptions(),
    ]);
  } catch {
    loadError = true;
  }

  const rows = (result?.data ?? []).filter((row) => row.publicReady);
  const pagination = result?.pagination;
  const hasFilters = Boolean(query || company || currency || category || risk);

  return (
    <main className="min-h-screen bg-[#040a18] px-4 pb-20 pt-28 text-white sm:px-6">
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/[0.08] bg-[#040a18]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-[1700px] items-center justify-between px-4 sm:px-10">
          <Link href="/" className="shrink-0">
            <div className="text-[26px] font-black leading-none text-white">Smart<span className="text-[#F5B700]">Match</span></div>
            <div className="mt-1 text-[10px] text-slate-500">全球投資研究平台</div>
          </Link>
          <nav className="hidden items-center gap-7 text-[14px] font-semibold text-slate-300 lg:flex">
            <Link href="/" className="transition-colors hover:text-white">市場總覽</Link>
            <Link href="/etf" className="transition-colors hover:text-white">ETF</Link>
            <Link href="/funds" className="text-[#F5B700]">基金</Link>
            <Link href="/compare" className="transition-colors hover:text-white">商品比較</Link>
            <Link href="/rankings" className="transition-colors hover:text-white">排行榜</Link>
          </nav>
          <Link href="/search" className="rounded-lg border border-white/20 px-4 py-2 text-[13px] font-semibold text-slate-200 transition-colors hover:bg-white/[0.06]">搜尋</Link>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px]">
        <section className="mb-8">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-bold tracking-[0.18em] text-[#F5B700]">
            <span>全球基金正式資料</span>
            <span className="rounded-full border border-[#F5B700]/25 bg-[#F5B700]/10 px-2 py-1 tracking-normal">級別資料部分涵蓋</span>
          </div>
          <h1 className="text-3xl font-black tracking-tight sm:text-[42px]">全球基金探索</h1>
          <p className="mt-3 max-w-3xl text-sm leading-7 text-slate-400 sm:text-base">搜尋與篩選 SmartMatch canonical database 中的基金。資料依官方或已驗證來源呈現，未提供欄位保持空白。</p>
        </section>

        <form action="/funds" className="mb-5 grid gap-3 rounded-2xl border border-white/[0.09] bg-white/[0.025] p-4 md:grid-cols-2 xl:grid-cols-6">
          <label className="xl:col-span-2">
            <span className="mb-1.5 block text-[11px] font-semibold text-slate-500">關鍵字</span>
            <input name="q" defaultValue={query} placeholder="基金名稱、代碼、ISIN 或公司" className="w-full rounded-lg border border-white/15 bg-[#071020] px-3 py-2.5 text-sm outline-none placeholder:text-slate-600 focus:border-[#F5B700]" />
          </label>
          <FilterSelect name="company" label="基金公司" value={company} options={options.companies} />
          <FilterSelect name="currency" label="幣別" value={currency} options={options.currencies} />
          <FilterSelect name="category" label="資產類別" value={category} options={options.categories} />
          <label>
            <span className="mb-1.5 block text-[11px] font-semibold text-slate-500">風險等級</span>
            <select name="risk" defaultValue={risk ?? ""} className="w-full rounded-lg border border-white/15 bg-[#071020] px-3 py-2.5 text-sm outline-none focus:border-[#F5B700]">
              <option value="">全部</option>
              {options.riskLevels.map((value) => <option key={value} value={value}>風險等級 {value}</option>)}
            </select>
          </label>
          <input type="hidden" name="sort" value={sort} />
          <input type="hidden" name="direction" value={direction} />
          <input type="hidden" name="pageSize" value={pageSize} />
          <div className="flex items-end gap-2 xl:col-start-6">
            <button className="flex-1 rounded-lg bg-[#F5B700] px-4 py-2.5 text-sm font-bold text-[#0B1220] hover:bg-[#ffd13a]">套用</button>
            {hasFilters && <Link href="/funds" className="rounded-lg border border-white/15 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/[0.05]">清除</Link>}
          </div>
        </form>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-slate-500">
            {loadError ? "正式資料暫時無法讀取" : `共 ${pagination?.total.toLocaleString("zh-TW") ?? 0} 檔基金 · 第 ${pagination?.page ?? page} 頁`}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-600">排序</span>
            <SortLink current={current} active={sort === "name"} field="name" direction={sort === "name" && direction === "asc" ? "desc" : "asc"}>名稱</SortLink>
            <SortLink current={current} active={sort === "latestNavDate"} field="latestNavDate" direction={sort === "latestNavDate" && direction === "desc" ? "asc" : "desc"}>NAV 日期</SortLink>
            <SortLink current={current} active={sort === "performance1Y"} field="performance1Y" direction={sort === "performance1Y" && direction === "desc" ? "asc" : "desc"}>1Y NAV 報酬</SortLink>
          </div>
        </div>

        <section className="overflow-hidden rounded-2xl border border-white/[0.09] bg-white/[0.02]">
          {loadError ? (
            <EmptyState title="基金資料暫時無法讀取" description="正式資料服務目前未回應，請稍後再試。頁面不會改用靜態或模擬資料。" />
          ) : rows.length === 0 ? (
            <EmptyState title="找不到符合條件的基金" description="請調整關鍵字或篩選條件。SmartMatch 不會產生不存在的基金資料。" />
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[1180px] text-left">
                  <thead className="bg-white/[0.045] text-[11px] uppercase tracking-wide text-slate-500">
                    <tr><th className="px-5 py-3">基金</th><th className="px-4 py-3">基金公司</th><th className="px-4 py-3">類別</th><th className="px-4 py-3">幣別</th><th className="px-4 py-3 text-right">最新 NAV</th><th className="px-4 py-3">NAV 日期</th><th className="px-4 py-3 text-right">1Y NAV 報酬</th><th className="px-4 py-3">風險</th><th className="px-4 py-3">資料狀態</th><th className="px-4 py-3">來源</th></tr>
                  </thead>
                  <tbody>
                    {rows.map((fund) => <FundRow key={fund.identity.id} fund={fund} />)}
                  </tbody>
                </table>
              </div>
              <div className="divide-y divide-white/[0.07] md:hidden">
                {rows.map((fund) => <FundCard key={fund.identity.id} fund={fund} />)}
              </div>
            </>
          )}
        </section>

        {pagination && pagination.total > 0 && (
          <nav className="mt-5 flex items-center justify-between" aria-label="基金分頁">
            <Link aria-disabled={pagination.page <= 1} href={pagination.page > 1 ? asHref(current, { page: pagination.page - 1 }) : asHref(current, { page: 1 })} className={`rounded-lg border px-4 py-2 text-sm ${pagination.page <= 1 ? "pointer-events-none border-white/[0.06] text-slate-700" : "border-white/15 text-slate-300 hover:bg-white/[0.05]"}`}>← 上一頁</Link>
            <span className="text-xs text-slate-500">每頁 {pagination.pageSize} 筆</span>
            <Link aria-disabled={!pagination.hasNextPage} href={pagination.hasNextPage ? asHref(current, { page: pagination.page + 1 }) : asHref(current, { page: pagination.page })} className={`rounded-lg border px-4 py-2 text-sm ${!pagination.hasNextPage ? "pointer-events-none border-white/[0.06] text-slate-700" : "border-white/15 text-slate-300 hover:bg-white/[0.05]"}`}>下一頁 →</Link>
          </nav>
        )}

        <div className="mt-8 grid gap-3 text-xs text-slate-500 sm:grid-cols-3">
          <Info label="資料新鮮度" value={result?.meta.freshnessStatus ?? "UNKNOWN"} />
          <Info label="資料來源" value={display(result?.meta.source, "依各基金來源顯示")} />
          <Info label="涵蓋狀態" value="基金主檔已接線；級別資料為部分涵蓋" />
        </div>
      </div>
    </main>
  );
}

function FilterSelect({ name, label, value, options }: { name: string; label: string; value?: string; options: string[] }) {
  return <label><span className="mb-1.5 block text-[11px] font-semibold text-slate-500">{label}</span><select name={name} defaultValue={value ?? ""} className="w-full rounded-lg border border-white/15 bg-[#071020] px-3 py-2.5 text-sm outline-none focus:border-[#F5B700]"><option value="">全部</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function SortLink({ current, active, field, direction, children }: { current: URLSearchParams; active: boolean; field: FundListQuery["sort"]; direction: "asc" | "desc"; children: React.ReactNode }) {
  return <Link href={asHref(current, { sort: field ?? "name", direction, page: 1 })} className={`rounded-full border px-3 py-1.5 transition-colors ${active ? "border-[#F5B700]/60 bg-[#F5B700]/10 text-[#F5B700]" : "border-white/10 text-slate-400 hover:border-white/25"}`}>{children}{active ? (direction === "asc" ? " ↓" : " ↑") : ""}</Link>;
}

type Fund = NonNullable<Awaited<ReturnType<typeof getFundList>>["data"]>[number];

function FundRow({ fund }: { fund: Fund }) {
  return <tr className="border-t border-white/[0.055] text-[12px] transition-colors hover:bg-[#F5B700]/[0.035]"><td className="px-5 py-4"><div className="max-w-[300px] font-semibold text-slate-100">{fund.identity.name}</div><div className="mt-1 font-mono text-[10px] text-slate-600">{fund.identity.symbol}{fund.isin ? ` · ISIN ${fund.isin}` : ""}</div></td><td className="px-4 py-4 text-slate-300">{display(fund.company)}</td><td className="px-4 py-4 text-slate-400">{display(fund.category, "未分類")}</td><td className="px-4 py-4 text-slate-300">{display(fund.identity.currency, "—")}</td><td className="px-4 py-4 text-right font-semibold text-white">{numberLabel(fund.metrics.priceOrNav, 4)}</td><td className="px-4 py-4 text-slate-400">{dateLabel(fund.metrics.asOfDate)}</td><td className={`px-4 py-4 text-right font-semibold ${fund.metrics.performance1Y === null ? "text-slate-600" : fund.metrics.performance1Y >= 0 ? "text-emerald-400" : "text-red-400"}`}>{percentLabel(fund.metrics.performance1Y)}</td><td className="px-4 py-4 text-slate-400">{fund.riskLevel === null ? "未提供" : `等級 ${fund.riskLevel}`}</td><td className="px-4 py-4"><Status value={fund.freshnessStatus} /></td><td className="max-w-[180px] truncate px-4 py-4 text-slate-500" title={fund.source ?? undefined}>{display(fund.source, "未標示")}</td></tr>;
}

function FundCard({ fund }: { fund: Fund }) {
  return <article className="p-5"><div className="flex items-start justify-between gap-3"><div><h2 className="font-bold text-white">{fund.identity.name}</h2><p className="mt-1 font-mono text-[10px] text-slate-600">{fund.identity.symbol}{fund.isin ? ` · ${fund.isin}` : ""}</p></div><Status value={fund.freshnessStatus} /></div><div className="mt-4 grid grid-cols-2 gap-3 text-xs"><Info label="基金公司" value={display(fund.company)} /><Info label="類別 / 幣別" value={`${display(fund.category, "未分類")} · ${display(fund.identity.currency, "—")}`} /><Info label="最新 NAV" value={numberLabel(fund.metrics.priceOrNav, 4)} /><Info label="NAV 日期" value={dateLabel(fund.metrics.asOfDate)} /><Info label="1Y NAV 報酬" value={percentLabel(fund.metrics.performance1Y)} /><Info label="風險" value={fund.riskLevel === null ? "未提供" : `等級 ${fund.riskLevel}`} /></div><p className="mt-4 truncate border-t border-white/[0.06] pt-3 text-[10px] text-slate-600">來源：{display(fund.source, "未標示")}</p></article>;
}

function Status({ value }: { value: string }) {
  const healthy = value === "CURRENT" || value === "HEALTHY_WAITING";
  return <span className={`inline-flex rounded-full border px-2 py-1 text-[9px] font-bold tracking-wide ${healthy ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-400" : "border-white/10 bg-white/[0.04] text-slate-500"}`}>{value}</span>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="mb-1 text-[10px] uppercase tracking-wide text-slate-600">{label}</div><div className="text-slate-300">{value}</div></div>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="px-6 py-20 text-center"><div className="text-lg font-bold text-white">{title}</div><p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-slate-500">{description}</p></div>;
}

