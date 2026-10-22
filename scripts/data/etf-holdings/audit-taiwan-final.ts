import path from "node:path";
import { PrismaClient } from "@prisma/client";

const engine = path.resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if (process.platform === "win32" && !process.env.PRISMA_QUERY_ENGINE_LIBRARY) process.env.PRISMA_QUERY_ENGINE_LIBRARY = engine;
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });

async function main() {
  const twWhere = `e.is_active=true AND (e.exchange IN ('TWSE','TPEx') OR (e.exchange IS NULL AND e.currency='TWD'))`;
  const counts = await prisma.$queryRawUnsafe<any[]>(`
    WITH tw AS (SELECT e.id FROM etfs e WHERE ${twWhere})
    SELECT
      (SELECT count(*)::int FROM tw) AS tw_total,
      (SELECT count(*)::int FROM etf_holding_snapshots s JOIN tw ON tw.id=s.etf_id) AS snapshot_rows,
      (SELECT count(*)::int FROM etf_holdings h JOIN tw ON tw.id=h.etf_id) AS holding_rows,
      (SELECT count(*)::int FROM etf_holding_snapshots s JOIN tw ON tw.id=s.etf_id WHERE s.effective_date > DATE '2026-08-30') AS future_invalid,
      (SELECT count(*)::int FROM etfs WHERE is_active=true) AS global_total
  `);
  const samples = await prisma.$queryRawUnsafe<any[]>(`
    SELECT e.code,e.id,
      (SELECT count(*)::int FROM etf_holding_snapshots s WHERE s.etf_id=e.id) snapshot_count,
      (SELECT count(*)::int FROM etf_holdings h WHERE h.etf_id=e.id) holding_row_count,
      (SELECT max(s.effective_date)::text FROM etf_holding_snapshots s WHERE s.etf_id=e.id) latest_as_of_date,
      (SELECT count(*)::int FROM holdings h WHERE h.etf_id=e.id AND h.as_of_date=(SELECT max(h2.as_of_date) FROM holdings h2 WHERE h2.etf_id=e.id)) api_top_source_rows
    FROM etfs e WHERE e.code IN ('0050','006208','00878','00919') ORDER BY e.code
  `);
  const globalGroups = await prisma.$queryRawUnsafe<any[]>(`
    SELECT coalesce(nullif(provider,''),'UNKNOWN') provider,coalesce(exchange,'UNKNOWN') exchange,count(*)::int count
    FROM etfs e WHERE e.is_active=true AND NOT (${twWhere})
    GROUP BY 1,2 ORDER BY count(*) DESC LIMIT 20
  `);
  console.log(JSON.stringify({counts:counts[0],samples,globalGroups},null,2));
}

main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>prisma.$disconnect());
