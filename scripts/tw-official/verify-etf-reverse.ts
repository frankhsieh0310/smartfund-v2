/**
 * Read-only verification for lib/tw-official/etfReverse.ts.
 * Every query runs inside BEGIN READ ONLY ... ROLLBACK (application_name=taskJ2-readonly-verify).
 * Requires DATABASE_URL in the environment (e.g. `npx tsx --env-file=<path to .env> scripts/tw-official/verify-etf-reverse.ts`);
 * the value is never printed.
 */
import pg from "pg";
import { getOfficialEtfHoldingsCount, getOfficialEtfReverse, HEADER_ROW_CODES, TwOfficialError, type SqlRunner } from "../../lib/tw-official/etfReverse";

const APP_NAME = "taskJ2-readonly-verify";
const FUTURE_DATED_ETF = "00401A";
const taipeiToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const EXPECTED_ETFS: Record<string, number> = { "2330": 64, "2317": 38, "2454": 65, "8069": 10 };
const EXPECTED_STOCKS: Record<string, number> = { "0050": 50, "006208": 50, "00878": 29, "00919": 40 };

let queryCount = 0;
const mismatches: string[] = [];
const check = (label: string, ok: boolean, detail: string) => {
  console.log(`  [${ok ? "OK" : "MISMATCH"}] ${label}: ${detail}`);
  if (!ok) mismatches.push(`${label}: ${detail}`);
};
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = performance.now();
  const value = await fn();
  return { value, ms: Math.round((performance.now() - t) * 10) / 10 };
}

async function verifyWithPg() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: APP_NAME, statement_timeout: 60_000 });
  await client.connect();
  const run: SqlRunner = async (sql, values) => { queryCount += 1; return (await client.query(sql, values)).rows; };
  await client.query("BEGIN READ ONLY");
  queryCount += 1;
  try {
    console.log("== 1. Reverse lookup (official snapshot)");
    for (const ticker of Object.keys(EXPECTED_ETFS)) {
      const { value: r, ms } = await timed(() => getOfficialEtfReverse(run, { ticker, limit: 100 }));
      console.log(`-- ${ticker}: totalEtfs=${r.totalEtfs} latestAsOfDate=${r.latestAsOfDate} (${ms} ms)`);
      check(`${ticker} totalEtfs`, r.totalEtfs === EXPECTED_ETFS[ticker], `got ${r.totalEtfs}, expected ${EXPECTED_ETFS[ticker]}`);
      for (const it of r.items.slice(0, 10)) {
        console.log(`     ${it.etfCode.padEnd(8)} ${it.etfName.slice(0, 18).padEnd(18)} w=${it.weight} date=${it.asOfDate}${it.dateIsFuture ? " (FUTURE)" : ""} stockCount=${it.holdingsCount.stockCount} total=${it.holdingsCount.totalPositions} provider=${it.provider ?? "null"}`);
      }
      if (ticker === "2330" || ticker === "2454") {
        const today = taipeiToday();
        check(`${ticker} latestAsOfDate not in future`, r.latestAsOfDate != null && r.latestAsOfDate <= today && r.latestAsOfDate === "2026-10-08", `latestAsOfDate=${r.latestAsOfDate} today=${today} expected=2026-10-08`);
        const future = r.items.find((i) => i.etfCode === FUTURE_DATED_ETF);
        check(`${ticker} keeps ${FUTURE_DATED_ETF} with dateIsFuture=true`, Boolean(future) && future?.dateIsFuture === true, future ? `asOfDate=${future.asOfDate} dateIsFuture=${future.dateIsFuture} weight=${future.weight}` : "missing");
      }
      if (ticker === "2330") {
        const e0050 = r.items.find((i) => i.etfCode === "0050");
        const e006208 = r.items.find((i) => i.etfCode === "006208");
        check("2330 contains 0050", Boolean(e0050) && Math.abs((e0050?.weight ?? 0) - 56.52) < 0.05, `0050 weight=${e0050?.weight ?? "missing"}`);
        check("2330 contains 006208", Boolean(e006208), `006208 weight=${e006208?.weight ?? "missing"}`);
        const p2 = await getOfficialEtfReverse(run, { ticker, page: 2, limit: 20 });
        check("2330 pagination page=2 limit=20", p2.items.length === 20 && p2.hasMore && p2.totalEtfs === r.totalEtfs, `items=${p2.items.length} hasMore=${p2.hasMore} totalEtfs=${p2.totalEtfs}`);
      }
    }

    console.log("== 2. Suffix inputs equal bare inputs");
    for (const [suffixed, bare] of [["2330.TW", "2330"], ["8069.TWO", "8069"]]) {
      const a = await getOfficialEtfReverse(run, { ticker: suffixed, limit: 100 });
      const b = await getOfficialEtfReverse(run, { ticker: bare, limit: 100 });
      check(`${suffixed} == ${bare}`, a.bareCode === bare && JSON.stringify(a.items) === JSON.stringify(b.items) && a.totalEtfs === b.totalEtfs, `bareCode=${a.bareCode} totalEtfs=${a.totalEtfs}/${b.totalEtfs}`);
    }

    console.log("== 3. Holdings count per ETF");
    for (const code of Object.keys(EXPECTED_STOCKS)) {
      const { value: h, ms } = await timed(() => getOfficialEtfHoldingsCount(run, { code }));
      console.log(`-- ${code} ${h.name}: asOf=${h.asOfDate} stockCount=${h.stockCount} totalPositions=${h.totalPositions} nonStock=${h.nonStock.length} (${ms} ms)`);
      console.log(`     nonStock: ${h.nonStock.slice(0, 6).map((n) => `${n.holdingCode}|${n.name}|${n.weight}`).join(" ; ")}${h.nonStock.length > 6 ? ` …(+${h.nonStock.length - 6})` : ""}`);
      check(`${code} stockCount`, h.stockCount === EXPECTED_STOCKS[code], `got ${h.stockCount}, expected ${EXPECTED_STOCKS[code]}`);
      if (code === "006208") {
        const leaked = h.nonStock.filter((n) => HEADER_ROW_CODES.includes(n.holdingCode ?? ""));
        check("006208 header rows excluded", leaked.length === 0, `header rows in result=${leaked.length}, totalPositions=${h.totalPositions}`);
      }
    }
    const suffixed = await getOfficialEtfHoldingsCount(run, { code: "0050.TW" });
    check("0050.TW == 0050", suffixed.code === "0050" && suffixed.stockCount === EXPECTED_STOCKS["0050"], `code=${suffixed.code} stockCount=${suffixed.stockCount}`);

    console.log("== 4. Invalid inputs");
    const expectError = async (label: string, fn: () => Promise<unknown>, status: number, code: string) => {
      try { await fn(); check(label, false, "no error thrown"); }
      catch (e) {
        const ok = e instanceof TwOfficialError && e.status === status && e.code === code;
        check(label, ok, e instanceof TwOfficialError ? `${e.status} ${e.code}: ${e.message}` : String(e));
      }
    };
    await expectError("ticker=abc", () => getOfficialEtfReverse(run, { ticker: "abc" }), 400, "INVALID_TICKER");
    await expectError("ticker='  '", () => getOfficialEtfReverse(run, { ticker: "  " }), 400, "INVALID_TICKER");
    await expectError("ticker missing", () => getOfficialEtfReverse(run, { ticker: null }), 400, "INVALID_TICKER");
    await expectError("ticker=99999", () => getOfficialEtfReverse(run, { ticker: "99999" }), 404, "TICKER_NOT_FOUND");
    await expectError("limit=101", () => getOfficialEtfReverse(run, { ticker: "2330", limit: 101 }), 400, "INVALID_PARAM");
    await expectError("page=0", () => getOfficialEtfReverse(run, { ticker: "2330", page: 0 }), 400, "INVALID_PARAM");
    await expectError("code=abc", () => getOfficialEtfHoldingsCount(run, { code: "abc" }), 400, "INVALID_CODE");
    await expectError("code=99999", () => getOfficialEtfHoldingsCount(run, { code: "99999" }), 404, "ETF_NOT_FOUND");
  } finally {
    await client.query("ROLLBACK");
    queryCount += 1;
    await client.end();
  }
}

/** Same functions through Prisma (the runner the routes use), inside a READ ONLY interactive transaction that is rolled back. */
async function verifyWithPrisma() {
  console.log("== 5. Prisma runner (same as routes), READ ONLY transaction, rolled back");
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("application_name", APP_NAME);
  process.env.DATABASE_URL = url.toString();
  const { prisma } = await import("../../lib/prisma");
  class Rollback extends Error {}
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      queryCount += 1;
      const run: SqlRunner = (sql, values) => { queryCount += 1; return tx.$queryRawUnsafe(sql, ...values); };
      const { value: r, ms } = await timed(() => getOfficialEtfReverse(run, { ticker: "2330", limit: 3 }));
      console.log(`-- prisma 2330: totalEtfs=${r.totalEtfs} (${ms} ms) top3=${r.items.map((i) => `${i.etfCode}:${i.weight}`).join(", ")}`);
      check("prisma 2330 totalEtfs", r.totalEtfs === EXPECTED_ETFS["2330"], `got ${r.totalEtfs}`);
      console.log("   sample response (2330, first 3):");
      console.log(JSON.stringify(r, null, 1).split("\n").map((l) => `   ${l}`).join("\n"));
      const h = await getOfficialEtfHoldingsCount(run, { code: "0050" });
      check("prisma 0050 stockCount", h.stockCount === EXPECTED_STOCKS["0050"], `got ${h.stockCount}`);
      console.log("   sample response (0050 holdings count):");
      console.log(JSON.stringify(h, null, 1).split("\n").map((l) => `   ${l}`).join("\n"));
      throw new Rollback();
    }, { timeout: 120_000, maxWait: 20_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log("   (transaction rolled back as intended)");
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  await verifyWithPg();
  await verifyWithPrisma();
  console.log(`\nDB queries issued: ${queryCount}`);
  console.log(mismatches.length ? `MISMATCHES (${mismatches.length}):\n - ${mismatches.join("\n - ")}` : "ALL CHECKS PASSED");
  if (mismatches.length) process.exitCode = 1;
}

main().catch((e) => { console.error("verify failed:", e instanceof Error ? e.message : e); process.exit(1); });
