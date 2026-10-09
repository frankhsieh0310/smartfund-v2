import {PrismaClient} from "@prisma/client";
const p=new PrismaClient({datasources:{db:{url:process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER??process.env.DATABASE_URL}}});
async function main(){const q=(s:string,...a:any[])=>p.$queryRawUnsafe<any[]>(s,...a);console.log(JSON.stringify({
 universe:(await q(`SELECT count(*)::int funds FROM funds`))[0],
 verifiedFunds:(await q(`SELECT count(DISTINCT fund_id)::int funds FROM fund_provider_mappings WHERE verified_at IS NOT NULL`))[0],
 classes:(await q(`SELECT count(*)::int classes,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM fund_provider_mappings m WHERE m.share_class_id=fund_share_classes.id AND m.verified_at IS NOT NULL))::int verified,count(*) FILTER(WHERE upper(coalesce(accumulating_distributing,'')) IN('ACC','ACCUMULATING'))::int accumulating FROM fund_share_classes`))[0],
 aum:(await q(`SELECT count(*)::int rows,count(DISTINCT fund_id)::int funds,count(DISTINCT share_class_id) FILTER(WHERE share_class_id IS NOT NULL)::int classes,min(observation_date) earliest,max(observation_date) latest FROM fund_aum_observations`))[0],
 aumSources:await q(`SELECT source,grain,count(*)::int rows,count(DISTINCT fund_id)::int funds,count(DISTINCT share_class_id) FILTER(WHERE share_class_id IS NOT NULL)::int classes FROM fund_aum_observations GROUP BY source,grain ORDER BY source,grain`),
 distribution:(await q(`SELECT count(*)::int rows,count(DISTINCT fund_id)::int funds,count(DISTINCT share_class_id) FILTER(WHERE share_class_id IS NOT NULL)::int classes,min(ex_date) earliest,max(ex_date) latest FROM fund_distribution_observations`))[0],
 distributionSources:await q(`SELECT source,count(*)::int rows,count(DISTINCT fund_id)::int funds,count(DISTINCT share_class_id) FILTER(WHERE share_class_id IS NOT NULL)::int classes FROM fund_distribution_observations GROUP BY source ORDER BY source`),
 documents:(await q(`SELECT count(*)::int rows,count(*) FILTER(WHERE content_hash IS NOT NULL)::int archived,count(DISTINCT fund_id)::int funds FROM fund_documents`))[0],
 quality:(await q(`SELECT (SELECT count(*)::int FROM(SELECT fund_id,share_class_id,observation_date,source,count(*) FROM fund_aum_observations GROUP BY 1,2,3,4 HAVING count(*)>1)x) duplicate_aum,(SELECT count(*)::int FROM(SELECT fund_id,share_class_id,ex_date,source,distribution_amount,count(*) FROM fund_distribution_observations GROUP BY 1,2,3,4,5 HAVING count(*)>1)x) duplicate_distributions,(SELECT count(*)::int FROM fund_aum_observations a LEFT JOIN funds f ON f.id=a.fund_id WHERE f.id IS NULL)+(SELECT count(*)::int FROM fund_distribution_observations d LEFT JOIN funds f ON f.id=d.fund_id WHERE f.id IS NULL) orphan_rows`))[0]
},null,2))}
main().finally(()=>p.$disconnect());
