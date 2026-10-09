import { PrismaClient } from "@prisma/client";
const db=new PrismaClient({datasources:{db:{url:process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER??process.env.DATABASE_URL}}});
async function main(){
 const [allocation]=await db.$queryRawUnsafe<any[]>(`SELECT count(*)::int rows,count(DISTINCT fund_id)::int funds,count(DISTINCT as_of_date)::int periods,count(*) FILTER(WHERE percentage<0 OR percentage>100)::int invalid_percentage,count(*) FILTER(WHERE as_of_date>CURRENT_DATE)::int future_dates,count(*) FILTER(WHERE f.id IS NULL)::int orphan_funds,count(*) FILTER(WHERE share_class_id IS NOT NULL)::int class_rows FROM fund_source_allocation_observations a LEFT JOIN funds f ON f.id=a.fund_id WHERE source='MONEYDJ_PUBLIC_DISCLOSURE'`);
 const [duplicates]=await db.$queryRawUnsafe<any[]>(`SELECT count(*)::int groups FROM(SELECT fund_id,COALESCE(share_class_id,''),domain,raw_category,as_of_date,source,provider_product_id FROM fund_source_allocation_observations GROUP BY 1,2,3,4,5,6,7 HAVING count(*)>1)x`);
 const [holdings]=await db.$queryRawUnsafe<any[]>(`SELECT count(*)::int rows,count(DISTINCT fund_id)::int funds,count(DISTINCT filing_id)::int disclosures,count(*) FILTER(WHERE weight<0 OR weight>100)::int invalid_weight,count(*) FILTER(WHERE f.id IS NULL)::int orphan_funds,count(*) FILTER(WHERE h.share_class_id IS NOT NULL)::int class_rows FROM holdings h LEFT JOIN funds f ON f.id=h.fund_id WHERE source='MONEYDJ_PUBLIC_DISCLOSURE'`);
 const [mapping]=await db.$queryRawUnsafe<any[]>(`SELECT count(*)::int eligible,count(*) FILTER(WHERE moneydj_code='1')::int sentinel,count(DISTINCT moneydj_code) FILTER(WHERE moneydj_code<>'1')::int valid_codes FROM fund_mappings WHERE moneydj_code IS NOT NULL`);
 console.log(JSON.stringify({allocation,duplicates,holdings,mapping}));
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>db.$disconnect());
