const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

async function main() {
  const relations = await prisma.$queryRawUnsafe(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (
        table_name ILIKE '%bond%'
        OR table_name ILIKE '%security%'
        OR table_name ILIKE '%instrument%'
      )
    ORDER BY table_name
  `);
  const columns = await prisma.$queryRawUnsafe(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'bond_market_observations'
    ORDER BY ordinal_position
  `);
  const summary = await prisma.$queryRawUnsafe(`
    SELECT
      COUNT(*)::int AS row_count,
      COUNT(DISTINCT security_id)::int AS security_count,
      MIN(observation_date) AS earliest_observation_date,
      MAX(observation_date) AS latest_observation_date,
      MAX(fetched_at) AS latest_fetched_at,
      MAX(updated_at) AS latest_canonical_write
    FROM bond_market_observations
  `);
  const scopes = await prisma.$queryRawUnsafe(`
    SELECT source_namespace, observation_type, unit, COUNT(*)::int AS row_count,
      COUNT(DISTINCT security_id)::int AS security_count,
      MIN(observation_date) AS earliest_observation_date,
      MAX(observation_date) AS latest_observation_date,
      MAX(fetched_at) AS latest_fetched_at,
      MAX(updated_at) AS latest_canonical_write
    FROM bond_market_observations
    GROUP BY source_namespace, observation_type, unit
    ORDER BY source_namespace, observation_type, unit
  `);
  const marketMaster = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS row_count,
      COUNT(*) FILTER (WHERE is_active)::int AS active_count,
      ARRAY_AGG(symbol ORDER BY symbol) AS symbols,
      ARRAY_AGG(DISTINCT provider ORDER BY provider) AS providers
    FROM market_master
    WHERE asset_type::text = 'BOND'
  `);
  const marketHistory = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS row_count,
      COUNT(DISTINCT h.symbol)::int AS symbol_count,
      MIN(h.date) AS earliest_observation_date,
      MAX(h.date) AS latest_observation_date,
      MAX(h.created_at) AS latest_canonical_write
    FROM market_history h
    JOIN market_master m ON m.symbol = h.symbol
    WHERE m.asset_type::text = 'BOND'
  `);
  const lifecycleRuns = await prisma.$queryRawUnsafe(`
    SELECT id, job_id, exchange, run_type, status, started_at, completed_at,
      attempted, completed, inserted, updated, failed, details
    FROM production_scheduler_runs
    WHERE job_id ILIKE '%bond%'
    ORDER BY started_at DESC
    LIMIT 10
  `);
  const lifecycleLocks = await prisma.$queryRawUnsafe(`
    SELECT job_id, owner, expires_at, updated_at
    FROM production_scheduler_locks
    WHERE job_id ILIKE '%bond%'
    ORDER BY updated_at DESC
  `);
  const lifecycleCheckpoints = await prisma.$queryRawUnsafe(`
    SELECT checkpoint_key, job_id, run_id, last_symbol, processed, succeeded,
      failed, run_type, started_at, updated_at
    FROM production_scheduler_checkpoints
    WHERE job_id ILIKE '%bond%'
    ORDER BY updated_at DESC
    LIMIT 10
  `);
  const p0Instruments = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE country='US')::int us,
      COUNT(*) FILTER (WHERE country='TW')::int taiwan,
      COUNT(*) FILTER (WHERE country NOT IN ('US','TW'))::int other,
      COUNT(*) FILTER (WHERE verification_status LIKE 'VERIFIED%')::int verified,
      COUNT(isin)::int isin, COUNT(cusip)::int cusip,
      COUNT(*) FILTER (WHERE identifier_type NOT IN ('ISIN','CUSIP','SEDOL'))::int local_id,
      COUNT(issue_date)::int issue_date, COUNT(maturity_date)::int maturity_date,
      COUNT(*) FILTER (WHERE status <> 'UNKNOWN')::int status_known
    FROM bond_instruments
  `);
  const p0Links = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int total,
      COUNT(*) FILTER (WHERE verification_status LIKE 'VERIFIED%')::int verified,
      COUNT(*) FILTER (WHERE verification_status='UNRESOLVED')::int unresolved,
      COUNT(*) FILTER (WHERE verification_status='AMBIGUOUS')::int ambiguous
    FROM bond_security_links
  `);
  const p0Terms = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int total, COUNT(issue_date)::int issue_date,
      COUNT(maturity_date)::int maturity_date, COUNT(coupon_rate)::int coupon,
      COUNT(*) FILTER (WHERE coupon_type <> 'UNKNOWN')::int coupon_type,
      COUNT(face_value)::int face_value, COUNT(outstanding_amount)::int outstanding
    FROM bond_terms
  `);
  const p0Observations = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int rows, COUNT(DISTINCT bond_id)::int entities,
      COUNT(*) FILTER (WHERE observation_type ILIKE '%YIELD%')::int yield_rows,
      COUNT(DISTINCT bond_id) FILTER (WHERE observation_type ILIKE '%YIELD%')::int yield_entities,
      COUNT(*) FILTER (WHERE observation_type='PRICE')::int price_rows,
      COUNT(*) FILTER (WHERE observation_type='SETTLEMENT_PRICE')::int settlement_rows,
      MIN(observation_date) earliest, MAX(observation_date) latest,
      (COUNT(*) - COUNT(DISTINCT ROW(bond_id, observation_date, observation_type)))::int duplicate_groups
    FROM bond_market_observations WHERE bond_id IS NOT NULL
  `);
  const p0History = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int entities_with_history, COALESCE(MIN(n),0)::int min,
      COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY n),0)::numeric median,
      COALESCE(percentile_cont(0.75) WITHIN GROUP (ORDER BY n),0)::numeric p75,
      COALESCE(percentile_cont(0.9) WITHIN GROUP (ORDER BY n),0)::numeric p90,
      COALESCE(MAX(n),0)::int max
    FROM (
      SELECT bond_id, COUNT(*)::int n FROM bond_market_observations
      WHERE bond_id IS NOT NULL GROUP BY bond_id HAVING COUNT(*) > 1
    ) history
  `);
  const p0Benchmarks = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int entities, COALESCE(SUM(history_rows),0)::int rows,
      COUNT(*) FILTER (WHERE history_quality_status <> 'PASS')::int quality_review
    FROM bond_benchmark_series
  `);
  const p0Coverage = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int rows,
      COUNT(*) FILTER (WHERE professional_detail_ready)::int detail_ready
    FROM bond_coverage_snapshots WHERE snapshot_date=CURRENT_DATE
  `);
  console.log(JSON.stringify({ relations, columns, summary, scopes, marketMaster, marketHistory,
    lifecycleRuns, lifecycleLocks, lifecycleCheckpoints,
    p0: { instruments: p0Instruments, links: p0Links, terms: p0Terms,
      observations: p0Observations, history: p0History,
      benchmarks: p0Benchmarks, coverage: p0Coverage } }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
