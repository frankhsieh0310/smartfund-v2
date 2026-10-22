import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const queuePath = resolve("runtime", "index", "history-route-queue.json");

async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function main() {
  const queue = JSON.parse(await readFile(queuePath, "utf8"));
  const existing = new Map<string, any>((queue.items ?? []).map((item: any) => [item.id, item]));
  const rows = await prisma.$queryRawUnsafe<Array<any>>(`
    WITH history AS (
      SELECT index_id, count(*)::int rows, max(timestamp)::text latest
      FROM global_index_candles WHERE interval='1d' GROUP BY index_id
    )
    SELECT r.id,r.name,r.provider,r.symbol,r.provider_external_id,r.return_type,r.currency,
           r.licensing_status,r.verification_status,r.official_source_url,h.rows,h.latest
    FROM global_index_registry r JOIN history h ON h.index_id=r.id
    WHERE r.provider_external_id IS NOT NULL
      AND r.return_type='PRICE_RETURN'
      AND r.id NOT IN ('sp-500','nikkei-225')
      AND h.latest::date < current_date - interval '4 days'
    ORDER BY r.id
  `);
  for (const row of rows) {
    const old = existing.get(row.id) ?? {};
    existing.set(row.id, {
      ...row,
      ...old,
      status: "INCREMENTAL_ACTIVE",
      reason: "LEGACY_STALE_ROUTE_REENROLLED_EXISTING_OWNER",
      owner: "GLOBAL_INDEX",
      ownerPid: 17260,
      checkpoint: row.latest,
      attempts: Number(old.attempts ?? 0),
      updatedAt: new Date().toISOString(),
    });
  }
  const russell = await prisma.$queryRawUnsafe<Array<any>>(`
    SELECT r.id,r.name,r.provider,r.symbol,r.provider_external_id,r.return_type,r.currency,
           r.licensing_status,r.verification_status,r.official_source_url,
           count(c.*)::int rows,max(c.timestamp)::text latest
    FROM global_index_registry r JOIN global_index_candles c ON c.index_id=r.id AND c.interval='1d'
    WHERE r.id='russell-1000' GROUP BY r.id
  `);
  if (russell[0]) existing.set("russell-1000", {
    ...russell[0], ...(existing.get("russell-1000") ?? {}), status: "INCREMENTAL_ACTIVE",
    reason: "COMPLETED_CANARY_ENROLLED_INCREMENTAL", owner: "GLOBAL_INDEX", ownerPid: 17260,
    checkpoint: russell[0].latest, attempts: 1, updatedAt: new Date().toISOString(),
  });
  queue.items = [...existing.values()].sort((a, b) => a.id.localeCompare(b.id));
  queue.updatedAt = new Date().toISOString();
  queue.legacyStaleReenrolled = rows.length;
  queue.completedCanaryIncremental = russell.length;
  await atomic(queuePath, queue);
  const summary = queue.items.reduce((result: Record<string, number>, item: any) => {
    result[item.status] = (result[item.status] ?? 0) + 1; return result;
  }, {});
  console.log(JSON.stringify({ legacyStaleReenrolled: rows.length, completedCanaryIncremental: russell.length, summary }));
}

main().finally(() => prisma.$disconnect());
