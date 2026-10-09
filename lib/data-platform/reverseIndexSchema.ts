import { reverseSQL } from './reverseHoldings';

// Reuses the audited canonical selection/matching SQL. This is a read projection,
// never a second holdings source. Only affected normalized products are replaced.
const normalizedETF = `CASE WHEN e.code ~ '\\.(TW|TWO)$' OR coalesce(e.region,'') IN ('TW','Taiwan','TPEx') OR coalesce(e.exchange,'') IN ('TWSE','TPEx','TPEX','Taiwan') THEN 'ETF:TW:'||regexp_replace(e.code,'\\.(TW|TWO)$','') ELSE 'ETF:'||coalesce(nullif(e.isin,''),coalesce(e.exchange,'')||':'||e.code) END`;
const securities = `WITH active AS MATERIALIZED (
 SELECT id,upper(yahoo_symbol) ticker,country,exchange,company_name name,company_name_zh,
 regexp_replace(upper(yahoo_symbol),'\\.[A-Z]+$','') bare,
 count(*) OVER(PARTITION BY regexp_replace(upper(yahoo_symbol),'\\.[A-Z]+$',''))=1 bare_unique FROM stocks WHERE is_active
), links AS MATERIALIZED (
 SELECT l.stock_id,l.security_id,q.name,q.name_en FROM stock_security_links l JOIN securities q ON q.id=l.security_id WHERE l.verification_status LIKE 'VERIFIED%'
), identity_names AS MATERIALIZED (
 SELECT id stock_id,lower(regexp_replace(n,'[^[:alnum:]]','','g')) n FROM active CROSS JOIN LATERAL unnest(ARRAY[name,company_name_zh]) n
 UNION SELECT stock_id,lower(regexp_replace(n,'[^[:alnum:]]','','g')) FROM links CROSS JOIN LATERAL unnest(ARRAY[name,name_en]) n
), aliases AS MATERIALIZED (
 SELECT * FROM identity_names WHERE stock_ids IS NULL OR stock_id=ANY(stock_ids)
 UNION SELECT l.stock_id,lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g')) FROM etf_holdings h JOIN links l ON l.security_id=h.security_id JOIN active a ON a.id=l.stock_id
 WHERE (stock_ids IS NULL OR a.id=ANY(stock_ids)) AND h.holding_type='EQUITY' AND CASE upper(coalesce(h.country,'')) WHEN 'TAIWAN' THEN 'TW' WHEN '台灣' THEN 'TW' WHEN 'CHINA' THEN 'CN' WHEN '中國' THEN 'CN' WHEN 'HONG KONG' THEN 'HK' WHEN '香港' THEN 'HK' WHEN 'UNITED STATES' THEN 'US' WHEN '美國' THEN 'US' WHEN 'JAPAN' THEN 'JP' WHEN '日本' THEN 'JP' WHEN 'SOUTH KOREA' THEN 'KR' WHEN '韓國' THEN 'KR' WHEN 'NETHERLANDS' THEN 'NL' ELSE upper(coalesce(h.country,'')) END=a.country
), ambiguity AS (SELECT n,count(DISTINCT stock_id) c,min(stock_id) stock_id FROM identity_names GROUP BY n), names AS (
 SELECT a.stock_id,array_agg(DISTINCT a.n) names,
 coalesce(array_agg(DISTINCT a.n) FILTER (WHERE b.n IS NULL OR (b.c=1 AND b.stock_id=a.stock_id)),'{}') unique_names
 FROM aliases a LEFT JOIN ambiguity b ON b.n=a.n WHERE a.n IS NOT NULL AND a.n<>'' GROUP BY a.stock_id
), sec AS (SELECT stock_id,array_agg(DISTINCT security_id) security_ids FROM links GROUP BY stock_id)
SELECT a.id,a.ticker,a.country,a.exchange,a.name,a.bare,a.bare_unique,
 coalesce(s.security_ids,'{}') security_ids,coalesce(n.names,'{}') names,coalesce(n.unique_names,'{}') unique_names
FROM active a LEFT JOIN sec s ON s.stock_id=a.id LEFT JOIN names n ON n.stock_id=a.id
WHERE stock_ids IS NULL OR a.id=ANY(stock_ids)`;

const candidateJoin = (code: string) => `JOIN LATERAL (
 SELECT id FROM targets WHERE h.security_id IS NOT NULL AND security_ids @> ARRAY[h.security_id]
 UNION SELECT id FROM targets WHERE nullif(${code},'') IS NOT NULL AND ticker=upper(${code})
 UNION SELECT id FROM targets WHERE nullif(${code},'') IS NOT NULL AND bare=upper(${code})
 UNION SELECT id FROM targets WHERE nullif(${code},'') IS NULL AND names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]
 UNION SELECT id FROM targets WHERE nullif(${code},'') IS NULL AND unique_names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]
) candidate ON true JOIN targets t ON t.id=candidate.id AND`;
export const reverseProjectionSQL = reverseSQL
  .replace('WITH targets AS (','WITH targets AS NOT MATERIALIZED (')
  .replace(/SELECT \* FROM jsonb_to_recordset\(\$1::jsonb\) AS t\([^\n]+\)/, 'SELECT * FROM reverse_current_securities')
  .replace('FROM etfs e WHERE e.is_active', () => `FROM etfs e WHERE e.is_active AND (etf_keys IS NULL OR (${normalizedETF})=ANY(etf_keys))`)
  .replace("WHERE h.asset_type='FUND' AND", "WHERE (fund_keys IS NULL OR h.fund_id=ANY(ARRAY(SELECT f2.id FROM funds f2 LEFT JOIN fund_share_classes sc2 ON sc2.fund_id=f2.id WHERE coalesce(sc2.master_fund_id,f2.id)=ANY(fund_keys)))) AND h.asset_type='FUND' AND")
  .replace(/JOIN targets t ON/g, (_match, offset: number, sql: string) => candidateJoin(offset < sql.indexOf('UNION ALL') ? 'h.ticker' : 'coalesce(h.ticker,h.holding_code)'))
  .replaceAll('h.security_id=ANY(t.security_ids)', 't.security_ids @> ARRAY[h.security_id]')
  .replaceAll("lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))=ANY(t.names)", "t.names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]")
  .replaceAll("lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))=ANY(t.unique_names)", "t.unique_names @> ARRAY[lower(regexp_replace(h.holding_name,'[^[:alnum:]]','','g'))]")
  .replace('sum(weight)::text weight','sum(weight) weight');

export const reverseIndexSchema = `
CREATE TABLE reverse_projection_state (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),ready boolean NOT NULL DEFAULT false);
INSERT INTO reverse_projection_state(singleton) VALUES(true);
ALTER TABLE reverse_projection_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reverse_projection_state FROM PUBLIC,anon,authenticated;
CREATE TABLE reverse_current_securities AS ${securities.replaceAll('stock_ids','NULL::text[]')} WITH NO DATA;
ALTER TABLE reverse_current_securities ADD PRIMARY KEY(id);
CREATE INDEX reverse_security_ticker ON reverse_current_securities(ticker);
CREATE INDEX reverse_security_bare ON reverse_current_securities(bare,country);
CREATE INDEX reverse_security_links ON reverse_current_securities USING gin(security_ids) WITH (fastupdate=off);
CREATE INDEX reverse_security_names ON reverse_current_securities USING gin(names) WITH (fastupdate=off);
CREATE INDEX reverse_security_unique_names ON reverse_current_securities USING gin(unique_names) WITH (fastupdate=off);
CREATE TABLE reverse_current_positions (
 product_key text NOT NULL,code text NOT NULL,name text,type text NOT NULL,asset_id text,snapshot_id text NOT NULL,
 date text,source text,coverage text,stock_id text NOT NULL,ticker text,holding_name text,weight numeric,
 PRIMARY KEY(stock_id,product_key)
);
CREATE INDEX reverse_positions_security_type_weight ON reverse_current_positions(stock_id,type,weight DESC,product_key);
CREATE INDEX reverse_positions_security_weight ON reverse_current_positions(stock_id,weight DESC,product_key);
CREATE INDEX reverse_positions_product ON reverse_current_positions(product_key);
ALTER TABLE reverse_current_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reverse_current_securities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reverse_current_positions,reverse_current_securities FROM PUBLIC,anon,authenticated;
CREATE FUNCTION refresh_reverse_securities(stock_ids text[] DEFAULT NULL) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp SET jit=off AS $f$
DECLARE k text;
BEGIN
 IF stock_ids IS NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('reverse-securities',0));
 ELSE FOR k IN SELECT unnest(stock_ids) ORDER BY 1 LOOP PERFORM pg_advisory_xact_lock(hashtextextended('reverse-security:'||k,0)); END LOOP; END IF;
 DELETE FROM reverse_current_securities WHERE stock_ids IS NULL OR id=ANY(stock_ids);
 INSERT INTO reverse_current_securities ${securities};
END $f$;
CREATE FUNCTION refresh_reverse_products(etf_keys text[],fund_keys text[]) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp SET jit=off AS $f$
DECLARE k text;stock_ids text[];
BEGIN
 FOR k IN SELECT unnest(coalesce(etf_keys,'{}')||coalesce(fund_keys,'{}')) ORDER BY 1 LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended('reverse-product:'||k,0));
 END LOOP;
 IF cardinality(etf_keys)>0 THEN
   SELECT array_agg(DISTINCT stock_id) INTO stock_ids FROM (
     SELECT l.stock_id FROM etfs e JOIN etf_holdings h ON h.etf_id=e.id JOIN stock_security_links l ON l.security_id=h.security_id
     WHERE (${normalizedETF})=ANY(etf_keys) AND l.verification_status LIKE 'VERIFIED%'
     UNION SELECT stock_id FROM reverse_current_positions WHERE product_key=ANY(etf_keys)
   ) affected;
   IF cardinality(stock_ids)>0 THEN PERFORM refresh_reverse_securities(stock_ids); END IF;
 END IF;
 DELETE FROM reverse_current_positions WHERE
 (type='ETF' AND (etf_keys IS NULL OR product_key=ANY(etf_keys))) OR
 (type='基金' AND (fund_keys IS NULL OR product_key=ANY(ARRAY(SELECT 'FUND:'||unnest(fund_keys)))));
 INSERT INTO reverse_current_positions ${reverseProjectionSQL};
END $f$;
REVOKE ALL ON FUNCTION refresh_reverse_products(text[],text[]),refresh_reverse_securities(text[]) FROM PUBLIC,anon,authenticated;
`;

/** Deferred, transaction-local dirty set: many position writes become one product refresh. */
export const reverseIndexIncremental = `
CREATE TABLE reverse_refresh_queue (tx bigint NOT NULL,kind text NOT NULL,product_key text NOT NULL,PRIMARY KEY(tx,kind,product_key));
ALTER TABLE reverse_refresh_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON reverse_refresh_queue FROM PUBLIC,anon,authenticated;
CREATE FUNCTION enqueue_reverse_products() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $f$
DECLARE rowset text; keys_sql text;
BEGIN
 FOR rowset IN SELECT unnest(CASE TG_OP WHEN 'INSERT' THEN ARRAY['new_rows'] WHEN 'DELETE' THEN ARRAY['old_rows'] ELSE ARRAY['new_rows','old_rows'] END) LOOP
   IF TG_TABLE_NAME='holdings' THEN
     keys_sql := 'SELECT DISTINCT coalesce(sc.master_fund_id,h.fund_id) FROM '||rowset||' h LEFT JOIN fund_share_classes sc ON sc.fund_id=h.fund_id WHERE h.asset_type=''FUND''';
     EXECUTE 'INSERT INTO reverse_refresh_queue SELECT txid_current(),''FUND'',k FROM ('||keys_sql||') AS keys(k) WHERE k IS NOT NULL ON CONFLICT DO NOTHING';
   ELSE
     keys_sql := 'SELECT DISTINCT ${normalizedETF.replaceAll("'", "''")} FROM etfs e JOIN '||rowset||' h ON e.id=h.etf_id';
     EXECUTE 'INSERT INTO reverse_refresh_queue SELECT txid_current(),''ETF'',k FROM ('||keys_sql||') AS keys(k) WHERE k IS NOT NULL ON CONFLICT DO NOTHING';
   END IF;
 END LOOP;
 RETURN NULL;
END $f$;
CREATE FUNCTION flush_reverse_products() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $f$
DECLARE etf_keys text[];fund_keys text[];
BEGIN
 IF NOT EXISTS(SELECT 1 FROM reverse_projection_state WHERE ready) THEN RETURN NULL; END IF;
 SELECT coalesce(array_agg(product_key) FILTER(WHERE kind='ETF'),'{}'),coalesce(array_agg(product_key) FILTER(WHERE kind='FUND'),'{}') INTO etf_keys,fund_keys FROM reverse_refresh_queue WHERE tx=txid_current();
 IF cardinality(etf_keys)+cardinality(fund_keys)=0 THEN RETURN NULL; END IF;
 PERFORM refresh_reverse_products(etf_keys,fund_keys);
 DELETE FROM reverse_refresh_queue WHERE tx=txid_current();
 RETURN NULL;
END $f$;
CREATE CONSTRAINT TRIGGER reverse_flush AFTER INSERT ON reverse_refresh_queue DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flush_reverse_products();
${['holdings','etf_holdings','etf_holding_snapshots'].flatMap(table=>[
 `CREATE TRIGGER reverse_insert AFTER INSERT ON ${table} REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION enqueue_reverse_products();`,
 `CREATE TRIGGER reverse_update AFTER UPDATE ON ${table} REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION enqueue_reverse_products();`,
 `CREATE TRIGGER reverse_delete AFTER DELETE ON ${table} REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION enqueue_reverse_products();`,
]).join('\n')}
REVOKE ALL ON FUNCTION enqueue_reverse_products(),flush_reverse_products() FROM PUBLIC,anon,authenticated;
`;
