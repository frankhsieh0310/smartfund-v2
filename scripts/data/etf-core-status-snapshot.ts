import { PrismaClient } from "@prisma/client";
const p=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL??process.env.DATABASE_URL}}});
const rows=await p.$queryRawUnsafe<any[]>(`SELECT
(SELECT COUNT(*)::int FROM etfs WHERE isin IS NOT NULL) isin,
(SELECT COUNT(*)::int FROM etf_issuer_mappings WHERE verification_status='VERIFIED_OFFICIAL') issuer_product_id,
(SELECT COUNT(DISTINCT etf_id)::int FROM holdings WHERE etf_id IS NOT NULL) holdings_etfs,
(SELECT COUNT(*)::int FROM holdings WHERE etf_id IS NOT NULL) holdings_rows,
(SELECT COUNT(*)::int FROM holdings WHERE etf_id IS NOT NULL AND security_id IS NOT NULL) holdings_mapped,
(SELECT COUNT(*)::int FROM (SELECT etf_id FROM holdings WHERE etf_id IS NOT NULL GROUP BY etf_id HAVING COUNT(DISTINCT as_of_date)>=2) x) pit_etfs,
(SELECT COUNT(*)::int FROM (SELECT DISTINCT etf_id,as_of_date FROM holdings WHERE etf_id IS NOT NULL) x) pit_snapshots,
(SELECT COUNT(*)::int FROM (SELECT etf_id FROM holdings WHERE etf_id IS NOT NULL GROUP BY etf_id HAVING COUNT(DISTINCT as_of_date)>=2) x) pit_multiple,
(SELECT COUNT(DISTINCT etf_id)::int FROM etf_flows) flow_etfs,
(SELECT COUNT(*)::int FROM etf_flows) flow_rows,
(SELECT COUNT(*)::int FROM etfs WHERE benchmark IS NOT NULL) benchmark_labels,
(SELECT COUNT(*)::int FROM etfs WHERE inception_date IS NOT NULL) launch,
(SELECT COUNT(DISTINCT etf_id)::int FROM etf_distribution_events) distribution_etfs,
(SELECT COUNT(*)::int FROM etf_distribution_events) distribution_rows,
(SELECT MIN(as_of_date) FROM holdings WHERE etf_id IS NOT NULL) holdings_earliest,
(SELECT MAX(as_of_date) FROM holdings WHERE etf_id IS NOT NULL) holdings_latest`);
console.log(JSON.stringify(rows[0],(_,v)=>typeof v==='bigint'?Number(v):v));await p.$disconnect();
