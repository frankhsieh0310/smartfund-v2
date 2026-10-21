// 只讀：對pg_stat_statements做一次snapshot，輸出成JSON給下一步diff用。不改任何資料、不改程式、
// 不動twapp schema。
import { PrismaClient } from "@prisma/client";
import fs from "fs";

const prisma = new PrismaClient();
const PATTERNS = [
  { label: "refresh_reverse_products", like: "%refresh_reverse_products(%" },
  { label: "fund_history_insert", like: "%INSERT INTO fund_history%" },
  { label: "etf_history_distinct_on", like: "%etf_history%DISTINCT%" },
];

async function main() {
  const tag = process.argv[2] ?? "t0";
  const out: Record<string, any[]> = {};
  for (const p of PATTERNS) {
    out[p.label] = await prisma.$queryRawUnsafe(
      `SELECT query, calls::bigint::text AS calls, total_exec_time, mean_exec_time, rows::bigint::text AS rows
       FROM pg_stat_statements WHERE query ILIKE $1 ORDER BY total_exec_time DESC LIMIT 10`,
      p.like,
    );
  }
  out["_timestamp"] = [{ t: new Date().toISOString() }] as any;
  fs.writeFileSync(
    `C:/Users/User/AppData/Local/Temp/claude/C--Users-User-Desktop-tw-data-updater/1cb3a135-d2a6-4f7e-b9d2-604385fefaf2/scratchpad/load_snapshot_${tag}.json`,
    JSON.stringify(out, null, 2),
  );
  console.log(`snapshot ${tag} saved at`, new Date().toISOString());
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
