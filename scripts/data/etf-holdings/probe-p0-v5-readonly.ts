import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const query = `SELECT
  (SELECT count(*)::int FROM pg_stat_activity) connection_count,
  (SELECT count(*)::int FROM pg_stat_activity WHERE state = 'active') active_count,
  (SELECT count(*)::int FROM pg_stat_activity WHERE state = 'idle') idle_count,
  (SELECT count(*)::int FROM pg_stat_activity WHERE lower(coalesce(application_name,'')) LIKE '%etf%' OR lower(coalesce(query,'')) LIKE '%etf%holding%') etf_session_count,
  to_regclass('public.etf_holding_snapshots')::text snapshot_relation,
  to_regclass('public.etf_holdings')::text holding_relation,
  to_regclass('public.etf_holding_provenance')::text provenance_relation,
  to_regclass('public.etf_holding_analytics')::text analytics_relation,
  (SELECT count(*)::int FROM "_prisma_migrations" WHERE lower(migration_name) LIKE '%etf%holding%' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) migration_applied_count,
  (SELECT count(*)::int FROM "_prisma_migrations" WHERE lower(migration_name) LIKE '%etf%holding%' AND finished_at IS NULL AND rolled_back_at IS NULL) migration_pending_count,
  (SELECT json_agg(x) FROM (SELECT e.code, count(DISTINCT h.as_of_date)::int snapshot_count, array_agg(DISTINCT h.as_of_date ORDER BY h.as_of_date) effective_dates, count(h.*)::int holding_rows FROM etfs e LEFT JOIN holdings h ON h.etf_id=e.id AND h.asset_type='ETF' WHERE e.code IN ('IVV','IWM','AGG') GROUP BY e.code ORDER BY e.code) x) representative`;
try {
  console.log(JSON.stringify(await prisma.$queryRawUnsafe(query)));
} finally {
  await prisma.$disconnect();
}
