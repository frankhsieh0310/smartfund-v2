// 2026-11-10: 驗證refresh_reverse_products()的NULL防呆（見
// migrations/20261110_refresh_reverse_products_null_guard.sql）持續有效：
//   1) etf_keys/fund_keys任一個為NULL都必須RAISE EXCEPTION，不能悄悄清空整個type。
//   2) 正常呼叫（含空陣列）完全不受影響，不會動到任何既有資料的筆數。
// 唯讀對照用途，不寫入任何資料（NULL呼叫會被函式自己擋掉而rollback；正常呼叫只是重算同一筆
// product_key，結果應該跟呼叫前一致）。對正式DB執行：
//   node --env-file=<path to .env> scripts/data/funds/verify-refresh-reverse-products-null-guard.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function expectRejected(label: string, a: string[] | null, b: string[] | null): Promise<boolean> {
  try {
    await prisma.$executeRawUnsafe(`SELECT refresh_reverse_products($1::text[], $2::text[])`, a, b);
    console.error(`FAIL: ${label} — expected RAISE EXCEPTION, call succeeded`);
    return false;
  } catch (e) {
    const ok = e instanceof Error && /must not be NULL/.test(e.message);
    console.log(`${ok ? "PASS" : "FAIL"}: ${label}${ok ? "" : ` — unexpected error: ${(e as Error).message}`}`);
    return ok;
  }
}

async function main() {
  let allPassed = true;

  allPassed = (await expectRejected("etf_keys=NULL is rejected", null, [])) && allPassed;
  allPassed = (await expectRejected("fund_keys=NULL is rejected", [], null)) && allPassed;
  allPassed = (await expectRejected("etf_keys=NULL,fund_keys=NULL is rejected", null, null)) && allPassed;

  const sampleKey = "ETF:TW:0050";
  const before = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) n FROM reverse_current_positions WHERE product_key = $1`,
    sampleKey,
  );
  const beforeN = Number(before[0]?.n ?? 0);
  if (beforeN === 0) {
    console.log(`SKIP: normal-call-unaffected check — ${sampleKey} has 0 rows right now, nothing to compare against`);
  } else {
    await prisma.$executeRawUnsafe(`SELECT refresh_reverse_products($1::text[], ARRAY[]::text[])`, [sampleKey]);
    const after = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) n FROM reverse_current_positions WHERE product_key = $1`,
      sampleKey,
    );
    const afterN = Number(after[0]?.n ?? 0);
    const ok = afterN === beforeN;
    console.log(`${ok ? "PASS" : "FAIL"}: normal call on ${sampleKey} leaves row count unchanged (${beforeN} -> ${afterN})`);
    allPassed = ok && allPassed;
  }

  console.log(allPassed ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
  await prisma.$disconnect();
  process.exit(allPassed ? 0 : 1);
}

main();
