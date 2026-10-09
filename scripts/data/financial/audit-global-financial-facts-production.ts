import { PrismaClient } from "@prisma/client";

function transactionPoolUrl(): string | undefined {
  const source = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
  if (!source) return undefined;
  const url = new URL(source.replace(":5432/", ":6543/"));
  url.searchParams.set("pgbouncer", "true");
  url.searchParams.set("connection_limit", "1");
  return url.toString();
}
const db = new PrismaClient({ datasources: { db: { url: transactionPoolUrl() } } });
const markets = `CASE WHEN s.exchange IN ('NASDAQ','NYSE','AMEX') THEN 'US' WHEN s.exchange IN ('TWSE','TPEX') THEN 'TAIWAN' WHEN s.exchange IN ('JPX','TSE') THEN 'JAPAN' WHEN s.exchange IN ('HKEX','SEHK') THEN 'HONG_KONG' WHEN s.exchange IN ('SSE','SZSE') THEN 'CHINA' WHEN s.exchange IN ('KRX','KOSDAQ') THEN 'KOREA' WHEN s.exchange IN ('LSE') THEN 'UK' WHEN s.exchange IN ('ASX') THEN 'AUSTRALIA' WHEN s.exchange IN ('TSX','TSXV') THEN 'CANADA' WHEN s.exchange IN ('SGX') THEN 'SINGAPORE' WHEN s.exchange IN ('SIX') THEN 'SWITZERLAND' ELSE 'OTHER' END`;

async function main() {
  if (process.argv.includes("--fast")) {
    const runs = await db.$queryRawUnsafe<any[]>(`SELECT job_id,status,validation_status,validation_details,started_at,completed_at FROM production_scheduler_runs WHERE job_id LIKE 'official-financial-%' ORDER BY started_at DESC LIMIT 12`);
    const checkpoints = await db.$queryRawUnsafe<any[]>(`SELECT job_id,last_symbol,processed,succeeded,failed,updated_at FROM production_scheduler_checkpoints WHERE job_id LIKE 'official-financial-%' ORDER BY updated_at DESC LIMIT 12`);
    const aapl = await db.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int rows,COUNT(DISTINCT metric)::int metrics,MIN(period_end)::text earliest,MAX(period_end)::text latest,COUNT(*) FILTER(WHERE publication_date IS NOT NULL)::int pit_date_only,COUNT(*) FILTER(WHERE publication_date IS NULL)::int pit_incomplete FROM stock_financial_facts f JOIN stocks s ON s.id=f.stock_id WHERE s.ticker='AAPL' AND s.exchange='NASDAQ'`);
    const estimates = await db.$queryRawUnsafe<any[]>(`SELECT c.reltuples::bigint estimated_rows,(SELECT COUNT(*)::int FROM stocks s WHERE s.is_active=true AND s.status='ACTIVE') active_stocks FROM pg_class c WHERE c.oid='stock_financial_facts'::regclass`);
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), runs, checkpoints, aapl: aapl[0], estimates: estimates[0] }, (_key, value) => typeof value === "bigint" ? Number(value) : value, 2));
    return;
  }
  const totals = await db.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int rows,COUNT(DISTINCT stock_id)::int stocks,MIN(period_end)::text earliest,MAX(period_end)::text latest FROM stock_financial_facts`);
  const market = await db.$queryRawUnsafe<any[]>(`SELECT ${markets} market,COUNT(DISTINCT s.id)::int active_stocks,COUNT(DISTINCT f.stock_id)::int stocks_with_facts,COUNT(f.id)::int rows,MIN(f.period_end)::text earliest,MAX(f.period_end)::text latest FROM stocks s LEFT JOIN stock_financial_facts f ON f.stock_id=s.id WHERE s.is_active=true AND s.status='ACTIVE' GROUP BY 1 ORDER BY 1`);
  const source = await db.$queryRawUnsafe<any[]>(`SELECT source,COUNT(*)::int rows,COUNT(DISTINCT stock_id)::int stocks,MIN(period_end)::text earliest,MAX(period_end)::text latest FROM stock_financial_facts GROUP BY source ORDER BY rows DESC`);
  const metrics = await db.$queryRawUnsafe<any[]>(`SELECT metric,COUNT(*)::int rows,COUNT(DISTINCT stock_id)::int stocks FROM stock_financial_facts GROUP BY metric ORDER BY rows DESC`);
  const pit = await db.$queryRawUnsafe<any[]>(`SELECT COUNT(*) FILTER(WHERE publication_date IS NOT NULL)::int date_only,COUNT(*) FILTER(WHERE publication_date IS NULL)::int incomplete,COUNT(*) FILTER(WHERE publication_date IS NOT NULL AND publication_date < period_end)::int lookahead_conflicts FROM stock_financial_facts`);
  const quality = await db.$queryRawUnsafe<any[]>(`SELECT COUNT(*) FILTER(WHERE period_start IS NOT NULL AND period_start>period_end)::int invalid_periods,COUNT(*) FILTER(WHERE value::text IN ('NaN','Infinity','-Infinity'))::int nonfinite,COUNT(*) FILTER(WHERE currency IS NOT NULL AND currency !~ '^[A-Z]{3}$')::int invalid_currencies,COUNT(*) FILTER(WHERE unit IS NULL OR unit='')::int invalid_units,COUNT(*)-COUNT(DISTINCT(stock_id,metric,period_end,source,source_fact_key))::int duplicates FROM stock_financial_facts`);
  const identity = await db.$queryRawUnsafe<any[]>(`SELECT COUNT(DISTINCT l.stock_id)::int cik_linked,(SELECT COUNT(*)::int FROM stocks s WHERE s.is_active=true AND s.status='ACTIVE' AND s.exchange IN('NASDAQ','NYSE','AMEX')) us_active FROM canonical_issuer_stock_links l JOIN canonical_issuer_identifiers e ON e.id=l.issuer_identifier_id WHERE e.identifier_type='CIK' AND l.verification_status='VERIFIED_OFFICIAL_EXACT'`);
  const restatements = await db.$queryRawUnsafe<any[]>(`SELECT COUNT(DISTINCT stock_id)::int issuers_with_restatements,COUNT(*)::int revision_rows FROM stock_financial_facts WHERE restatement_version IS NOT NULL`);
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), totals: totals[0], market, source, metrics, pit: pit[0], quality: quality[0], identity: identity[0], restatements: restatements[0] }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
