import {PrismaClient} from "@prisma/client";
const p=new PrismaClient({datasources:{db:{url:process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER??process.env.DATABASE_URL}}});
async function main(){
 const q=(s:string,...a:any[])=>p.$queryRawUnsafe<any[]>(s,...a);
 console.log(JSON.stringify({
  snapshots:await q(`SELECT fund_id,share_class_id,as_of_date,source,count(*)::int rows,count(*) FILTER(WHERE security_id IS NOT NULL)::int mapped FROM holdings WHERE fund_id IS NOT NULL GROUP BY fund_id,share_class_id,as_of_date,source ORDER BY as_of_date`),
  canonical:await q(`SELECT fund_id,report_date,source,count(*)::int rows,count(*) FILTER(WHERE security_id IS NOT NULL)::int mapped FROM fund_holdings GROUP BY fund_id,report_date,source ORDER BY report_date`),
  duplicateInputs:(await q(`SELECT count(*)::int groups FROM (SELECT h.fund_id,h.as_of_date,h.security_id FROM holdings h JOIN fund_holdings f ON f.fund_id=h.fund_id AND f.report_date=h.as_of_date AND f.security_id=h.security_id WHERE h.security_id IS NOT NULL GROUP BY 1,2,3) x`))[0],
  productMatches:await q(`SELECT e.canonical_security_type type,count(DISTINCT e.security_id)::int securities,count(DISTINCT CASE WHEN f.id IS NOT NULL THEN e.security_id END)::int fund_matches,count(DISTINCT CASE WHEN sc.id IS NOT NULL THEN e.security_id END)::int class_matches,count(DISTINCT CASE WHEN et.id IS NOT NULL THEN e.security_id END)::int etf_matches,count(DISTINCT CASE WHEN b.id IS NOT NULL THEN e.security_id END)::int bond_matches FROM security_regulatory_evidence e LEFT JOIN funds f ON f.isin=e.isin LEFT JOIN fund_share_classes sc ON sc.isin=e.isin LEFT JOIN etfs et ON et.isin=e.isin LEFT JOIN bond_instruments b ON b.isin=e.isin OR b.cusip=e.cusip GROUP BY e.canonical_security_type ORDER BY 1`),
  stockColumns:await q(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='stocks' ORDER BY ordinal_position`),
  existingStockLinks:(await q(`SELECT count(*)::int rows,count(DISTINCT security_id)::int securities FROM stock_security_links WHERE security_id IN(SELECT DISTINCT security_id FROM security_regulatory_evidence WHERE security_id IS NOT NULL)`))[0]
 },null,2))
}
main().finally(()=>p.$disconnect());
