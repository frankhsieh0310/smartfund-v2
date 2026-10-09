import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_MISSING");
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

async function main() {
  await prisma.$executeRawUnsafe("SET statement_timeout='15s'");
  const [rows] = await prisma.$queryRawUnsafe<any[]>(`
    SELECT
      current_setting('transaction_read_only') AS transaction_read_only,
      (SELECT GREATEST(reltuples,0)::bigint FROM pg_class WHERE oid='stock_financial_facts'::regclass)::text financial_rows_estimate,
      (SELECT CASE WHEN n_distinct>=0 THEN n_distinct::bigint ELSE (-n_distinct*(SELECT reltuples FROM pg_class WHERE oid='stock_financial_facts'::regclass))::bigint END FROM pg_stats WHERE schemaname='public' AND tablename='stock_financial_facts' AND attname='stock_id')::text financial_stocks_estimate,
      (SELECT count(*)::int FROM corporate_actions) corporate_actions,
      (SELECT count(*)::int FROM company_guidance) guidance,
      (SELECT count(*)::int FROM institutional_holdings) institutional,
      (SELECT count(*)::int FROM insider_ownership_transactions) insider,
      (SELECT count(*)::int FROM securities_lending_observations) lending,
      (SELECT count(*)::int FROM option_contracts) option_contracts,
      (SELECT GREATEST(reltuples,0)::bigint FROM pg_class WHERE oid='option_observations'::regclass)::text option_observations_estimate
  `);
  console.log(JSON.stringify(rows, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode=1; }).finally(() => prisma.$disconnect());
