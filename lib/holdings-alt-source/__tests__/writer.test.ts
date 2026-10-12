import assert from "node:assert/strict";
import { writeYahooOffshoreHoldings } from "../writer";

async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

async function main() {
  await test("writeYahooOffshoreHoldings: write disabled -> query() never called, written=0", async () => {
    let calls = 0;
    const query = async () => { calls++; return []; };
    const result = await writeYahooOffshoreHoldings(query, "YAHOO_FUND_SUMMARY_EMBEDDED", {
      fundId: "f1", yahooFundId: "F1:FO",
      holdings: { asOfDate: "2026-10-11", holdings: [{ rank: 1, securityName: "NVIDIA Corp", ticker: "NVDA", weightPct: 10.64 }] },
    }, false);
    assert.equal(calls, 0);
    assert.equal(result.written, 0);
  });

  await test("writeYahooOffshoreHoldings: write enabled -> one INSERT per holding, correct filingId/sourceRecordId shape", async () => {
    const seenSql: string[] = [];
    const seenParams: any[][] = [];
    const query = async (sql: string, params: any[]) => { seenSql.push(sql); seenParams.push(params); return [{ id: "row1" }]; };
    const result = await writeYahooOffshoreHoldings(query, "YAHOO_FUND_SUMMARY_EMBEDDED", {
      fundId: "f1", yahooFundId: "F1:FO",
      holdings: { asOfDate: "2026-10-11", holdings: [
        { rank: 1, securityName: "NVIDIA Corp", ticker: "NVDA", weightPct: 10.64 },
        { rank: 2, securityName: "Alphabet Inc Class C", ticker: "GOOG", weightPct: 9.36 },
      ] },
    }, true);
    assert.equal(seenSql.length, 2, "one INSERT round-trip per holding row");
    assert.equal(result.written, 2);
    const [fundId, asOfDate, rank, name, ticker, weight, source, sourceRecordId, filingId] = seenParams[0];
    assert.equal(fundId, "f1");
    assert.equal(asOfDate, "2026-10-11");
    assert.equal(rank, 1);
    assert.equal(name, "NVIDIA Corp");
    assert.equal(ticker, "NVDA");
    assert.equal(weight, 10.64);
    assert.equal(source, "YAHOO_FUND_SUMMARY_EMBEDDED");
    assert.equal(sourceRecordId, "2026-10-11:1:NVIDIA Corp");
    assert.equal(filingId, "yahoo:f1:fo:2026-10-11");
  });
}

main();
