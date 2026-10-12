import assert from "node:assert/strict";
import { fetchYahooOffshoreHoldings } from "../yahooOffshoreHoldings";

async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const originalFetch = globalThis.fetch;

async function withStubbedFetch(html: string, status: number, fn: () => Promise<void>) {
  globalThis.fetch = (async () => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => html,
  })) as any;
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const REAL_SHAPE_HTML = `<html><body><script>window.__SOMETHING__={"holdings":{"assetAlloc":{},"portfolioHolding":{"portfolioUpdated":"2026-10-11","portfolios":[{"astPct":"10.64","securityId":"0","securityName":"NVIDIA Corp","ticker":"NVDA"},{"astPct":"9.36","securityId":"1","securityName":"Alphabet Inc Class C","ticker":"GOOG"}]}}};</script></body></html>`;

async function main() {
  await test("fetchYahooOffshoreHoldings: parses the real embedded portfolioHolding shape", async () => {
    await withStubbedFetch(REAL_SHAPE_HTML, 200, async () => {
      const result = await fetchYahooOffshoreHoldings("F00000T0K3:FO");
      assert.ok(result, "expected a non-null result");
      assert.equal(result!.asOfDate, "2026-10-11");
      assert.equal(result!.holdings.length, 2);
      assert.deepEqual(result!.holdings[0], { rank: 1, securityName: "NVIDIA Corp", ticker: "NVDA", weightPct: 10.64 });
      assert.deepEqual(result!.holdings[1], { rank: 2, securityName: "Alphabet Inc Class C", ticker: "GOOG", weightPct: 9.36 });
    });
  });

  await test("fetchYahooOffshoreHoldings: page with no portfolioHolding block -> null", async () => {
    await withStubbedFetch("<html><body>no data here</body></html>", 200, async () => {
      const result = await fetchYahooOffshoreHoldings("F00000T0K3:FO");
      assert.equal(result, null);
    });
  });

  await test("fetchYahooOffshoreHoldings: HTTP 404 -> null (not an error)", async () => {
    await withStubbedFetch("not found", 404, async () => {
      const result = await fetchYahooOffshoreHoldings("DOES-NOT-EXIST");
      assert.equal(result, null);
    });
  });

  await test("fetchYahooOffshoreHoldings: 429 throws YahooRateLimitedError", async () => {
    await withStubbedFetch("", 429, async () => {
      try {
        await fetchYahooOffshoreHoldings("F00000T0K3:FO");
        throw new Error("expected throw, got none");
      } catch (e) {
        assert.equal((e as Error).name === "YahooRateLimitedError" || /RATE_LIMITED/.test((e as Error).message), true);
      }
    });
  });
}

main();
