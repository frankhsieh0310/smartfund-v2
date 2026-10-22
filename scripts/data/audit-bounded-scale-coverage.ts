import { PrismaClient } from "@prisma/client";
import { resolve } from "node:path";

if (process.platform === "win32" && !process.env.PRISMA_QUERY_ENGINE_LIBRARY) {
  process.env.PRISMA_QUERY_ENGINE_LIBRARY = resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
}
const db = new PrismaClient();

const rows = await db.$queryRawUnsafe(`
WITH etf_universe AS (SELECT id FROM etfs WHERE is_active=true),
etf_sources AS (
 SELECT s.etf_id,upper(coalesce(s.source,'')) source FROM etf_holding_snapshots s WHERE coalesce(s.canonical_row_count,0)>0
 UNION ALL SELECT h.etf_id,upper(coalesce(h.source,'')) source FROM holdings h WHERE h.etf_id IS NOT NULL
),
etf_flags AS (
 SELECT u.id,bool_or(es.etf_id IS NOT NULL) has_any,
   bool_or(es.source LIKE '%YAHOO%') yahoo,
   bool_or(es.source LIKE '%MONEYDJ%') moneydj,
   bool_or(es.etf_id IS NOT NULL AND es.source NOT LIKE '%YAHOO%' AND es.source NOT LIKE '%MONEYDJ%') official
 FROM etf_universe u LEFT JOIN etf_sources es ON es.etf_id=u.id GROUP BY u.id
),
fund_universe AS (SELECT id FROM funds WHERE is_active=true),
fund_sources AS (
 SELECT h.fund_id,upper(coalesce(h.source,'')) source FROM holdings h WHERE h.fund_id IS NOT NULL
 UNION ALL SELECT fh.fund_id,upper(coalesce(fh.source,'')) source FROM fund_holdings fh
),
fund_flags AS (
 SELECT u.id,bool_or(fs.fund_id IS NOT NULL) has_any,
   bool_or(fs.source LIKE '%MONEYDJ%') moneydj,
   bool_or(fs.fund_id IS NOT NULL AND fs.source NOT LIKE '%MONEYDJ%') other
 FROM fund_universe u LEFT JOIN fund_sources fs ON fs.fund_id=u.id GROUP BY u.id
)
SELECT
 (SELECT count(*)::int FROM etf_flags) etf_total,
 (SELECT count(*)::int FROM etf_flags WHERE has_any) etf_with,
 (SELECT count(*)::int FROM etf_flags WHERE NOT has_any) etf_without,
 (SELECT count(*)::int FROM etf_flags WHERE yahoo) yahoo_etf,
 (SELECT count(*)::int FROM etf_flags WHERE moneydj) moneydj_etf,
 (SELECT count(*)::int FROM etf_flags WHERE official) official_etf,
 (SELECT count(*)::int FROM fund_flags) fund_total,
 (SELECT count(*)::int FROM fund_flags WHERE has_any) fund_with,
 (SELECT count(*)::int FROM fund_flags WHERE NOT has_any) fund_without,
 (SELECT count(*)::int FROM fund_flags WHERE moneydj) moneydj_fund,
 (SELECT count(*)::int FROM fund_flags WHERE other) other_fund
`);

console.log(JSON.stringify(rows));
const sources = await db.$queryRawUnsafe(`
WITH all_sources AS (
 SELECT 'ETF' kind,upper(coalesce(source,'')) source,etf_id product_id FROM etf_holding_snapshots WHERE coalesce(canonical_row_count,0)>0
 UNION ALL SELECT 'ETF',upper(coalesce(source,'')),etf_id FROM holdings WHERE etf_id IS NOT NULL
 UNION ALL SELECT 'FUND',upper(coalesce(source,'')),fund_id FROM holdings WHERE fund_id IS NOT NULL
 UNION ALL SELECT 'FUND',upper(coalesce(source,'')),fund_id FROM fund_holdings
)
SELECT kind,source,count(DISTINCT product_id)::int products FROM all_sources GROUP BY kind,source ORDER BY kind,products DESC
`);
console.log(JSON.stringify(sources));
const blockers = await db.$queryRawUnsafe(`
WITH covered_funds AS (
 SELECT fund_id FROM holdings WHERE fund_id IS NOT NULL
 UNION SELECT fund_id FROM fund_holdings
), mapped AS (
 SELECT fund_id FROM fund_mappings WHERE moneydj_code IS NOT NULL AND moneydj_code <> '1'
)
SELECT
 (SELECT count(*)::int FROM funds f LEFT JOIN mapped m ON m.fund_id=f.id WHERE f.is_active=true AND m.fund_id IS NULL) fund_unmapped_total,
 (SELECT count(*)::int FROM funds f LEFT JOIN mapped m ON m.fund_id=f.id LEFT JOIN covered_funds c ON c.fund_id=f.id WHERE f.is_active=true AND m.fund_id IS NULL AND c.fund_id IS NULL) fund_unmapped_without_holdings,
 (SELECT count(*)::int FROM mapped m LEFT JOIN covered_funds c ON c.fund_id=m.fund_id WHERE c.fund_id IS NULL) fund_mapped_no_holdings
`);
console.log(JSON.stringify(blockers));
const etfGroups = await db.$queryRawUnsafe(`
WITH covered AS (
 SELECT etf_id FROM etf_holding_snapshots WHERE canonical_row_count>0
 UNION SELECT etf_id FROM holdings WHERE etf_id IS NOT NULL
), remaining AS (
 SELECT e.* FROM etfs e LEFT JOIN covered c ON c.etf_id=e.id WHERE e.is_active=true AND c.etf_id IS NULL
)
SELECT CASE
 WHEN upper(coalesce(exchange,'')) IN ('LSE','LONDON','LONDON STOCK EXCHANGE') THEN 'LSE'
 WHEN upper(coalesce(exchange,'')) IN ('NYSEARCA','NYSE ARCA','ARCX') THEN 'NYSEArca'
 WHEN upper(coalesce(exchange,'')) LIKE '%CBOE%US%' OR upper(coalesce(exchange,''))='BATS' THEN 'Cboe US'
 WHEN upper(coalesce(exchange,'')) IN ('NASDAQGM','NASDAQ GLOBAL MARKET','NASDAQ') THEN 'NasdaqGM'
 WHEN upper(coalesce(exchange,'')) LIKE '%CBOE%UK%' THEN 'Cboe UK'
 WHEN upper(coalesce(exchange,'')) IN ('TOKYO','TSE','JPX') THEN 'Tokyo'
 WHEN upper(coalesce(exchange,'')) IN ('HKSE','HKG','HONG KONG') THEN 'HKSE'
 ELSE '其他' END exchange_group,
 count(*)::int etfs
FROM remaining GROUP BY 1 ORDER BY etfs DESC
`);
console.log(JSON.stringify(etfGroups));
const etfProviders = await db.$queryRawUnsafe(`
WITH covered AS (
 SELECT etf_id FROM etf_holding_snapshots WHERE canonical_row_count>0
 UNION SELECT etf_id FROM holdings WHERE etf_id IS NOT NULL
)
SELECT coalesce(nullif(e.provider,''),'UNKNOWN') provider,coalesce(nullif(e.exchange,''),'UNKNOWN') exchange,count(*)::int etfs
FROM etfs e LEFT JOIN covered c ON c.etf_id=e.id WHERE e.is_active=true AND c.etf_id IS NULL
GROUP BY 1,2 ORDER BY etfs DESC LIMIT 30
`);
console.log(JSON.stringify(etfProviders));
const moneydjShape = await db.$queryRawUnsafe(`
SELECT product_name,currency,raw_payload FROM moneydj_external_products ORDER BY product_name LIMIT 12
`);
console.log(JSON.stringify(moneydjShape));
const unmappedSamples = await db.$queryRawUnsafe(`
SELECT f.name,f.legal_name,f.name_en,f.company,f.currency,f.isin
FROM funds f LEFT JOIN fund_mappings m ON m.fund_id=f.id AND m.moneydj_code IS NOT NULL AND m.moneydj_code<>'1'
WHERE f.is_active=true AND m.fund_id IS NULL ORDER BY f.id LIMIT 30
`);
console.log(JSON.stringify(unmappedSamples));
const moneydjInventory = await db.$queryRawUnsafe(`
SELECT count(*)::int products,
 count(*) FILTER (WHERE canonical_fund_id IS NOT NULL)::int assigned,
 count(*) FILTER (WHERE canonical_fund_id IS NULL)::int unassigned,
 count(DISTINCT moneydj_code)::int distinct_codes
FROM moneydj_external_products
`);
console.log(JSON.stringify(moneydjInventory));
await db.$disconnect();
