import { PrismaClient } from "@prisma/client";

function databaseUrl() {
  const parsed = new URL(process.env.DATABASE_URL!);
  parsed.port = "6543";
  parsed.searchParams.set("pgbouncer", "true");
  parsed.searchParams.set("connection_limit", "1");
  return parsed.toString();
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl() } } });

try {
  const [indexes, policy, carry] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*) FILTER (WHERE c.history_available AND p.license_status<>'LICENSE_REQUIRED')::int series, COALESCE(SUM(c.observation_count) FILTER (WHERE p.license_status<>'LICENSE_REQUIRED'),0)::int rows, MIN(c.first_date) FILTER (WHERE p.license_status<>'LICENSE_REQUIRED')::text earliest, MAX(c.last_date) FILTER (WHERE p.license_status<>'LICENSE_REQUIRED')::text latest FROM currency_index_profiles p LEFT JOIN currency_index_coverage c ON c.symbol=p.symbol`),
    prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(DISTINCT s.id)::int series, COUNT(*)::int rows, MIN(v.date)::text earliest, MAX(v.date)::text latest FROM economic_series s JOIN economic_values v ON v.series_id=s.id WHERE s.enabled AND s.category IN ('POLICY_RATE','CENTRAL_BANK_POLICY_RATE')`),
    prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(DISTINCT pair_symbol) FILTER (WHERE metric='RATE_DIFFERENTIAL_HISTORY')::int pairs, COUNT(*) FILTER (WHERE metric='RATE_DIFFERENTIAL_HISTORY')::int rows, MIN(observed_at)::text earliest, MAX(observed_at)::text latest FROM fx_metrics WHERE metric IN ('RATE_DIFFERENTIAL_HISTORY','CARRY_OBSERVATION','OVERNIGHT_RATE_RANK')`),
  ]);
  console.log(JSON.stringify({ indexes: indexes[0], policy: policy[0], carry: carry[0] }, null, 2));
} finally {
  await prisma.$disconnect();
}
