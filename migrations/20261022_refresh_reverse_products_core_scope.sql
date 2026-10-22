-- 2026-10-22（使用者核准，第一條永久規則：只處理台灣買得到的四類核心母體）: refresh_reverse_products()
-- 只有兩處改動（其餘SQL逐字不變，對照20261022_refresh_reverse_products_rollback.sql可完整比對差異）：
--   1) etf_products CTE：加上tw_purchasable_classification(asset_type='ETF', status='APPROVED')篩選。
--   2) fund_batches CTE：加上tw_purchasable_classification(asset_type='FUND', status='APPROVED')篩選，
--      包含fund_keys比對用的內層子查詢也一併加上。
-- 行為變更：etf_keys／fund_keys為NULL時，原本代表「處理全部」，現在改成「不處理任何商品」——
-- 符合新的永久規則，沒有任何正當呼叫方式應該要「不帶key就刷新全部範圍外商品」。目前唯一的
-- 呼叫方（holdings表的trigger鏈）本來就一定會傳入實際的key，不受這個行為變更影響。
-- 回復方式：執行同目錄下的 20261022_refresh_reverse_products_rollback.sql（保留原始定義不動）。

CREATE OR REPLACE FUNCTION public.refresh_reverse_products(etf_keys text[], fund_keys text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET jit TO 'off'
AS $function$
DECLARE k text;stock_ids text[];
BEGIN
 FOR k IN SELECT unnest(coalesce(etf_keys,'{}')||coalesce(fund_keys,'{}')) ORDER BY 1 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('reverse-product:'||k,0));
 END LOOP;
 IF cardinality(etf_keys)>0 THEN
   SELECT array_agg(DISTINCT stock_id) INTO stock_ids FROM (
     SELECT l.stock_id FROM etfs e JOIN etf_holdings h ON h.etf_id=e.id JOIN stock_security_links l ON l.security_id=h.security_id
     WHERE (CASE WHEN e.code ~ '\.(TW|TWO)$' OR coalesce(e.region,'') IN ('TW','Taiwan','TPEx') OR coalesce(e.exchange,'') IN ('TWSE','TPEx','TPEX','Taiwan') THEN 'ETF:TW:'||regexp_replace(e.code,'\.(TW|TWO)$','') ELSE 'ETF:'||coalesce(nullif(e.isin,''),coalesce(e.exchange,'')||':'||e.code) END)=ANY(etf_keys) AND l.verification_status LIKE 'VERIFIED%'
     UNION SELECT stock_id FROM reverse_current_positions WHERE product_key=ANY(etf_keys)
   ) affected;
   IF cardinality(stock_ids)>0 THEN PERFORM refresh_reverse_securities(stock_ids); END IF;
 END IF;
 DELETE FROM reverse_current_positions WHERE
 (type='ETF' AND (etf_keys IS NULL OR product_key=ANY(etf_keys))) OR
 (type='基金' AND (fund_keys IS NULL OR product_key=ANY(ARRAY(SELECT 'FUND:'||unnest(fund_keys)))));
 INSERT INTO reverse_current_positions WITH targets AS NOT MATERIALIZED (
  SELECT * FROM reverse_current_securities
), etf_products AS (
  SELECT e.*, CASE WHEN e.code ~ '\.(TW|TWO)$' OR coalesce(e.region,'') IN ('TW','Taiwan','TPEx') OR coalesce(e.exchange,'') IN ('TWSE','TPEx','TPEX','Taiwan')
    THEN 'ETF:TW:'||regexp_replace(e.code,'\.(TW|TWO)$','')
    ELSE 'ETF:'||coalesce(nullif(e.isin,''),coalesce(e.exchange,'')||':'||e.code) END product_key
  FROM etfs e WHERE e.is_active
    AND e.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='ETF' AND status='APPROVED')
    AND etf_keys IS NOT NULL AND (CASE WHEN e.code ~ '\.(TW|TWO)$' OR coalesce(e.region,'') IN ('TW','Taiwan','TPEx') OR coalesce(e.exchange,'') IN ('TWSE','TPEx','TPEX','Taiwan') THEN 'ETF:TW:'||regexp_replace(e.code,'\.(TW|TWO)$','') ELSE 'ETF:'||coalesce(nullif(e.isin,''),coalesce(e.exchange,'')||':'||e.code) END)=ANY(etf_keys)
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
  WHERE fund_keys IS NOT NULL AND h.fund_id=ANY(ARRAY(
        SELECT f2.id FROM funds f2 LEFT JOIN fund_share_classes sc2 ON sc2.fund_id=f2.id
        WHERE coalesce(sc2.master_fund_id,f2.id)=ANY(fund_keys)
          AND f2.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='FUND' AND status='APPROVED')
      ))
    AND f.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='FUND' AND status='APPROVED')
    AND h.asset_type='FUND' AND h.as_of_date<=CURRENT_DATE AND h.source IS NOT NULL
  GROUP BY coalesce(sc.master_fund_id,f.id),f.id,f.code,f.name,h.as_of_date,h.source,h.filing_id,fm.representative_fund_id,fm.canonical_name
), fund_latest AS MATERIALIZED (
  SELECT DISTINCT ON(portfolio) * FROM fund_batches
  ORDER BY portfolio,effective_date DESC NULLS LAST,as_of_date DESC,representative DESC NULLS LAST,row_count DESC,source,fund_id,filing_id
), positions AS (
  SELECT e.product_key,e.code,e.name,'ETF' type,e.code asset_id,e.snapshot_id::text snapshot_id,
    e.effective_date::text date,e.source,e.completeness_status coverage,t.id stock_id,t.ticker,h.holding_name,h.weight
  FROM etf_latest e JOIN etf_holdings h ON h.snapshot_id=e.snapshot_id
  LEFT JOIN securities hs ON hs.id=h.security_id
  JOIN LATERAL (
 SELECT id FROM targets WHERE h.security_id IS NOT NULL AND security_ids @> ARRAY[h.security_id]
 UNION SELECT id FROM targets WHERE nullif(h.ticker,'') IS NOT NULL AND ticker=upper(h.ticker)
 UNION SELECT id FROM targets WHERE nullif(h.ticker,'') IS NOT NULL AND bare=upper(h.ticker)
 UNION SELECT id FROM targets WHERE nullif(h.ticker,'') IS NULL AND names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]
 UNION SELECT id FROM targets WHERE nullif(h.ticker,'') IS NULL AND unique_names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]
) candidate ON true JOIN targets t ON t.id=candidate.id AND (
  (h.security_id IS NOT NULL AND t.security_ids @> ARRAY[h.security_id] AND (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END='' OR CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END=t.country))
  OR ((h.security_id IS NULL OR hs.id IS NULL OR (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END<>'' AND CASE upper(coalesce(hs.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(hs.country,'')) END<>'' AND CASE upper(coalesce(hs.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(hs.country,'')) END<>CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END)) AND (
    (upper(h.ticker)=t.ticker AND (t.ticker<>t.bare OR CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END='' OR CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END=t.country))
    OR (upper(h.ticker)=t.bare AND (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END=t.country OR (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END='' AND t.bare_unique)))
    OR (nullif(h.ticker,'') IS NULL AND (
      (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END=t.country AND t.names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))])
      OR (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END='' AND t.unique_names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))])))
  )))
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
  JOIN LATERAL (
 SELECT id FROM targets WHERE h.security_id IS NOT NULL AND security_ids @> ARRAY[h.security_id]
 UNION SELECT id FROM targets WHERE nullif(coalesce(h.ticker,h.holding_code),'') IS NOT NULL AND ticker=upper(coalesce(h.ticker,h.holding_code))
 UNION SELECT id FROM targets WHERE nullif(coalesce(h.ticker,h.holding_code),'') IS NOT NULL AND bare=upper(coalesce(h.ticker,h.holding_code))
 UNION SELECT id FROM targets WHERE nullif(coalesce(h.ticker,h.holding_code),'') IS NULL AND names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]
 UNION SELECT id FROM targets WHERE nullif(coalesce(h.ticker,h.holding_code),'') IS NULL AND unique_names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]
) candidate ON true JOIN targets t ON t.id=candidate.id AND (
  (h.security_id IS NOT NULL AND t.security_ids @> ARRAY[h.security_id] AND (CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END='' OR CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END=t.country))
  OR ((h.security_id IS NULL OR hs.id IS NULL OR (CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END<>'' AND CASE upper(coalesce(hs.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(hs.country,'')) END<>'' AND CASE upper(coalesce(hs.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(hs.country,'')) END<>CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END)) AND (
    (upper(coalesce(h.ticker,h.holding_code))=t.ticker AND (t.ticker<>t.bare OR CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END='' OR CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END=t.country))
    OR (upper(coalesce(h.ticker,h.holding_code))=t.bare AND (CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END=t.country OR (CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END='' AND t.bare_unique)))
    OR (nullif(coalesce(h.ticker,h.holding_code),'') IS NULL AND (
      (CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END=t.country AND t.names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))])
      OR (CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END='' AND t.unique_names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))])))
  )))
  WHERE h.holding_name !~* '(swap|future|option|cfd|derivative|期貨|選擇權|交換)' AND h.weight BETWEEN 0 AND 100
), unique_positions AS (
  SELECT DISTINCT ON(product_key,stock_id,holding_name,weight) * FROM positions
  ORDER BY product_key,stock_id,holding_name,weight
)
SELECT product_key,code,name,type,asset_id,snapshot_id,date,source,coverage,stock_id,ticker,
  min(holding_name) holding_name,sum(weight) weight
FROM unique_positions GROUP BY product_key,code,name,type,asset_id,snapshot_id,date,source,coverage,stock_id,ticker;
END $function$

