/** Shared read-only reverse lookup. Snapshot selection always precedes position matching. */
export type Query = <T>(sql: string, ...values: unknown[]) => Promise<T[]>;
export type Target = { id: string; ticker: string; country: string; exchange: string; name: string; bare: string; bare_unique: boolean; security_ids: string[]; names: string[]; unique_names?: string[] };
export type MatchRow = { product_key: string; code: string; name: string; type: 'ETF' | '基金'; asset_id: string; snapshot_id: string; date: string | null; source: string; coverage: string; stock_id: string; ticker: string; holding_name: string; weight: string | null };
export type ReverseProduct = { id: string; code: string; name: string; type: 'ETF' | '基金'; assetId: string; snapshotId: string; date: string | null; source: string; freshness: 'DATED' | 'UNKNOWN'; coverageDepth: string; matched_count: number; matched_weight_sum: number; holdings: { securityKey: string; ticker: string; name: string; weight: number | null }[] };

export function compareProducts(a: ReverseProduct, b: ReverseProduct) {
  return b.matched_count - a.matched_count || b.matched_weight_sum - a.matched_weight_sum || a.code.localeCompare(b.code, 'en') || a.id.localeCompare(b.id, 'en');
}
export function rankProducts(rows: MatchRow[]): ReverseProduct[] {
  const products = new Map<string, ReverseProduct>();
  for (const r of rows) {
    let p = products.get(r.product_key);
    if (!p) { p = { id: r.product_key, code: r.code, name: r.name, type: r.type, assetId: r.asset_id, snapshotId: r.snapshot_id, date: r.date, source: r.source, freshness: r.date ? 'DATED' : 'UNKNOWN', coverageDepth: r.coverage, matched_count: 0, matched_weight_sum: 0, holdings: [] }; products.set(r.product_key, p); }
    if (p.snapshotId !== r.snapshot_id) throw new Error('MIXED_PORTFOLIO_SNAPSHOT');
    if (p.holdings.some(h => h.securityKey === r.stock_id)) throw new Error('DUPLICATE_CANONICAL_POSITION');
    const weight = r.weight === null ? null : Number(r.weight);
    if (weight !== null && !Number.isFinite(weight)) throw new Error('INVALID_WEIGHT');
    p.holdings.push({ securityKey: r.stock_id, ticker: r.ticker, name: r.holding_name, weight });
    p.matched_count++; p.matched_weight_sum += weight ?? 0;
  }
  return [...products.values()].sort(compareProducts);
}
export function paginate(products: ReverseProduct[], page = 1, limit = 50, type = 'ALL') {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !['ALL','ETF','FUND'].includes(type)) throw new Error('INVALID_PAGINATION');
  const filtered = products.filter(p => type === 'ALL' || p.type === (type === 'FUND' ? '基金' : 'ETF'));
  return { total: filtered.length, page, limit, hasMore: page * limit < filtered.length, results: filtered.slice((page - 1) * limit, page * limit) };
}

export async function resolveTargets(query: Query, requested: string[], market = ''): Promise<Target[]> {
  const rows = await query<Target>(`
    SELECT s.id, upper(s.yahoo_symbol) ticker, s.country, s.exchange, s.company_name name,
      regexp_replace(upper(s.yahoo_symbol), '\\.[A-Z]+$', '') bare,
      (SELECT count(DISTINCT x.id)=1 FROM stocks x WHERE x.is_active AND regexp_replace(upper(x.yahoo_symbol),'\\.[A-Z]+$','')=regexp_replace(upper(s.yahoo_symbol),'\\.[A-Z]+$','')) bare_unique,
      ARRAY(SELECT l.security_id FROM stock_security_links l WHERE l.stock_id=s.id AND l.verification_status LIKE 'VERIFIED%') security_ids,
      ARRAY(SELECT DISTINCT lower(regexp_replace(n,'[^[:alnum:]]','','g')) FROM (
        SELECT s.company_name n UNION SELECT s.company_name_zh
        UNION SELECT q.name FROM securities q JOIN stock_security_links l ON l.security_id=q.id WHERE l.stock_id=s.id AND l.verification_status LIKE 'VERIFIED%'
        UNION SELECT q.name_en FROM securities q JOIN stock_security_links l ON l.security_id=q.id WHERE l.stock_id=s.id AND l.verification_status LIKE 'VERIFIED%'
        UNION SELECT h.holding_name FROM etf_holdings h JOIN stock_security_links l ON l.security_id=h.security_id WHERE l.stock_id=s.id AND l.verification_status LIKE 'VERIFIED%' AND h.holding_type='EQUITY' AND ${countrySQL('h.country')}=s.country
      ) a WHERE n IS NOT NULL AND n<>'') names
    FROM stocks s WHERE s.is_active AND ($2='' OR s.country=$2)
      AND (upper(s.yahoo_symbol)=ANY($1::text[]) OR upper(s.ticker)=ANY($1::text[])
        OR regexp_replace(upper(s.yahoo_symbol),'\\.[A-Z]+$','')=ANY($1::text[]))`, requested, market);
  const result: Target[] = [];
  for (const value of requested) {
    const exact = rows.filter(s => s.ticker === value);
    const candidates = exact.length ? exact : rows.filter(s => s.bare === value);
    if (candidates.length !== 1) throw new Error(`UNRESOLVED_OR_AMBIGUOUS_SECURITY:${value}`);
    if (!result.some(s => s.id === candidates[0].id)) result.push(candidates[0]);
  }
  // Only globally unambiguous EXACT canonical aliases may match a disclosure without market/code.
  // No prefix/fuzzy matching and no ADR/primary-listing collapse.
  for (const target of result) {
    const aliases = await query<{ name: string }>(`SELECT n name FROM unnest($1::text[]) n
      WHERE NOT EXISTS (SELECT 1 FROM stocks s WHERE s.is_active AND s.id<>$2 AND
        (lower(regexp_replace(s.company_name,'[^[:alnum:]]','','g'))=n OR lower(regexp_replace(s.company_name_zh,'[^[:alnum:]]','','g'))=n))
      AND NOT EXISTS (SELECT 1 FROM securities q JOIN stock_security_links l ON l.security_id=q.id
        WHERE l.stock_id<>$2 AND l.verification_status LIKE 'VERIFIED%' AND
        (lower(regexp_replace(q.name,'[^[:alnum:]]','','g'))=n OR lower(regexp_replace(q.name_en,'[^[:alnum:]]','','g'))=n))`, target.names, target.id);
    target.unique_names=aliases.map(a=>a.name);
  }
  return result;
}

// Explicit country context; a product's domicile is deliberately NOT treated as holding country.
const countrySQL = (field: string) => `CASE upper(coalesce(${field},'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(${field},'')) END`;
const matchSQL = (code: string, country: string) => `(
  (h.security_id IS NOT NULL AND h.security_id=ANY(t.security_ids) AND (${country}='' OR ${country}=t.country))
  OR ((h.security_id IS NULL OR hs.id IS NULL OR (${country}<>'' AND ${countrySQL('hs.country')}<>'' AND ${countrySQL('hs.country')}<>${country})) AND (
    (upper(${code})=t.ticker AND (t.ticker<>t.bare OR ${country}='' OR ${country}=t.country))
    OR (upper(${code})=t.bare AND (${country}=t.country OR (${country}='' AND t.bare_unique)))
    OR (nullif(${code},'') IS NULL AND (
      (${country}=t.country AND lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))=ANY(t.names))
      OR (${country}='' AND lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))=ANY(t.unique_names))))
  )))`;

export const reverseSQL = `WITH targets AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(id text,ticker text,country text,exchange text,name text,bare text,bare_unique boolean,security_ids text[],names text[],unique_names text[])
), etf_products AS (
  SELECT e.*, CASE WHEN e.code ~ '\\.(TW|TWO)$' OR coalesce(e.region,'') IN ('TW','Taiwan','TPEx') OR coalesce(e.exchange,'') IN ('TWSE','TPEx','TPEX','Taiwan')
    THEN 'ETF:TW:'||regexp_replace(e.code,'\\.(TW|TWO)$','')
    ELSE 'ETF:'||coalesce(nullif(e.isin,''),coalesce(e.exchange,'')||':'||e.code) END product_key
  FROM etfs e WHERE e.is_active
), etf_latest AS MATERIALIZED (
  SELECT DISTINCT ON(e.product_key) e.product_key,e.code,e.name,e.category,e.id etf_id,s.id snapshot_id,s.effective_date,s.source,s.completeness_status
  FROM etf_products e JOIN etf_holding_snapshots s ON s.etf_id=e.id
  WHERE (s.effective_date<=CURRENT_DATE OR (s.effective_date IS NULL AND s.source_type='PROVIDER_OBSERVATION'))
    AND s.verification_status IN ('COMPLETE','SOURCE_VERIFIED','SOURCE_PARSED')
    AND s.completeness_status IN ('COMPLETE','TOP_HOLDINGS_ONLY')
    AND s.quality_status NOT IN ('FAILED','INVALID','REJECTED')
    AND s.canonical_row_count=s.parsed_row_count
  ORDER BY e.product_key,s.effective_date DESC NULLS LAST,
    (s.completeness_status='COMPLETE') DESC,s.retrieved_at DESC,s.id
), fund_batches AS (
  SELECT coalesce(sc.master_fund_id,f.id) portfolio,f.id fund_id,f.code,f.name,
    h.as_of_date,CASE WHEN h.source='YAHOO_QUOTE_SUMMARY' THEN NULL ELSE h.as_of_date END effective_date,h.source,h.filing_id,count(*) row_count,
    (f.id=fm.representative_fund_id) representative,coalesce(fm.canonical_name,f.name) display_name
  FROM holdings h JOIN funds f ON f.id=h.fund_id AND f.is_active
  LEFT JOIN fund_share_classes sc ON sc.fund_id=f.id
  LEFT JOIN fund_master fm ON fm.id=sc.master_fund_id
  WHERE h.asset_type='FUND' AND h.as_of_date<=CURRENT_DATE AND h.source IS NOT NULL
  GROUP BY coalesce(sc.master_fund_id,f.id),f.id,f.code,f.name,h.as_of_date,h.source,h.filing_id,fm.representative_fund_id,fm.canonical_name
), fund_latest AS MATERIALIZED (
  SELECT DISTINCT ON(portfolio) * FROM fund_batches
  ORDER BY portfolio,effective_date DESC NULLS LAST,as_of_date DESC,representative DESC NULLS LAST,row_count DESC,source,fund_id,filing_id
), positions AS (
  SELECT e.product_key,e.code,e.name,'ETF' type,e.code asset_id,e.snapshot_id::text snapshot_id,
    e.effective_date::text date,e.source,e.completeness_status coverage,t.id stock_id,t.ticker,h.holding_name,h.weight
  FROM etf_latest e JOIN etf_holdings h ON h.snapshot_id=e.snapshot_id
  LEFT JOIN securities hs ON hs.id=h.security_id
  JOIN targets t ON ${matchSQL('h.ticker', countrySQL('h.country'))}
  WHERE h.holding_type IN ('EQUITY','SECURITY') AND coalesce(h.asset_class,'EQUITY') IN ('EQUITY','STOCK','COMMON_STOCK')
    AND h.holding_name !~* '(swap|future|option|cfd|derivative|期貨|選擇權|交換)'
    AND (h.weight IS NULL OR h.weight BETWEEN 0 AND 100) AND (h.quantity IS NULL OR h.quantity>=0)
    AND coalesce(h.raw_row->>'assetCategory','') NOT IN ('DERV','FUT','SWAP','OPT')
    AND NOT (h.holding_type='SECURITY' AND h.quantity IS NULL AND
      (concat_ws(' ',e.name,e.category) ~* '(leverag|inverse|short|[2-9]x|options?|synthetic|槓桿|反向)' OR h.holding_name ~* '(clear street|swap|cfd)'))
  UNION ALL
  SELECT 'FUND:'||f.portfolio,coalesce(f.code,f.fund_id),f.display_name,'基金',f.fund_id,
    concat_ws(':',f.fund_id,f.as_of_date,f.source,f.filing_id),f.effective_date::text,f.source,'DISCLOSED_HOLDINGS',t.id,t.ticker,h.holding_name,
    CASE WHEN h.source='YAHOO_QUOTE_SUMMARY' THEN h.weight*100 ELSE h.weight END
  FROM fund_latest f JOIN holdings h ON h.fund_id=f.fund_id AND h.as_of_date=f.as_of_date AND h.source=f.source AND h.filing_id IS NOT DISTINCT FROM f.filing_id AND h.asset_type='FUND'
  LEFT JOIN securities hs ON hs.id=h.security_id
  JOIN targets t ON ${matchSQL('coalesce(h.ticker,h.holding_code)',countrySQL("coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END)"))}
  WHERE h.holding_name !~* '(swap|future|option|cfd|derivative|期貨|選擇權|交換)' AND h.weight BETWEEN 0 AND 100
), unique_positions AS (
  SELECT DISTINCT ON(product_key,stock_id,holding_name,weight) * FROM positions
  ORDER BY product_key,stock_id,holding_name,weight
)
SELECT product_key,code,name,type,asset_id,snapshot_id,date,source,coverage,stock_id,ticker,
  min(holding_name) holding_name,sum(weight)::text weight
FROM unique_positions GROUP BY product_key,code,name,type,asset_id,snapshot_id,date,source,coverage,stock_id,ticker`;

export async function reverseHoldings(query: Query, input: { tickers: string[]; market?: string; page?: number; limit?: number; type?: string }) {
  const requested = [...new Set(input.tickers.map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (!requested.length || requested.length>10) throw new Error('INVALID_TICKERS');
  paginate([],input.page,input.limit,input.type);
  const targets = await resolveTargets(query,requested,input.market ?? '');
  const products = rankProducts(await query<MatchRow>(reverseSQL,JSON.stringify(targets)));
  const page = paginate(products,input.page,input.limit,input.type);
  return { ok: true, ...page, tickers: targets.map(t=>t.ticker), generated_at:new Date().toISOString(),
    etf_total_products:products.filter(p=>p.type==='ETF').length, fund_total_products:products.filter(p=>p.type==='基金').length,
    unmatched_tickers:targets.filter(t=>!products.some(p=>p.holdings.some(h=>h.securityKey===t.id))).map(t=>t.ticker),
    etfs:page.results.filter(p=>p.type==='ETF'), funds:page.results.filter(p=>p.type==='基金') };
}
