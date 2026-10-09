import { PrismaClient } from "@prisma/client";
const prisma=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL??process.env.DATABASE_URL}}});
async function main(){
  const before=await prisma.$queryRawUnsafe<Array<{rows:bigint;weight_sum:string}>>("SELECT COUNT(*)::bigint rows,SUM(weight)::text weight_sum FROM holdings h JOIN etfs e ON e.id=h.etf_id WHERE e.code='IVV' AND h.as_of_date='2026-08-07'::date AND h.source='ISHARES_OFFICIAL_LATEST_HOLDINGS'");
  if(Number(before[0]?.rows)!==508||Number(before[0]?.weight_sum)<99||Number(before[0]?.weight_sum)>101)throw new Error(`FAIL_CLOSED_UNEXPECTED_DUPLICATE_SET:${JSON.stringify(before)}`);
  const deleted=await prisma.$executeRawUnsafe("DELETE FROM holdings h USING etfs e WHERE e.id=h.etf_id AND e.code='IVV' AND h.as_of_date='2026-08-07'::date AND h.source='ISHARES_OFFICIAL_LATEST_HOLDINGS'");
  const after=await prisma.$queryRawUnsafe<Array<{rows:bigint;weight_sum:string;sources:bigint}>>("SELECT COUNT(*)::bigint rows,SUM(h.weight)::text weight_sum,COUNT(DISTINCT h.source)::bigint sources FROM holdings h JOIN etfs e ON e.id=h.etf_id WHERE e.code='IVV' AND h.as_of_date='2026-08-07'::date");
  if(Number(deleted)!==508||Number(after[0]?.rows)!==508||Number(after[0]?.sources)!==1)throw new Error(`REPAIR_READ_BACK_FAILED:${JSON.stringify({deleted,after})}`);
  console.log(JSON.stringify({deleted:Number(deleted),remainingRows:Number(after[0].rows),weightSum:Number(after[0].weight_sum),sources:Number(after[0].sources),effectiveDate:"2026-08-07",historyDatesDeleted:0}));
}
main().finally(()=>prisma.$disconnect());
