// Standalone, presentational holdings-analysis components. Not yet wired into any product detail
// page — each takes already-fetched data as props (matching the shape returned by
// app/api/holdings/[type]/[id]/{table,concentration,diff}/route.ts) so a page can mount them once
// its own data-fetching is wired up, without this file needing to know how that fetch happens.

type CoverageDepth = "TOP_N" | "PARTIAL" | "FULL" | "UNKNOWN";

const depthLabel: Record<CoverageDepth, string> = {
  FULL: "完整持股",
  PARTIAL: "部分持股",
  TOP_N: "前 N 大持股",
  UNKNOWN: "深度未知",
};

function IncompleteBadge({ coverageDepth }: { coverageDepth: CoverageDepth }) {
  if (coverageDepth === "FULL") {
    return (
      <span className="rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-xs font-bold text-emerald-200">
        {depthLabel[coverageDepth]}
      </span>
    );
  }
  return (
    <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-3 py-1 text-xs font-bold text-amber-200">
      {depthLabel[coverageDepth]}・資料不完整
    </span>
  );
}

// ---- A. Holdings table ----

export type HoldingsTableApiResponse = {
  ok: boolean;
  productType: "ETF" | "FUND";
  productId: string;
  asOfDate: string | null;
  source: string | null;
  coverageDepth: CoverageDepth;
  isFullHoldings: boolean;
  holdingCount: number | null;
  incompleteDataWarning: boolean;
  rows: Array<{ key: string; name: string; ticker: string | null; weightPct: number; sector: string | null; country: string | null }>;
};

export function HoldingsTablePanel({ data }: { data: HoldingsTableApiResponse }) {
  return (
    <section className="mt-8 rounded-2xl border border-slate-500/30 bg-[#14243a] p-6 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-black text-white">持股明細</h2>
        <div className="flex items-center gap-3">
          <IncompleteBadge coverageDepth={data.coverageDepth} />
          <span className="text-xs text-slate-400">
            資料日期：{data.asOfDate ?? "—"}・來源：{data.source ?? "—"}
          </span>
        </div>
      </div>
      {data.incompleteDataWarning && (
        <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-2 text-sm text-amber-200">
          目前僅取得 {data.holdingCount ?? "部分"} 檔持股，非完整投資組合，實際持股可能更多。
        </p>
      )}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead className="text-xs font-bold text-slate-400">
            <tr>
              <th className="py-2 pr-4">名稱 / 代號</th>
              <th className="py-2 pr-4">權重</th>
              <th className="py-2 pr-4">產業</th>
              <th className="py-2 pr-4">國家</th>
            </tr>
          </thead>
          <tbody className="text-slate-100">
            {data.rows.map((row) => (
              <tr key={row.key} className="border-t border-slate-500/20">
                <td className="py-2 pr-4">
                  {row.name}
                  {row.ticker ? <span className="ml-2 text-xs text-slate-400">{row.ticker}</span> : null}
                </td>
                <td className="py-2 pr-4">{row.weightPct.toFixed(2)}%</td>
                <td className="py-2 pr-4 text-slate-300">{row.sector ?? "—"}</td>
                <td className="py-2 pr-4 text-slate-300">{row.country ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---- B. Concentration ----

export type ConcentrationApiResponse = {
  ok: boolean;
  productType: "ETF" | "FUND";
  productId: string;
  asOfDate: string | null;
  coverageDepth: CoverageDepth;
  isFullHoldings: boolean;
  basisNote: string;
  top10Pct: number;
  top20Pct: number;
  largestHolding: { key: string; name: string; weightPct: number } | null;
  sectorConcentration: Array<{ label: string; weightPct: number }>;
  countryConcentration: Array<{ label: string; weightPct: number }>;
};

function ConcentrationBucketList({ title, buckets }: { title: string; buckets: Array<{ label: string; weightPct: number }> }) {
  return (
    <div>
      <div className="text-xs font-bold text-slate-400">{title}</div>
      <ul className="mt-2 space-y-1 text-sm text-slate-100">
        {buckets.slice(0, 8).map((b) => (
          <li key={b.label} className="flex justify-between gap-3">
            <span>{b.label}</span>
            <span className="font-bold">{b.weightPct.toFixed(2)}%</span>
          </li>
        ))}
        {buckets.length === 0 && <li className="text-slate-500">—</li>}
      </ul>
    </div>
  );
}

export function ConcentrationPanel({ data }: { data: ConcentrationApiResponse }) {
  return (
    <section className="mt-8 rounded-2xl border border-slate-500/30 bg-[#14243a] p-6 shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-black text-white">集中度分析</h2>
        <IncompleteBadge coverageDepth={data.coverageDepth} />
      </div>
      <p className="mt-2 text-xs text-slate-400">{data.basisNote}</p>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-500/25 bg-[#0b1728]/70 p-4">
          <div className="text-xs font-bold text-slate-400">Top 10 集中度</div>
          <div className="mt-2 text-2xl font-black text-white">{data.top10Pct.toFixed(2)}%</div>
        </div>
        <div className="rounded-xl border border-slate-500/25 bg-[#0b1728]/70 p-4">
          <div className="text-xs font-bold text-slate-400">Top 20 集中度</div>
          <div className="mt-2 text-2xl font-black text-white">{data.top20Pct.toFixed(2)}%</div>
        </div>
        <div className="rounded-xl border border-slate-500/25 bg-[#0b1728]/70 p-4">
          <div className="text-xs font-bold text-slate-400">最大單一持股</div>
          <div className="mt-2 text-lg font-black text-white">
            {data.largestHolding ? `${data.largestHolding.name} ${data.largestHolding.weightPct.toFixed(2)}%` : "—"}
          </div>
        </div>
      </div>
      <div className="mt-5 grid gap-6 sm:grid-cols-2">
        <ConcentrationBucketList title="產業集中度" buckets={data.sectorConcentration} />
        <ConcentrationBucketList title="國家 / 地區集中度" buckets={data.countryConcentration} />
      </div>
    </section>
  );
}

// ---- C. Historical holdings diff ----

export type HoldingsDiffEntryView = { key: string; name: string; oldWeightPct: number | null; newWeightPct: number | null; deltaPct: number | null };

export type HoldingsDiffApiResponse = {
  ok: boolean;
  productType: "ETF" | "FUND";
  productId: string;
  hasEnoughHistory: boolean;
  previousDate: string | null;
  latestDate: string | null;
  added: HoldingsDiffEntryView[];
  increased: HoldingsDiffEntryView[];
  decreased: HoldingsDiffEntryView[];
  removed: HoldingsDiffEntryView[];
};

function DiffList({ title, entries, tone }: { title: string; entries: HoldingsDiffEntryView[]; tone: "positive" | "negative" | "neutral" }) {
  const toneClass = tone === "positive" ? "text-emerald-300" : tone === "negative" ? "text-rose-300" : "text-slate-200";
  return (
    <div>
      <div className="text-xs font-bold text-slate-400">
        {title}（{entries.length}）
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {entries.slice(0, 10).map((e) => (
          <li key={e.key} className={`flex justify-between gap-3 ${toneClass}`}>
            <span>{e.name}</span>
            <span className="font-bold">{e.deltaPct != null ? `${e.deltaPct > 0 ? "+" : ""}${e.deltaPct.toFixed(2)}%` : "—"}</span>
          </li>
        ))}
        {entries.length === 0 && <li className="text-slate-500">—</li>}
      </ul>
    </div>
  );
}

export function HoldingsDiffPanel({ data }: { data: HoldingsDiffApiResponse }) {
  return (
    <section className="mt-8 rounded-2xl border border-slate-500/30 bg-[#14243a] p-6 shadow-lg">
      <h2 className="text-2xl font-black text-white">持股異動</h2>
      {!data.hasEnoughHistory ? (
        <p className="mt-3 text-sm text-slate-400">目前只有一期持股快照，尚無法比較異動（需要至少兩期歷史資料）。</p>
      ) : (
        <>
          <p className="mt-2 text-xs text-slate-400">
            比較期間：{data.previousDate} → {data.latestDate}（以來源實際持股日期為準）
          </p>
          <div className="mt-5 grid gap-6 sm:grid-cols-2">
            <DiffList title="新增" entries={data.added} tone="positive" />
            <DiffList title="退出" entries={data.removed} tone="negative" />
            <DiffList title="加碼" entries={data.increased} tone="positive" />
            <DiffList title="減碼" entries={data.decreased} tone="negative" />
          </div>
        </>
      )}
    </section>
  );
}
