import type { Query, Target, MatchRow } from './reverseHoldings';
import { rankProducts, paginate } from './reverseHoldings';

/** Current canonical postings only: no holdings reconstruction on the request path. */
export async function currentReverseHoldings(query: Query, input: { tickers: string[]; market?: string; page?: number; limit?: number; type?: string; sort?: string }) {
  const started = performance.now();
  const requested = [...new Set(input.tickers.map(x => x.trim().toUpperCase()).filter(Boolean))];
  if (!requested.length || requested.length > 10) throw Error('INVALID_TICKERS');
  const page = input.page ?? 1, limit = input.limit ?? 50, type = input.type ?? 'ALL';
  paginate([], page, limit, type);
  const sort = input.sort ?? 'weight_desc';
  if (!['weight_desc', 'weight_asc'].includes(sort)) throw Error('INVALID_SORT');
  const order = `CASE WHEN (SELECT count(*) FROM selected)=1 THEN 0 ELSE matched_count END DESC,
    CASE WHEN (SELECT count(*) FROM selected)=1 AND $6='weight_asc' THEN weight END ASC,
    weight DESC,product_key`;
  const result = await query<{ ready: boolean; rows: MatchRow[]; targets: Target[]; invalid: string[]; total: number; etf_total: number; fund_total: number; matched_ids: string[] }>(`
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
      SELECT product_key,type,count(*)::int matched_count,sum(coalesce(weight,0)) weight
      FROM postings GROUP BY product_key,type
    ), eligible AS MATERIALIZED (
      SELECT * FROM grouped WHERE $3='ALL' OR type=CASE WHEN $3='ETF' THEN 'ETF' ELSE '基金' END
    ), page AS (SELECT *,row_number() OVER(ORDER BY ${order}) ordinal FROM eligible ORDER BY ${order} LIMIT $4 OFFSET $5)
    SELECT coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY g.ordinal,p.stock_id) FROM page g JOIN postings p USING(product_key)),'[]'::jsonb) rows,
      (SELECT count(*)::int FROM eligible) total,
      (SELECT count(*)::int FROM grouped WHERE type='ETF') etf_total,
      (SELECT count(*)::int FROM grouped WHERE type='基金') fund_total,
      ARRAY(SELECT DISTINCT stock_id FROM postings) matched_ids,
      coalesce((SELECT jsonb_agg(to_jsonb(s)) FROM selected s),'[]'::jsonb) targets,
      ARRAY(SELECT requested FROM invalid) invalid,
      (EXISTS(SELECT 1 FROM reverse_projection_state WHERE ready) AND NOT EXISTS(SELECT 1 FROM reverse_refresh_queue)) ready`,requested,input.market??'',type,limit,(page-1)*limit,sort);
  const value=result[0];
  if(!value.ready)throw Error('REVERSE_INDEX_NOT_READY');
  if(value.invalid.length)throw Error(`UNRESOLVED_OR_AMBIGUOUS_SECURITY:${value.invalid.join(',')}`);
  const selected=value.targets;
  // rankProducts builds the existing response contract; preserve SQL page order explicitly.
  const products=rankProducts(value.rows);
  const orderIds=[...new Set(value.rows.map(r=>r.product_key))];
  const results=orderIds.map(id=>products.find(p=>p.id===id)!);
  return {ok:true,total:value.total,page,limit,hasMore:page*limit<value.total,results,
    tickers:selected.map(t=>t.ticker),generated_at:new Date().toISOString(),
    etf_total_products:value.etf_total,fund_total_products:value.fund_total,
    unmatched_tickers:selected.filter(t=>!value.matched_ids.includes(t.id)).map(t=>t.ticker),
    etfs:results.filter(p=>p.type==='ETF'),funds:results.filter(p=>p.type==='基金'),
    timing:{db_ms:Math.round((performance.now()-started)*100)/100}};
}
