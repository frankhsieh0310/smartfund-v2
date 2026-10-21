// 2026-10-21（使用者核准的唯讀查證）: 用真實的 parseTdccNavCsv()（會正確過濾-9999 sentinel、
// 回退到最近一筆真實NAV），避免像第一次inline script那樣誤把「官方只是放了-9999佔位符」
// 判定成「官方已更新、我方漏寫」的SYSTEM問題。
import { fetchTdccNavCsv, parseTdccNavCsv } from "../../../lib/offshore-nav-sync/tdccBatchSource";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
async function main() {
  const funds = await prisma.$queryRawUnsafe<{ id: string; code: string | null; name: string }[]>(
    `SELECT id, code, name FROM funds WHERE data_provider='tdcc-offshore' AND latest_nav_date = '2026-10-16'`,
  );
  console.log("134檔總數:", funds.length);
  const csvText = await fetchTdccNavCsv();
  const byName = parseTdccNavCsv(csvText); // 已經正確處理-9999 sentinel、回退到最近真實NAV

  let notFound = 0, sameStale = 0; const newerAvailable: any[] = []; const notFoundList: any[] = [];
  for (const f of funds) {
    const row = byName.get(f.name);
    if (!row) { notFound++; notFoundList.push(f); continue; }
    if (row.navDate === "2026-10-16") { sameStale++; continue; }
    newerAvailable.push({ code: f.code, name: f.name, csvDate: row.navDate, csvNav: row.nav });
  }
  console.log("TDCC CSV（真實解析，已排除-9999 sentinel）完全找不到這個名稱:", notFound);
  console.log("TDCC CSV 真實最新NAV也是10/16（官方本身沒更新，EXTERNAL_DELAY）:", sameStale);
  console.log("TDCC CSV 真的有10/16之後的有效NAV、但我方latest_nav_date沒追上（SYSTEM）:", newerAvailable.length);
  console.log(JSON.stringify(newerAvailable, null, 2));
  console.log("找不到的那1檔:", JSON.stringify(notFoundList, null, 2));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
