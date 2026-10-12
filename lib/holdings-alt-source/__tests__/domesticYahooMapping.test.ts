import assert from "node:assert/strict";
import { loadDomesticYahooMapping } from "../domesticYahooMapping";

async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

async function main() {
  await test("loadDomesticYahooMapping: maps provider_code to yahooFundId with :FO suffix", async () => {
    let seenSql = "";
    const query = async (sql: string) => {
      seenSql = sql;
      return [{ fundId: "f1", code: "26290779D", providerCode: "F000018CO5" }];
    };
    const result = await loadDomesticYahooMapping(query);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { fundId: "f1", code: "26290779D", yahooFundId: "F000018CO5:FO" });
    assert.match(seenSql, /provider\s*=\s*'yahoo'/);
    assert.match(seenSql, /tdcc-offshore/);
  });

  await test("loadDomesticYahooMapping: empty result -> empty array", async () => {
    const query = async () => [];
    const result = await loadDomesticYahooMapping(query);
    assert.deepEqual(result, []);
  });
}

main();
