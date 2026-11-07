// Shared by app/api/mobile/new-listings/route.ts and app/new-listings/page.tsx (the web page reads
// this directly instead of HTTP-fetching its own API route -- a Preview deployment's Deployment
// Protection blocks even a same-deployment server-side self-fetch, which is what the page's first
// version hit: VERIFIED live, HTTP 500 on Preview from that self-fetch, 200 when querying directly
// like every other server component page in this app already does).
import { prisma } from "@/lib/prisma";
import { classifyEtfBucketJs, classifyFundBucketJs } from "../assetCategoryBucketJs";
import type { AssetCategoryBucket } from "../categoryClassification";

export type ListingEvent = {
  code: string;
  name: string;
  listed_date: string | null;
  source: string;
  source_url: string | null;
  detail_available: boolean;
  product_id: string | null;
  category: AssetCategoryBucket | 'UNCLASSIFIED';
  metric: number | null;
};

const PERFORMANCE_SORTS = ["return_1m", "return_3m", "return_6m", "return_ytd", "return_1y", "return_3y", "return_5y"] as const;
const SORT_KEYS = [...PERFORMANCE_SORTS, "aum", "dividend_yield"] as const;
export type NewListingsSortKey = typeof SORT_KEYS[number];
const CATEGORY_BUCKETS = ["ALL", "STOCK", "BOND", "MIXED", "COMMODITY", "LEVERAGE_INVERSE"] as const;
export type NewListingsCategoryParam = typeof CATEGORY_BUCKETS[number];

type RawRow = { code: string; name: string; product_type: string; milestone_date: Date | null; source: string; source_url: string | null; product_id: string | null };
type MetricRow = { asset_id: string; category: string | null; aum: string | null; dividend_yield: string | null; return_1m: string | null; return_3m: string | null; return_6m: string | null; return_ytd: string | null; return_1y: string | null; return_3y: string | null; return_5y: string | null };
const toNum = (v: string | null) => (v === null ? null : Number(v));

export async function getNewListingEvents(
  days = 30,
  opts: { sort?: string; category?: string; direction?: "asc" | "desc" } = {},
): Promise<{ upcoming: ListingEvent[]; recent: ListingEvent[]; window_days: number; generated_at: string; metricUnavailableCount: number }> {
  const boundedDays = Math.max(1, Math.min(90, days));
  const cutoff = new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000);
  const now = new Date();
  const sortKey = SORT_KEYS.includes(opts.sort as NewListingsSortKey) ? (opts.sort as NewListingsSortKey) : null;
  const direction: "asc" | "desc" = opts.direction === "asc" ? "asc" : "desc";
  const category: NewListingsCategoryParam = CATEGORY_BUCKETS.includes(opts.category as NewListingsCategoryParam) ? (opts.category as NewListingsCategoryParam) : "ALL";

  const events = await prisma.$queryRawUnsafe<RawRow[]>(
    `SELECT code, name, product_type, milestone_date, source, source_url, product_id
     FROM product_listing_events
     WHERE event_type = 'NEW_LISTING' AND (milestone_date IS NULL OR milestone_date >= $1)
     ORDER BY milestone_date DESC NULLS FIRST`,
    cutoff,
  );

  // 2026-11-07 第32輪指令：要能依類型篩選、依績效/規模/配息率排序——這張表本身只有上市事件的
  // metadata（沒有分類、沒有績效），product_id 要等自動配對解析完才會有值（見上面欄位註解），
  // 所以用已解析出的 product_id 去 join etfs/funds 取分類跟 etf_performances/fund_performances
  // 最新一筆（不是 etfs.return_1y 那種過期扁平欄位）；還沒解析出 product_id 的事件無法分類/取
  // 績效，標「資料不足」、分類篩選時歸不進任何一類（排除於 category!=ALL 的結果之外，不硬塞）。
  const etfIds = events.filter((e) => e.product_type === "ETF" && e.product_id).map((e) => e.product_id as string);
  const fundIds = events.filter((e) => e.product_type === "FUND" && e.product_id).map((e) => e.product_id as string);
  const metricByProductId = new Map<string, MetricRow>();
  if (etfIds.length) {
    const rows = await prisma.$queryRawUnsafe<MetricRow[]>(
      `WITH latest_perf AS (SELECT DISTINCT ON (etf_id) etf_id, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y FROM etf_performances WHERE etf_id = ANY($1::text[]) ORDER BY etf_id, date DESC)
       SELECT e.id asset_id, e.category, e.aum::text aum, e.dividend_yield::text dividend_yield,
         lp.return_1m::text return_1m, lp.return_3m::text return_3m, lp.return_6m::text return_6m, lp.return_ytd::text return_ytd,
         lp.return_1y::text return_1y, lp.return_3y::text return_3y, lp.return_5y::text return_5y
       FROM etfs e LEFT JOIN latest_perf lp ON lp.etf_id = e.id WHERE e.id = ANY($1::text[])`,
      etfIds,
    );
    for (const r of rows) metricByProductId.set(r.asset_id, r);
  }
  if (fundIds.length) {
    const rows = await prisma.$queryRawUnsafe<MetricRow[]>(
      `WITH latest_perf AS (SELECT DISTINCT ON (fund_id) fund_id, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y FROM fund_performances WHERE fund_id = ANY($1::text[]) ORDER BY fund_id, date DESC)
       SELECT f.id asset_id, f.category, f.aum::text aum, coalesce(f.dividend_yield_a, f.dividend_yield_m)::text dividend_yield,
         lp.return_1m::text return_1m, lp.return_3m::text return_3m, lp.return_6m::text return_6m, lp.return_ytd::text return_ytd,
         lp.return_1y::text return_1y, lp.return_3y::text return_3y, lp.return_5y::text return_5y
       FROM funds f LEFT JOIN latest_perf lp ON lp.fund_id = f.id WHERE f.id = ANY($1::text[])`,
      fundIds,
    );
    for (const r of rows) metricByProductId.set(r.asset_id, r);
  }

  const shape = (e: RawRow): ListingEvent => {
    const m = e.product_id ? metricByProductId.get(e.product_id) : undefined;
    const bucket: AssetCategoryBucket | "UNCLASSIFIED" = !e.product_id
      ? "UNCLASSIFIED"
      : e.product_type === "ETF"
        ? classifyEtfBucketJs(e.code, e.name, m?.category ?? null)
        : classifyFundBucketJs(m?.category ?? null);
    const metric = sortKey ? (sortKey === "aum" ? toNum(m?.aum ?? null) : sortKey === "dividend_yield" ? toNum(m?.dividend_yield ?? null) : toNum((m as MetricRow | undefined)?.[sortKey] ?? null)) : null;
    return {
      code: e.code,
      name: e.name,
      listed_date: e.milestone_date ? e.milestone_date.toISOString().slice(0, 10) : null,
      source: e.source,
      source_url: e.source_url,
      detail_available: Boolean(e.product_id),
      product_id: e.product_id,
      category: bucket,
      metric,
    };
  };

  const shaped = events.map(shape);
  const filtered = category === "ALL" ? shaped : shaped.filter((e) => e.category === category);
  const sorted = sortKey
    ? [...filtered].sort((a, b) => {
        if (a.metric === null && b.metric === null) return a.code.localeCompare(b.code);
        if (a.metric === null) return 1;
        if (b.metric === null) return -1;
        return direction === "asc" ? a.metric - b.metric : b.metric - a.metric;
      })
    : filtered;

  return {
    upcoming: sorted.filter((e) => e.listed_date && new Date(e.listed_date) > now),
    recent: sorted.filter((e) => !e.listed_date || new Date(e.listed_date) <= now),
    window_days: boundedDays,
    generated_at: new Date().toISOString(),
    metricUnavailableCount: sortKey ? filtered.filter((e) => e.metric === null).length : 0,
  };
}
