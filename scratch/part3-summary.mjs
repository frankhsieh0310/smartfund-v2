import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const run = await prisma.$queryRawUnsafe(`
  SELECT to_char(started_at,'YYYY-MM-DD HH24:MI:SS') started, status, error, details->'markets' markets
  FROM production_scheduler_runs WHERE job_id='MARKET_CLOSE_SYNC_SHADOW' ORDER BY started_at DESC LIMIT 1
`);
const markets = run[0].markets;
console.log(`Run started: ${run[0].started}, status: ${run[0].status}, error: ${run[0].error}`);
for (const m of markets) {
  console.log(`${m.jobId}: status=${m.status}, doneForToday=${m.doneForToday}, targetLocalDate=${m.targetLocalDate}, dbGapCount=${m.dbGapCount}, writeErrorCount=${m.writeErrorCount}, fetchErrorCount=${m.fetchErrorCount}, notEligibleReason=${m.notEligibleReason}, coreUniverseAfter=${m.coreUniverseAfter}`);
}
await prisma.$disconnect();
