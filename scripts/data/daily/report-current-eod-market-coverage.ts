import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});

async function main(): Promise<void> {
  const registry = JSON.parse(
    await readFile(join(process.cwd(), "config", "production-yahoo-daily-jobs.json"), "utf8"),
  ) as { jobs: Array<{ id: string; country: string; exchanges: string[] }> };
  const groups = await prisma.stock.groupBy({
    by: ["country", "exchange"],
    where: { isActive: true },
    _count: { _all: true },
    _min: { latestDate: true },
    _max: { latestDate: true },
    orderBy: [{ country: "asc" }, { exchange: "asc" }],
  });
  const classified = groups.map((group) => ({
    ...group,
    engineId: registry.jobs.find(
      (job) => job.country === group.country && job.exchanges.includes(group.exchange),
    )?.id ?? null,
  }));
  const neverSynced = await prisma.stock.groupBy({
    by: ["country", "exchange"],
    where: { isActive: true, latestDate: null },
    _count: { _all: true },
    orderBy: [{ country: "asc" }, { exchange: "asc" }],
  });
  const outsideSamples = [];
  for (const group of classified.filter((item) => !item.engineId)) {
    outsideSamples.push({
      country: group.country,
      exchange: group.exchange,
      stocks: await prisma.stock.findMany({
        where: { isActive: true, country: group.country, exchange: group.exchange },
        select: { ticker: true, yahooSymbol: true, latestDate: true },
        orderBy: { ticker: "asc" },
        take: 3,
      }),
    });
  }
  const baselineNeverSyncedDetails = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT s.ticker, s.yahoo_symbol, s.country, s.exchange,
            f.classification, f.error_type, f.last_error, f.attempts, f.next_retry_at
       FROM stocks s
       LEFT JOIN production_scheduler_failures f
         ON f.stock_id=s.id AND f.job_id='canada-yahoo-daily' AND f.resolved=FALSE
      WHERE s.is_active=TRUE AND s.latest_date IS NULL AND s.country='CA'
      ORDER BY s.exchange, s.ticker`,
  );
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    activeStocks: classified.reduce((sum, group) => sum + group._count._all, 0),
    inEngine: classified.filter((group) => group.engineId).reduce((sum, group) => sum + group._count._all, 0),
    outsideEngine: classified.filter((group) => !group.engineId),
    neverSynced,
    baselineNeverSyncedDetails,
    outsideSamples,
  }, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
