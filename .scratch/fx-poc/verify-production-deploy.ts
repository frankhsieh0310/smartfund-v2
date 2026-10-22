import { readFileSync, existsSync } from "node:fs";
for (const file of [".env", ".env.local"]) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const key = m[1]; let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
}
async function main() {
  const { prisma } = await import("../../lib/prisma");

  console.log("=== RECENT YAHOO_FX_QUOTE RUNS ===");
  const runs = await prisma.$queryRaw<Array<{ job_id: string; status: string; started_at: Date; completed_at: Date | null; attempted: number; completed: number; failed: number; details: unknown }>>`
    SELECT job_id, status, started_at, completed_at, attempted, completed, failed, details FROM production_scheduler_runs WHERE job_id LIKE 'YAHOO_FX_%' ORDER BY started_at DESC LIMIT 6
  `;
  for (const r of runs) console.log(r.job_id, r.status, r.started_at.toISOString(), "attempted=", r.attempted, "completed=", r.completed, "failed=", r.failed);

  console.log("=== SAMPLE DIRECT PAIRS ===");
  for (const sym of ["USDTWD", "EURUSD", "USDJPY", "USDCNY", "USDKRW"]) {
    const q = await prisma.fxLatestQuote.findUnique({ where: { pairSymbol: sym } });
    console.log(sym, { source: q?.source, mid: q?.mid?.toString(), quotedAt: q?.quotedAt?.toISOString() });
  }

  console.log("=== SAMPLE DERIVED PAIRS ===");
  const derived = await prisma.fxLatestQuote.findMany({ where: { source: "DERIVED_CROSS_RATE" }, take: 5, orderBy: { pairSymbol: "asc" } });
  for (const d of derived) console.log(d.pairSymbol, { source: d.source, quotedAt: d.quotedAt.toISOString() });
  const derivedCount = await prisma.fxLatestQuote.count({ where: { source: "DERIVED_CROSS_RATE" } });
  console.log("total derived quotes:", derivedCount);

  console.log("=== ETF/FUND/DISTRIBUTION CHECKPOINTS ===");
  const cps = await prisma.$queryRaw<Array<{ checkpoint_key: string; updated_at: Date; processed: number }>>`
    SELECT checkpoint_key, updated_at, processed FROM production_scheduler_checkpoints WHERE checkpoint_key LIKE '%etf%' OR checkpoint_key LIKE '%fund%' ORDER BY updated_at DESC LIMIT 10
  `;
  for (const c of cps) console.log(c.checkpoint_key, c.updated_at.toISOString(), "processed=", c.processed);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
