import {PrismaClient} from "@prisma/client";
const p=new PrismaClient({datasources:{db:{url:process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER??process.env.DATABASE_URL}}});
const q=(sql:string,...args:any[])=>p.$queryRawUnsafe<any[]>(sql,...args);
async function main(){const report={
  holdings:(await q(`SELECT count(*)::int rows,count(*) FILTER(WHERE security_id IS NOT NULL)::int mapped,count(*) FILTER(WHERE security_id IS NULL)::int pending,count(DISTINCT fund_id) FILTER(WHERE security_id IS NOT NULL)::int funds,count(DISTINCT share_class_id) FILTER(WHERE security_id IS NOT NULL)::int classes FROM holdings WHERE source='SEC_EDGAR_NPORT_P'`))[0],
  types:await q(`SELECT canonical_security_type type,count(DISTINCT coalesce(isin,cusip,accession||':'||source_record_id))::int candidates,count(DISTINCT security_id)::int securities FROM security_regulatory_evidence GROUP BY canonical_security_type ORDER BY canonical_security_type`),
  evidence:(await q(`SELECT count(*)::int rows,count(DISTINCT accession)::int filings,count(*) FILTER(WHERE security_id IS NOT NULL)::int linked FROM security_regulatory_evidence`))[0],
  duplicates:(await q(`SELECT (SELECT count(*)::int FROM(SELECT isin FROM securities WHERE isin IS NOT NULL GROUP BY isin HAVING count(*)>1)x) duplicate_isin,(SELECT count(*)::int FROM(SELECT cusip FROM securities WHERE cusip IS NOT NULL GROUP BY cusip HAVING count(*)>1)x) duplicate_cusip`))[0],
  orphans:(await q(`SELECT count(*)::int n FROM holdings h LEFT JOIN securities s ON s.id=h.security_id WHERE h.security_id IS NOT NULL AND s.id IS NULL`))[0],
  productExact:(await q(`SELECT 0::int stock,(SELECT count(DISTINCT e.security_id)::int FROM security_regulatory_evidence e JOIN etfs x ON x.isin=e.isin WHERE e.canonical_security_type='ETF') etf,(SELECT count(DISTINCT e.security_id)::int FROM security_regulatory_evidence e JOIN funds x ON x.isin=e.isin WHERE e.canonical_security_type='FUND') fund,(SELECT count(DISTINCT e.security_id)::int FROM security_regulatory_evidence e JOIN bond_instruments x ON x.isin=e.isin OR x.cusip=e.cusip WHERE e.canonical_security_type LIKE '%BOND') bond`))[0],
};console.log(JSON.stringify(report,null,2))}
main().finally(()=>p.$disconnect());
