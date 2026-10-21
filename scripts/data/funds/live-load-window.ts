// 只讀：取t0快照→等待視窗秒數→取t1快照→算diff，三個查詢的真實2分鐘窗口負載，不改任何資料。
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PATTERNS = [
  { label: "refresh_reverse_products", like: "%refresh_reverse_products(%" },
  { label: "fund_history_insert_distinct_guard", like: "%fund_history.nav IS DISTINCT FROM EXCLUDED.nav%" },
  { label: "fund_history_insert_no_guard_legacy", like: "%COALESCE(fund_history.nav, EXCLUDED.nav)%" },
  { label: "fund_history_insert_single_row", like: "%VALUES ($1, $2, $3::date, $4, NOW())%fund_history%" },
];

async function snapshot() {
  const out: Record<string, { calls: bigint; total_exec_time: number; mean_exec_time: number }[]> = {};
  for (const p of PATTERNS) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT query, calls::bigint AS calls, total_exec_time, mean_exec_time FROM pg_stat_statements WHERE query ILIKE $1 ORDER BY total_exec_time DESC LIMIT 5`,
      p.like,
    );
    out[p.label] = rows;
  }
  // etf_history latest-close DISTINCT ON: search broadly since the exact literal text is unknown ahead of time
  out["etf_history_latest_close_candidates"] = await prisma.$queryRawUnsafe<any[]>(
    `SELECT query, calls::bigint AS calls, total_exec_time, mean_exec_time FROM pg_stat_statements WHERE query ILIKE '%etf_history%' AND query ILIKE '%DISTINCT%' ORDER BY calls DESC LIMIT 10`,
  ) as any;
  return out;
}

const WINDOW_MS = Number(process.argv[2] ?? 120_000);

async function main() {
  console.log(`t0 snapshot: ${new Date().toISOString()}`);
  const t0 = await snapshot();
  await new Promise((r) => setTimeout(r, WINDOW_MS));
  console.log(`t1 snapshot: ${new Date().toISOString()} (window=${WINDOW_MS}ms)`);
  const t1 = await snapshot();

  for (const label of Object.keys(t1)) {
    console.log(`\n=== ${label} ===`);
    const before = new Map((t0[label] ?? []).map((r: any) => [r.query, r]));
    for (const row of t1[label] ?? []) {
      const prev = before.get(row.query);
      const dCalls = Number(row.calls) - Number(prev?.calls ?? 0);
      const dTime = Number(row.total_exec_time) - Number(prev?.total_exec_time ?? 0);
      if (dCalls > 0 || !prev) {
        console.log(`calls(window)=${dCalls} total_ms(window)=${dTime.toFixed(1)} mean_ms(window)=${dCalls > 0 ? (dTime / dCalls).toFixed(1) : "n/a"}`);
        console.log(row.query.slice(0, 300));
      }
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
