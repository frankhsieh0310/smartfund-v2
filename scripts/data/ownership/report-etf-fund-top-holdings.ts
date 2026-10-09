import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_MISSING");
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

async function main() {
  const [coverage, reverse, pit] = await Promise.all([
    prisma.$queryRawUnsafe(`
      WITH latest_etf AS (
        SELECT etf_id,source,max(as_of_date) as_of_date FROM holdings WHERE etf_id IS NOT NULL GROUP BY etf_id,source
      ), etf_top AS (
        SELECT h.* FROM holdings h JOIN latest_etf l ON l.etf_id=h.etf_id AND l.source=h.source AND l.as_of_date=h.as_of_date WHERE h.rank<=20
      ), latest_fund AS (
        SELECT fund_id,source,max(as_of_date) as_of_date FROM holdings WHERE fund_id IS NOT NULL GROUP BY fund_id,source
      ), fund_top AS (
        SELECT h.* FROM holdings h JOIN latest_fund l ON l.fund_id=h.fund_id AND l.source=h.source AND l.as_of_date=h.as_of_date WHERE h.rank<=20
      ) SELECT
        (SELECT count(*)::int FROM etfs) etf_universe,
        (SELECT count(DISTINCT etf_id)::int FROM latest_etf) etf_products,
        (SELECT count(*)::int FROM etf_top) etf_top_rows,
        (SELECT count(DISTINCT etf_id)::int FROM etf_top WHERE weight_method='TOP_5_DISCLOSED') etf_top5,
        (SELECT count(DISTINCT etf_id)::int FROM etf_top WHERE weight_method='TOP_10_DISCLOSED') etf_top10,
        (SELECT count(DISTINCT etf_id)::int FROM etf_top WHERE weight_method='TOP_20_DISCLOSED') etf_top20,
        (SELECT count(DISTINCT etf_id)::int FROM latest_etf WHERE source IN ('BLACKROCK_OFFICIAL_CSV','ISHARES_OFFICIAL_LATEST_HOLDINGS')) etf_full,
        (SELECT count(*)::int FROM funds) fund_universe,
        (SELECT count(DISTINCT fund_id)::int FROM latest_fund) fund_products,
        (SELECT count(*)::int FROM fund_top) fund_top_rows,
        (SELECT count(DISTINCT fund_id)::int FROM fund_top WHERE weight_method='TOP_5_DISCLOSED') fund_top5,
        (SELECT count(DISTINCT fund_id)::int FROM fund_top WHERE weight_method='TOP_10_DISCLOSED') fund_top10,
        (SELECT count(DISTINCT fund_id)::int FROM fund_top WHERE weight_method='TOP_20_DISCLOSED') fund_top20,
        ((SELECT count(*) FROM etf_top)+(SELECT count(*) FROM fund_top))::int top_rows,
        ((SELECT count(*) FROM etf_top h JOIN stock_security_links l ON l.security_id=h.security_id)+(SELECT count(*) FROM fund_top h JOIN stock_security_links l ON l.security_id=h.security_id))::int stock_mapped
    `),
    prisma.$queryRawUnsafe(`
      SELECT s.ticker,s.exchange,
        (SELECT count(DISTINCT h.etf_id) FROM holdings h WHERE h.security_id=l.security_id AND h.etf_id IS NOT NULL)::int etf_count,
        (SELECT count(DISTINCT h.fund_id) FROM holdings h WHERE h.security_id=l.security_id AND h.fund_id IS NOT NULL)::int fund_count
      FROM stocks s JOIN stock_security_links l ON l.stock_id=s.id
      WHERE (s.ticker,s.exchange) IN (('2330','TWSE'),('2303','TWSE'),('2454','TWSE'),('AAPL','NASDAQ'),('MSFT','NASDAQ'),('NVDA','NASDAQ'))
      GROUP BY s.ticker,s.exchange,l.security_id ORDER BY s.ticker
    `),
    prisma.$queryRawUnsafe(`
      SELECT
        (SELECT count(*)::int FROM (SELECT etf_id FROM holdings WHERE etf_id IS NOT NULL GROUP BY etf_id HAVING count(DISTINCT as_of_date)>1) x) etf_multiple,
        (SELECT count(*)::int FROM (SELECT fund_id FROM holdings WHERE fund_id IS NOT NULL GROUP BY fund_id HAVING count(DISTINCT as_of_date)>1) x) fund_multiple
    `),
  ]);
  console.log(JSON.stringify({ coverage: (coverage as any[])[0], reverse, pit: (pit as any[])[0] }, null, 2));
}

main().finally(() => prisma.$disconnect());
