import { PrismaClient } from "@prisma/client";

function url(): string | undefined {
  const source = process.env.DATABASE_URL ?? process.env.DIRECT_URL;
  if (!source) return undefined;
  const parsed = new URL(source.replace(":5432/", ":6543/"));
  parsed.searchParams.set("pgbouncer", "true");
  parsed.searchParams.set("connection_limit", "1");
  return parsed.toString();
}
const db = new PrismaClient({ datasources: { db: { url: url() } } });
const historical = "stock-technical-nasdaq-historical", canary = "stock-technical-nasdaq-canary";

async function main() {
  const result = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; status: string }>>(
      `SELECT r.id,r.status FROM production_scheduler_runs r JOIN production_scheduler_checkpoints c ON c.run_id=r.id WHERE r.job_id=$1 AND c.job_id=$1 AND c.last_symbol='AAPL' AND c.processed=1 AND c.succeeded=1 AND c.failed=0 AND r.started_at >= '2026-08-16T09:18:00Z' ORDER BY r.started_at DESC`,
      historical,
    );
    if (rows.length !== 1 || rows[0]!.status !== "COMPLETED") throw new Error(`CANARY_RECONCILIATION_FAIL_CLOSED:${rows.length}:${rows[0]?.status ?? "NONE"}`);
    const runId = rows[0]!.id;
    const checkpoint = await tx.$executeRawUnsafe(`UPDATE production_scheduler_checkpoints SET job_id=$1,checkpoint_key=$1,run_type='STOCK_TECHNICAL_CANARY',updated_at=NOW() WHERE run_id=$2 AND job_id=$3 AND last_symbol='AAPL'`, canary, runId, historical);
    const run = await tx.$executeRawUnsafe(`UPDATE production_scheduler_runs SET job_id=$1,run_type='STOCK_TECHNICAL_CANARY' WHERE id=$2 AND job_id=$3`, canary, runId, historical);
    if (checkpoint !== 1 || run !== 1) throw new Error(`CANARY_RECONCILIATION_COUNT_MISMATCH:${checkpoint}:${run}`);
    return { runId, checkpoint, run };
  });
  console.log(JSON.stringify({ status: "PASS", historicalCheckpointPreserved: false, canaryJobId: canary, ...result }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
