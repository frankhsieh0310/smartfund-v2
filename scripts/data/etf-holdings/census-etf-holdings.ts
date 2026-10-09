import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const n = (value: unknown) => typeof value === "bigint" ? Number(value) : value;

async function main() {
  const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('etfs','holdings','securities','asset_provider_mappings','provider_symbol_mappings') ORDER BY table_name"
  );
  const columns = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>>(
    "SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('etfs','holdings','securities','asset_provider_mappings','provider_symbol_mappings') ORDER BY table_name,ordinal_position"
  );
  const etf = await prisma.$queryRawUnsafe<Array<{ total: bigint; issuers: bigint }>>(
    "SELECT COUNT(*)::bigint total,COUNT(DISTINCT provider)::bigint issuers FROM etfs"
  );
  const holdings = await prisma.$queryRawUnsafe<Array<{ rows: bigint; etfs: bigint; dates: bigint; issuers: bigint; earliest: Date|null; latest: Date|null }>>(
    "SELECT COUNT(*)::bigint rows,COUNT(DISTINCT h.etf_id)::bigint etfs,COUNT(DISTINCT h.as_of_date)::bigint dates,COUNT(DISTINCT e.provider)::bigint issuers,MIN(h.as_of_date) earliest,MAX(h.as_of_date) latest FROM holdings h LEFT JOIN etfs e ON e.id=h.etf_id WHERE h.asset_type='ETF'"
  );
  const securities = await prisma.$queryRawUnsafe<Array<{ total: bigint }>>("SELECT COUNT(*)::bigint total FROM securities");
  const byEtf = await prisma.$queryRawUnsafe<Array<{ code:string; provider:string|null; dates:bigint; rows:bigint; earliest:Date|null; latest:Date|null }>>(
    "SELECT e.code,e.provider,COUNT(DISTINCT h.as_of_date)::bigint dates,COUNT(h.id)::bigint rows,MIN(h.as_of_date) earliest,MAX(h.as_of_date) latest FROM etfs e JOIN holdings h ON h.etf_id=e.id AND h.asset_type='ETF' GROUP BY e.id,e.code,e.provider ORDER BY COUNT(h.id) DESC LIMIT 100"
  );
  console.log(JSON.stringify({ at:new Date().toISOString(), tables:tables.map(x=>x.table_name), columns, canonicalEtfs:n(etf[0]?.total??0), canonicalIssuers:n(etf[0]?.issuers??0), holdingRows:n(holdings[0]?.rows??0), etfsWithHoldings:n(holdings[0]?.etfs??0), distinctEffectiveDates:n(holdings[0]?.dates??0), issuersWithHoldings:n(holdings[0]?.issuers??0), earliestEffectiveDate:holdings[0]?.earliest, latestEffectiveDate:holdings[0]?.latest, securities:n(securities[0]?.total??0), byEtf:byEtf.map(x=>({...x,dates:n(x.dates),rows:n(x.rows)})) }, null, 2));
}
main().finally(()=>prisma.$disconnect());
