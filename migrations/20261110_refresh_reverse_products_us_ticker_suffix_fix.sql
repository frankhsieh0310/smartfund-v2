CREATE OR REPLACE FUNCTION public.refresh_reverse_products(etf_keys text[], fund_keys text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET jit TO 'off'
AS $function$
DECLARE k text;stock_ids text[];
BEGIN
 -- 2026-11-10（事故防呆，第二次事故後使用者核准定案）: etf_keys/fund_keys任一個傳NULL，DELETE
 -- 子句原本的 (etf_keys IS NULL OR ...) 寫法會比對整個type、INSERT候選卻要求 etf_keys IS NOT
 -- NULL才選得到任何候選——等於清空整個type、不寫回。這個NULL語意從來沒有被INSERT端支援過，
 -- 不是一個合法的「全量重建」方式。全量重建要明確傳入全部已核准product_key的完整陣列（呼叫端
 -- 自己組出清單），不要用NULL。直接擋掉，絕不吞掉。
 IF etf_keys IS NULL OR fund_keys IS NULL THEN
   RAISE EXCEPTION 'refresh_reverse_products: etf_keys and fund_keys must not be NULL (NULL on either side deletes all rows of that type and reinserts none — this caused the 2026-10-24 and 2026-11-10 incidents). Pass ARRAY[]::text[] to touch nothing, or the full list of approved product_keys for a full rebuild.';
 END IF;
 FOR k IN SELECT unnest(coalesce(etf_keys,'{}')||coalesce(fund_keys,'{}')) ORDER BY 1 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('reverse-product:'||k,0));
 END LOOP;
 -- 2026-11-08（第36輪第二點丙核准，第一次全量更新發現並修正）: 第一版只改成讀 holdings 表，
 -- 讓66檔全球/美股ETF（只在舊表 etf_holding_snapshots 有資料、沒有同步到 holdings）的筆數
 -- 直接變成0，被丙項的安全檢查擋下、自動復原。改成兩條管線並存：台股ETF holdings 表有資料
 -- 就優先用它（比舊表新、才是真正的根因修正對象）；holdings 表沒有資料的（主要是全球/美股ETF）
 -- 繼續用舊表 etf_holding_snapshots，不受影響。
 IF cardinality(etf_keys)>0 THEN
   SELECT array_agg(DISTINCT stock_id) INTO stock_ids FROM (
     SELECT l.stock_id FROM etfs e JOIN holdings h ON h.etf_id=e.id AND h.asset_type='ETF' JOIN stock_security_links l ON l.security_id=h.security_id
     WHERE (CASE WHEN e.code ~ '\.(TW|TWO)$' OR coalesce(e.region,'') IN ('TW','Taiwan','TPEx') OR coalesce(e.exchange,'') IN ('TWSE','TPEx','TPEX','Taiwan') THEN 'ETF:TW:'||regexp_replace(e.code,'\.(TW|TWO)$','') ELSE 'ETF:'||coalesce(nullif(e.isin,''),coalesce(e.exchange,'')||':'||e.code) END)=ANY(etf_keys) AND l.verification_status LIKE 'VERIFIED%'
     UNION SELECT l.stock_id FROM etfs e JOIN etf_holdings h ON h.etf_id=e.id JOIN stock_security_links l ON l.security_id=h.security_id
     WHERE (CASE WHEN e.code ~ '\.(TW|TWO)$' OR coalesce(e.region,'') IN ('TW','Taiwan','TPEx') OR coalesce(e.exchange,'') IN ('TWSE','TPEx','TPEX','Taiwan') THEN 'ETF:TW:'||regexp_replace(e.code,'\.(TW|TWO)$','') ELSE 'ETF:'||coalesce(nullif(e.isin,''),coalesce(e.exchange,'')||':'||e.code) END)=ANY(etf_keys) AND l.verification_status LIKE 'VERIFIED%'
     UNION SELECT stock_id FROM reverse_current_positions WHERE product_key=ANY(etf_keys)
   ) affected;
   IF cardinality(stock_ids)>0 THEN PERFORM refresh_reverse_securities(stock_ids); END IF;
 END IF;
 DELETE FROM reverse_current_positions WHERE
 (type='ETF' AND product_key=ANY(etf_keys)) OR
 (type='基金' AND product_key=ANY(ARRAY(SELECT 'FUND:'||unnest(fund_keys))));
 INSERT INTO reverse_current_positions WITH targets AS NOT MATERIALIZED (
  SELECT * FROM reverse_current_securities
), etf_products AS (
  SELECT e.*, CASE WHEN e.code ~ '\.(TW|TWO)$' OR coalesce(e.region,'') IN ('TW','Taiwan','TPEx') OR coalesce(e.exchange,'') IN ('TWSE','TPEx','TPEX','Taiwan')
    THEN 'ETF:TW:'||regexp_replace(e.code,'\.(TW|TWO)$','')
    ELSE 'ETF:'||coalesce(nullif(e.isin,''),coalesce(e.exchange,'')||':'||e.code) END product_key
  FROM etfs e WHERE e.is_active
    AND e.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='ETF' AND status='APPROVED')
    AND etf_keys IS NOT NULL AND (CASE WHEN e.code ~ '\.(TW|TWO)$' OR coalesce(e.region,'') IN ('TW','Taiwan','TPEx') OR coalesce(e.exchange,'') IN ('TWSE','TPEx','TPEX','Taiwan') THEN 'ETF:TW:'||regexp_replace(e.code,'\.(TW|TWO)$','') ELSE 'ETF:'||coalesce(nullif(e.isin,''),coalesce(e.exchange,'')||':'||e.code) END)=ANY(etf_keys)
-- 新管線（holdings 表）候選：每個 product_key 自己的最新 as_of_date。限定 product_key 一定要是
-- 'ETF:TW:' 開頭（台股掛牌的ETF），排除像 ETF:Cboe US:EUHY 這種非台股ETF卻剛好在holdings表
-- 有雜散資料的情況。
), etf_latest_new AS MATERIALIZED (
  SELECT DISTINCT ON(ep.product_key) ep.product_key,ep.code,ep.name,ep.category,ep.id etf_id,
    h.as_of_date::text snapshot_id,h.as_of_date effective_date,h.source,'HOLDINGS_TABLE' completeness_status
  FROM etf_products ep JOIN holdings h ON h.etf_id=ep.id AND h.asset_type='ETF'
  WHERE h.as_of_date IS NOT NULL AND h.as_of_date<=CURRENT_DATE
    AND ep.product_key LIKE 'ETF:TW:%'
  ORDER BY ep.product_key,h.as_of_date DESC
-- 舊管線（etf_holding_snapshots）候選，完全沿用原本的條件——全球/美股ETF還靠這條，不能拿掉。
), etf_latest_old AS MATERIALIZED (
  SELECT DISTINCT ON(e.product_key) e.product_key,e.code,e.name,e.category,e.id etf_id,s.id::text snapshot_id,s.effective_date,s.source,s.completeness_status
  FROM etf_products e JOIN etf_holding_snapshots s ON s.etf_id=e.id
  WHERE (s.effective_date<=CURRENT_DATE OR (s.effective_date IS NULL AND s.source_type='PROVIDER_OBSERVATION'))
    AND s.verification_status IN ('COMPLETE','SOURCE_VERIFIED','SOURCE_PARSED')
    AND s.completeness_status IN ('COMPLETE','TOP_HOLDINGS_ONLY')
    AND s.quality_status NOT IN ('FAILED','INVALID','REJECTED')
    AND s.canonical_row_count=s.parsed_row_count
  ORDER BY e.product_key,s.effective_date DESC NULLS LAST,
    (s.completeness_status='COMPLETE') DESC,s.retrieved_at DESC,s.id
-- 2026-11-08 VERIFIED（第四次全量更新又發現一個邊界案例「群益深証中小」——holdings.country
-- 固定寫死'TW'，但這檔持有的是深圳掛牌的中國股票）: 用ETF名稱關鍵字排除境外持股ETF這個做法
-- 一直抓不完（陸股/港股ETF命名方式太多種），改成直接「試算」新管線在這個target集合下實際配對
-- 得到幾筆——配對數太少（<3筆，用來判斷「這檔的持股根本配不到台股目標」）就不用新管線，不管
-- 名稱長怎樣，從根本解決，不用再猜關鍵字。
), etf_latest_new_trial_count AS MATERIALIZED (
  SELECT n.product_key, count(*) matched_count
  FROM etf_latest_new n
  JOIN holdings h ON h.etf_id=n.etf_id AND h.as_of_date=n.effective_date AND h.asset_type='ETF'
  JOIN LATERAL (
    SELECT id FROM targets WHERE nullif(h.ticker,'') IS NOT NULL AND bare=regexp_replace(upper(h.ticker),'\.US$','') AND country=upper(coalesce(h.country,'TW'))
    UNION SELECT id FROM targets WHERE nullif(h.ticker,'') IS NULL AND names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))] AND country=upper(coalesce(h.country,'TW'))
  ) candidate ON true
  WHERE h.shares IS NOT NULL
  GROUP BY n.product_key
-- 兩條管線都有資料的ETF，每個product_key只選一條——新管線試算配對數>=3筆、而且（舊管線沒有資料
-- 或新管線日期比舊管線新）才用新管線；否則（主要是全球/美股ETF、或holdings表資料配不到台股
-- 目標的境外持股ETF）用舊管線，維持原本行為不受影響。
), etf_latest_choice AS MATERIALIZED (
  SELECT product_key, CASE WHEN n.etf_id IS NOT NULL AND coalesce(tc.matched_count,0)>=3 AND (o.etf_id IS NULL OR n.effective_date > o.effective_date) THEN 'NEW' ELSE 'OLD' END AS pick
  FROM (SELECT product_key FROM etf_latest_new UNION SELECT product_key FROM etf_latest_old) k
  LEFT JOIN etf_latest_new n USING(product_key)
  LEFT JOIN etf_latest_old o USING(product_key)
  LEFT JOIN etf_latest_new_trial_count tc USING(product_key)
), etf_latest AS MATERIALIZED (
  SELECT n.* FROM etf_latest_new n JOIN etf_latest_choice c ON c.product_key=n.product_key AND c.pick='NEW'
  UNION ALL
  SELECT o.* FROM etf_latest_old o JOIN etf_latest_choice c ON c.product_key=o.product_key AND c.pick='OLD'
-- 2026-11-10（使用者核准，ETF/基金重複商品去重）: 上市ETF在SITCA也有一份法定基金揭露
-- （同一商品的fund_duplicate_of_etf已存在、323筆，原本只用在基金列表/搜尋頁去重，持股反查/
-- 穿透分析/持有檔數從未套用）。這裡在fund_batches的候選篩選加排除，讓這些fund_id完全不會
-- 進入基金側的候選，只保留ETF側（用更新的揭露日期那份），避免同一商品ETF+基金各算一次。
-- 2026-11-10（上架前審查第3項，使用者核准，00903富邦元宇宙等全球持股ETF反查資料全無）:
-- MONEYDJ_ETF_PUBLIC/CATHAY_OFFICIAL兩個來源寫入etf_holdings/holdings時，美股ticker帶了多餘的
-- ".US"字尾（例如"AAPL.US"），但這個schema的慣例是美股ticker本來就不帶字尾（country=US,
-- ticker=bare，字尾只用在非美股市場如.TW/.TO/.HK/.SW區分）——所有h.ticker比對都先用
-- regexp_replace去掉這個字尾再比對，不影響本來就沒有這個字尾的ticker。VERIFIED全庫共11,536
-- (etf_holdings) + 593 (holdings)筆受影響，不只00903一檔。
), fund_batches AS (
  SELECT coalesce(sc.master_fund_id,f.id) portfolio,f.id fund_id,f.code,f.name,
    h.as_of_date,CASE WHEN h.source='YAHOO_QUOTE_SUMMARY' THEN NULL ELSE h.as_of_date END effective_date,h.source,h.filing_id,count(*) row_count,
    (f.id=fm.representative_fund_id) representative,coalesce(fm.canonical_name,f.name) display_name,f.category
  FROM holdings h JOIN funds f ON f.id=h.fund_id AND f.is_active
  LEFT JOIN fund_share_classes sc ON sc.fund_id=f.id
  LEFT JOIN fund_master fm ON fm.id=sc.master_fund_id
  WHERE fund_keys IS NOT NULL AND h.fund_id=ANY(ARRAY(
        SELECT f2.id FROM funds f2 LEFT JOIN fund_share_classes sc2 ON sc2.fund_id=f2.id
        WHERE coalesce(sc2.master_fund_id,f2.id)=ANY(fund_keys)
          AND f2.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='FUND' AND status='APPROVED')
      ))
    AND f.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='FUND' AND status='APPROVED')
    AND f.id NOT IN (SELECT fund_id FROM fund_duplicate_of_etf)
    AND h.asset_type='FUND' AND h.as_of_date<=CURRENT_DATE AND h.source IS NOT NULL
    AND h.id NOT IN (SELECT holding_id FROM holdings_quarantine)
  GROUP BY coalesce(sc.master_fund_id,f.id),f.id,f.code,f.name,h.as_of_date,h.source,h.filing_id,fm.representative_fund_id,fm.canonical_name,f.category
), fund_latest AS MATERIALIZED (
  SELECT DISTINCT ON(portfolio) * FROM fund_batches
  ORDER BY portfolio,effective_date DESC NULLS LAST,as_of_date DESC,representative DESC NULLS LAST,row_count DESC,source,fund_id,filing_id
), positions AS (
  -- ETF／新管線（holdings 表）：country 欄位這個同步程式固定寫'TW'，只用 bare+country 比對
  -- （詳見先前針對0050的驗證紀錄：security_id 欄位本身不可信，裸代碼跨市場撞號）。
  SELECT e.product_key,e.code,e.name,'ETF' type,e.code asset_id,e.snapshot_id,
    e.effective_date::text date,e.source,e.completeness_status coverage,t.id stock_id,t.ticker,h.holding_name,h.weight
  FROM etf_latest e JOIN holdings h ON h.etf_id=e.etf_id AND h.as_of_date=e.effective_date AND h.asset_type='ETF'
  JOIN LATERAL (
    SELECT id FROM targets WHERE nullif(h.ticker,'') IS NOT NULL AND bare=regexp_replace(upper(h.ticker),'\.US$','') AND country=upper(coalesce(h.country,'TW'))
    UNION SELECT id FROM targets WHERE nullif(h.ticker,'') IS NULL AND names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))] AND country=upper(coalesce(h.country,'TW'))
  ) candidate ON true
  JOIN targets t ON t.id=candidate.id
  WHERE h.shares IS NOT NULL
    AND h.holding_name !~* '(swap|future|option|cfd|derivative|期貨|選擇權|交換)' AND h.holding_name !~ '[0-9]%' AND coalesce(e.category,'') !~* 'bond'
    AND (h.weight IS NULL OR h.weight BETWEEN 0 AND 100)
  UNION ALL
  -- ETF／舊管線（etf_holding_snapshots）：完全沿用原本的比對邏輯，不動——全球/美股ETF靠這條。
  SELECT e.product_key,e.code,e.name,'ETF' type,e.code asset_id,e.snapshot_id,
    e.effective_date::text date,e.source,e.completeness_status coverage,t.id stock_id,t.ticker,h.holding_name,h.weight
  FROM etf_latest e JOIN etf_holdings h ON h.snapshot_id::text=e.snapshot_id
  LEFT JOIN securities hs ON hs.id=h.security_id
  JOIN LATERAL (
 SELECT id FROM targets WHERE h.security_id IS NOT NULL AND security_ids @> ARRAY[h.security_id]
 UNION SELECT id FROM targets WHERE nullif(h.ticker,'') IS NOT NULL AND ticker=regexp_replace(upper(h.ticker),'\.US$','')
 UNION SELECT id FROM targets WHERE nullif(h.ticker,'') IS NOT NULL AND bare=regexp_replace(upper(h.ticker),'\.US$','')
 UNION SELECT id FROM targets WHERE nullif(h.ticker,'') IS NULL AND names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]
 UNION SELECT id FROM targets WHERE nullif(h.ticker,'') IS NULL AND unique_names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]
) candidate ON true JOIN targets t ON t.id=candidate.id AND (
  (h.security_id IS NOT NULL AND t.security_ids @> ARRAY[h.security_id] AND (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END='' OR CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END=t.country))
  OR ((h.security_id IS NULL OR hs.id IS NULL OR (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END<>'' AND CASE upper(coalesce(hs.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(hs.country,'')) END<>'' AND CASE upper(coalesce(hs.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(hs.country,'')) END<>CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END)) AND (
    (regexp_replace(upper(h.ticker),'\.US$','')=t.ticker AND (t.ticker<>t.bare OR CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END='' OR CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END=t.country))
    OR (regexp_replace(upper(h.ticker),'\.US$','')=t.bare AND (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END=t.country OR (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END='' AND t.bare_unique)))
    OR (nullif(h.ticker,'') IS NULL AND (
      (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END=t.country AND t.names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))])
      OR (CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END='' AND t.unique_names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))])))
  )))
  WHERE h.holding_type IN ('EQUITY','SECURITY') AND coalesce(h.asset_class,'EQUITY') IN ('EQUITY','STOCK','COMMON_STOCK')
    AND h.holding_name !~* '(swap|future|option|cfd|derivative|期貨|選擇權|交換)' AND h.holding_name !~ '[0-9]%' AND coalesce(e.category,'') !~* 'bond'
    AND (h.weight IS NULL OR h.weight BETWEEN 0 AND 100) AND (h.quantity IS NULL OR h.quantity>=0)
    AND coalesce(h.raw_row->>'assetCategory','') NOT IN ('DERV','FUT','SWAP','OPT')
    AND NOT (h.holding_type='SECURITY' AND h.quantity IS NULL AND
      (concat_ws(' ',e.name,e.category) ~* '(leverag|inverse|short|[2-9]x|options?|synthetic|槓桿|反向)' OR h.holding_name ~* '(clear street|swap|cfd)'))
  UNION ALL
  SELECT 'FUND:'||f.portfolio,coalesce(f.code,f.fund_id),f.display_name,'基金',f.fund_id,
    concat_ws(':',f.fund_id,f.as_of_date,f.source,f.filing_id),f.effective_date::text,f.source,'DISCLOSED_HOLDINGS',t.id,t.ticker,h.holding_name,
    CASE WHEN h.source='YAHOO_QUOTE_SUMMARY' THEN h.weight*100 ELSE h.weight END
  FROM fund_latest f JOIN holdings h ON h.fund_id=f.fund_id AND h.as_of_date=f.as_of_date AND h.source=f.source AND h.filing_id IS NOT DISTINCT FROM f.filing_id AND h.asset_type='FUND' AND h.id NOT IN (SELECT holding_id FROM holdings_quarantine)
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
      OR (CASE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(coalesce(h.country, CASE WHEN h.source='MONEYDJ' THEN 'TW' END),'')) END='' AND t.unique_names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]) OR (t.names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))] AND EXISTS (SELECT 1 FROM stocks st5 WHERE st5.id=t.id AND st5.yahoo_long_name IS NOT NULL AND t.country = CASE upper(coalesce(st5.yahoo_hq_country,'')) WHEN 'UNITED STATES' THEN 'US' WHEN 'GERMANY' THEN 'DE' WHEN 'NETHERLANDS' THEN 'NL' WHEN 'SWITZERLAND' THEN 'CH' WHEN 'ITALY' THEN 'IT' WHEN 'UNITED KINGDOM' THEN 'GB' WHEN 'CANADA' THEN 'CA' WHEN 'TAIWAN' THEN 'TW' WHEN 'JAPAN' THEN 'JP' WHEN 'FRANCE' THEN 'FR' WHEN 'CHINA' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN 'SOUTH KOREA' THEN 'KR' ELSE upper(coalesce(st5.yahoo_hq_country,'')) END) AND (SELECT count(DISTINCT st6.yahoo_long_name) FROM reverse_current_securities t6 JOIN stocks st6 ON st6.id=t6.id WHERE t6.names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))] AND st6.yahoo_long_name IS NOT NULL) = 1)))
  )))
  WHERE h.holding_name !~* '(swap|future|option|cfd|derivative|期貨|選擇權|交換)' AND h.weight BETWEEN 0 AND 100 AND h.holding_name !~ '[0-9]%' AND coalesce(f.category,'') !~* 'bond'
), unique_positions AS (
  SELECT DISTINCT ON(product_key,stock_id,holding_name,weight) * FROM positions
  ORDER BY product_key,stock_id,holding_name,weight
)
SELECT product_key,code,name,type,asset_id,snapshot_id,date,source,coverage,stock_id,ticker,
  min(holding_name) holding_name,sum(weight) weight
FROM unique_positions GROUP BY product_key,code,name,type,asset_id,snapshot_id,date,source,coverage,stock_id,ticker;
END $function$
