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

async function main() {
  const runs = await db.$queryRawUnsafe<any[]>(`SELECT job_id,status,validation_status,validation_details,attempted,completed,inserted,updated,failed,started_at,completed_at FROM production_scheduler_runs WHERE job_id LIKE 'stock-technical-%' ORDER BY started_at DESC LIMIT 20`);
  const checkpoints = await db.$queryRawUnsafe<any[]>(`SELECT job_id,last_symbol,processed,succeeded,failed,updated_at FROM production_scheduler_checkpoints WHERE job_id LIKE 'stock-technical-%' ORDER BY updated_at DESC LIMIT 20`);
  const canary = await db.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int rows,MIN(t.date)::text earliest,MAX(t.date)::text latest,COUNT(*) FILTER(WHERE t.ma5 IS NOT NULL)::int sma5,COUNT(*) FILTER(WHERE t.ema12 IS NOT NULL)::int ema12,COUNT(*) FILTER(WHERE t.macd IS NOT NULL)::int macd,COUNT(*) FILTER(WHERE t.rsi14 IS NOT NULL)::int rsi14,COUNT(*) FILTER(WHERE t.atr14 IS NOT NULL)::int atr14,COUNT(*) FILTER(WHERE t.bollinger_middle IS NOT NULL)::int bollinger FROM stock_technical t JOIN stocks s ON s.id=t.stock_id WHERE s.exchange='NASDAQ' AND s.ticker='AAPL'`);
  const estimates = await db.$queryRawUnsafe<any[]>(`SELECT reltuples::bigint estimated_rows FROM pg_class WHERE oid='stock_technical'::regclass`);
  const payload = { generatedAt: new Date().toISOString(), runs, checkpoints, canary: canary[0], estimates: estimates[0] };
  console.log(JSON.stringify(payload, (_key, value) => typeof value === "bigint" ? Number(value) : value, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
