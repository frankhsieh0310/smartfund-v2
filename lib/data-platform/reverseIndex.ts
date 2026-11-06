import type { Query, Target, MatchRow } from './reverseHoldings';
import { rankProducts, paginate } from './reverseHoldings';
import { classifyEtfBucketJs, classifyFundBucketJs } from './assetCategoryBucketJs';
import type { AssetCategoryBucket } from './categoryClassification';

// 2026-11-07（使用者第 32 輪指令: 反查頁要能依類型篩選、依績效/規模/配息排序，且排序篩選要在
//「全部結果」上做，不能只排目前頁面的 50 筆）: eligible 集合本身已經是「某檔股票被哪些 ETF／
// 基金持有」，數量受限於產品被持有的次數（實測 2330 共 677 檔，不是全表），所以直接把這個集合
// 整批抓出來（不在 SQL 做 LIMIT/OFFSET），用一次批次查詢把 etfs/funds 的分類與
// etf_performances/fund_performances 最新一筆指標 join 進來，分類、排序、分頁都在 JS 做——
// 不碰原本的 reverseSQL/positions 配對邏輯（那段歷史上出過好幾次細節 bug，不在這輪動它）。
const PERFORMANCE_SORTS = ['return_1m', 'return_3m', 'return_6m', 'return_ytd', 'return_1y', 'return_3y', 'return_5y'] as const;
const SORT_KEYS = ['weight', ...PERFORMANCE_SORTS, 'aum', 'dividend_yield'] as const;
export type ReverseSortKey = (typeof SORT_KEYS)[number];
const CATEGORY_BUCKETS = ['ALL', 'STOCK', 'BOND', 'MIXED', 'COMMODITY', 'LEVERAGE_INVERSE'] as const;
export type ReverseCategoryParam = (typeof CATEGORY_BUCKETS)[number];

type EligibleRow = { product_key: string; type: 'ETF' | '基金'; asset_id: string; code: string; matched_count: number; weight: number };
type MetricRow = { asset_id: string; category: string | null; aum: string | null; dividend_yield: string | null; return_1m: string | null; return_3m: string | null; return_6m: string | null; return_ytd: string | null; return_1y: string | null; return_3y: string | null; return_5y: string | null };

/** Current canonical postings only: no holdings reconstruction on the request path. */
export async function currentReverseHoldings(query: Query, input: { tickers: string[]; market?: string; page?: number; limit?: number; type?: string; sort?: string; category?: string; direction?: string }) {
  const started = performance.now();
  const requested = [...new Set(input.tickers.map(x => x.trim().toUpperCase()).filter(Boolean))];
  if (!requested.length || requested.length > 10) throw Error('INVALID_TICKERS');
  const page = input.page ?? 1, limit = input.limit ?? 50, type = input.type ?? 'ALL';
  paginate([], page, limit, type);
  const legacySort = input.sort ?? 'weight_desc';
  // Back-compat: the old sort param was 'weight_desc'/'weight_asc' bundled together. New callers
  // pass sort=<key> and direction=asc|desc separately; derive both forms so neither caller breaks.
  const sortKey: ReverseSortKey = SORT_KEYS.includes(input.sort as ReverseSortKey) ? (input.sort as ReverseSortKey) : (legacySort === 'weight_asc' ? 'weight' : 'weight');
  const direction: 'asc' | 'desc' = input.direction === 'asc' ? 'asc' : legacySort === 'weight_asc' && !input.direction ? 'asc' : 'desc';
  const category: ReverseCategoryParam = CATEGORY_BUCKETS.includes(input.category as ReverseCategoryParam) ? (input.category as ReverseCategoryParam) : 'ALL';

  const result = await query<{ ready: boolean; rows: EligibleRow[]; targets: Target[]; invalid: string[]; etf_total: number; fund_total: number; matched_ids: string[] }>(`
    WITH candidates AS MATERIALIZED (
      SELECT r.requested,s.id,s.ticker,s.bare,s.country,dense_rank() OVER(PARTITION BY r.requested ORDER BY (s.ticker=r.requested) DESC) priority
      FROM unnest($1::text[]) r(requested) JOIN reverse_current_securities s ON (s.ticker=r.requested OR s.bare=r.requested) AND ($2='' OR s.country=$2)
    ), invalid AS (
      SELECT r.requested FROM unnest($1::text[]) r(requested) LEFT JOIN candidates c ON c.requested=r.requested AND c.priority=1 GROUP BY r.requested HAVING count(c.id)<>1
    ), selected AS MATERIALIZED (
      SELECT DISTINCT id,ticker,bare,country FROM candidates WHERE priority=1 AND NOT EXISTS(SELECT 1 FROM invalid) AND EXISTS(SELECT 1 FROM reverse_projection_state WHERE ready) AND NOT EXISTS(SELECT 1 FROM reverse_refresh_queue)
    ), postings AS MATERIALIZED (
      SELECT p.* FROM selected s JOIN reverse_current_positions p ON p.stock_id=s.id
    ), grouped AS MATERIALIZED (
      SELECT product_key,type,asset_id,code,count(*)::int matched_count,sum(coalesce(weight,0)) weight
      FROM postings GROUP BY product_key,type,asset_id,code
    )
    SELECT coalesce((SELECT jsonb_agg(to_jsonb(g)) FROM grouped g),'[]'::jsonb) rows,
      (SELECT count(*)::int FROM grouped WHERE type='ETF') etf_total,
      (SELECT count(*)::int FROM grouped WHERE type='基金') fund_total,
      ARRAY(SELECT DISTINCT stock_id FROM postings) matched_ids,
      coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM selected s),'[]'::jsonb) targets,
      ARRAY(SELECT requested FROM invalid) invalid,
      (EXISTS(SELECT 1 FROM reverse_projection_state WHERE ready) AND NOT EXISTS(SELECT 1 FROM reverse_refresh_queue)) ready`,requested,input.market??'');
  const value=result[0];
  if(!value.ready)throw Error('REVERSE_INDEX_NOT_READY');
  if(value.invalid.length)throw Error(`UNRESOLVED_OR_AMBIGUOUS_SECURITY:${value.invalid.join(',')}`);
  const selected=value.targets;

  const eligible = value.rows;
  const etfCodes = [...new Set(eligible.filter(r => r.type === 'ETF').map(r => r.asset_id))];
  const fundIds = [...new Set(eligible.filter(r => r.type === '基金').map(r => r.asset_id))];

  const metricsByAssetId = new Map<string, MetricRow>();
  if (etfCodes.length) {
    const rows = await query<MetricRow>(`
      WITH latest_perf AS (SELECT DISTINCT ON (etf_id) etf_id, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y FROM etf_performances WHERE etf_id IN (SELECT id FROM etfs WHERE code = ANY($1::text[])) ORDER BY etf_id, date DESC)
      SELECT e.code asset_id, e.category, e.aum::text aum, e.dividend_yield::text dividend_yield,
        lp.return_1m::text return_1m, lp.return_3m::text return_3m, lp.return_6m::text return_6m, lp.return_ytd::text return_ytd,
        lp.return_1y::text return_1y, lp.return_3y::text return_3y, lp.return_5y::text return_5y
      FROM etfs e LEFT JOIN latest_perf lp ON lp.etf_id = e.id WHERE e.code = ANY($1::text[])`, etfCodes);
    for (const r of rows) metricsByAssetId.set(r.asset_id, r);
  }
  if (fundIds.length) {
    const rows = await query<MetricRow>(`
      WITH latest_perf AS (SELECT DISTINCT ON (fund_id) fund_id, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y FROM fund_performances WHERE fund_id = ANY($1::text[]) ORDER BY fund_id, date DESC)
      SELECT f.id asset_id, f.category, f.aum::text aum, coalesce(f.dividend_yield_a, f.dividend_yield_m)::text dividend_yield,
        lp.return_1m::text return_1m, lp.return_3m::text return_3m, lp.return_6m::text return_6m, lp.return_ytd::text return_ytd,
        lp.return_1y::text return_1y, lp.return_3y::text return_3y, lp.return_5y::text return_5y
      FROM funds f LEFT JOIN latest_perf lp ON lp.fund_id = f.id WHERE f.id = ANY($1::text[])`, fundIds);
    for (const r of rows) metricsByAssetId.set(r.asset_id, r);
  }

  const toNum = (v: string | null) => (v === null ? null : Number(v));
  type Enriched = EligibleRow & { bucket: AssetCategoryBucket; metric: number | null };
  const enriched: Enriched[] = eligible.map(r => {
    const m = metricsByAssetId.get(r.asset_id);
    const bucket: AssetCategoryBucket = r.type === 'ETF'
      ? classifyEtfBucketJs(r.code, r.code, m?.category ?? null)
      : classifyFundBucketJs(m?.category ?? null);
    const metric = sortKey === 'weight' ? r.weight
      : sortKey === 'aum' ? toNum(m?.aum ?? null)
      : sortKey === 'dividend_yield' ? toNum(m?.dividend_yield ?? null)
      : toNum((m as MetricRow | undefined)?.[sortKey as typeof PERFORMANCE_SORTS[number]] ?? null);
    return { ...r, bucket, metric };
  });

  const typeFiltered = enriched.filter(r => type === 'ALL' || r.type === (type === 'FUND' ? '基金' : 'ETF'));
  const filtered = category === 'ALL' ? typeFiltered : typeFiltered.filter(r => r.bucket === category);

  // Rows lacking the chosen metric sort last regardless of direction (never treated as 0), per
  // 2026-11-07 指令第 5 點。Ties broken by product_key for a stable order across requests.
  filtered.sort((a, b) => {
    if (a.metric === null && b.metric === null) return a.product_key.localeCompare(b.product_key);
    if (a.metric === null) return 1;
    if (b.metric === null) return -1;
    return direction === 'asc' ? a.metric - b.metric : b.metric - a.metric;
  });

  const total = filtered.length;
  const pageRows = filtered.slice((page - 1) * limit, page * limit);
  const orderIds = pageRows.map(r => r.product_key);

  const matchRows = orderIds.length ? await query<MatchRow>(`
    SELECT p.* FROM reverse_current_positions p WHERE p.product_key = ANY($1::text[]) AND p.stock_id = ANY($2::text[])`,
    orderIds, selected.map((t: Target) => t.id)) : [];
  const products=rankProducts(matchRows);
  const results=orderIds.map(id=>products.find(p=>p.id===id)).filter((p): p is NonNullable<typeof p> => Boolean(p));

  return {ok:true,total,page,limit,hasMore:page*limit<total,results,
    tickers:selected.map((t: Target)=>t.ticker),generated_at:new Date().toISOString(),
    etf_total_products:value.etf_total,fund_total_products:value.fund_total,
    unmatched_tickers:selected.filter((t: Target)=>!value.matched_ids.includes(t.id)).map((t: Target)=>t.ticker),
    etfs:results.filter(p=>p.type==='ETF'),funds:results.filter(p=>p.type==='基金'),
    metricUnavailableCount:filtered.filter(r=>r.metric===null).length,
    timing:{db_ms:Math.round((performance.now()-started)*100)/100}};
}
