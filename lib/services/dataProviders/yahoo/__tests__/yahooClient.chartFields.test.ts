// Regression test for the 2026-10-13 QA-round-1 change: fetchYahooChart/fetchYahooChartPeriod gained
// two new fields (previousClose, regularMarketPrice) read from Yahoo's own chart response meta. This
// confirms the existing candle-parsing behavior every caller (cloud-etf-price, priceUpdate, fxUpdate,
// the daily Yahoo scripts) depends on is unchanged, and that the two new fields parse correctly
// alongside it -- a purely additive change, nothing removed or renamed.
import assert from "node:assert/strict";
import { fetchYahooChart, fetchYahooChartPeriod } from "../yahooClient.ts";

function test(name: string, fn: () => Promise<void> | void) {
  return (async () => {
    try {
      await fn();
      console.log(`PASS: ${name}`);
    } catch (e) {
      console.log(`FAIL: ${name} — ${(e as Error).message}`);
      process.exitCode = 1;
    }
  })();
}

const FIXTURE_CHART_JSON = {
  chart: {
    result: [
      {
        meta: {
          currency: "TWD",
          exchangeName: "TAI",
          exchangeTimezoneName: "Asia/Taipei",
          instrumentType: "ETF",
          chartPreviousClose: 112.4,
          regularMarketPrice: 114.8,
        },
        timestamp: [1760313600, 1760400000],
        indicators: {
          quote: [{ open: [112, 114], high: [113, 115], low: [111, 113], close: [112.4, 114.8], volume: [1000, 1200] }],
          adjclose: [{ adjclose: [112.4, 114.8] }],
        },
      },
    ],
  },
};

async function main() {
  const originalFetch = globalThis.fetch;

  await test("fetchYahooChart: candle parsing unchanged, plus new previousClose/regularMarketPrice fields populated", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(FIXTURE_CHART_JSON), { status: 200 })) as typeof fetch;
    const result = await fetchYahooChart("0050.TW");
    assert.equal(result?.candles.length, 2);
    assert.equal(result?.candles[1]?.close, 114.8);
    assert.equal(result?.previousClose, 112.4);
    assert.equal(result?.regularMarketPrice, 114.8);
  });

  await test("fetchYahooChartPeriod: same fixture, same new fields, candles still parse", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify(FIXTURE_CHART_JSON), { status: 200 })) as typeof fetch;
    const result = await fetchYahooChartPeriod("0050.TW", 1760313600, 1760400000);
    assert.equal(result?.candles.length, 2);
    assert.equal(result?.previousClose, 112.4);
    assert.equal(result?.regularMarketPrice, 114.8);
  });

  await test("fetchYahooChart: a response with no meta fields at all still parses candles, new fields are null", async () => {
    const noMeta = { chart: { result: [{ meta: {}, timestamp: [1760313600], indicators: { quote: [{ close: [100] }] } }] } };
    globalThis.fetch = (async () => new Response(JSON.stringify(noMeta), { status: 200 })) as typeof fetch;
    const result = await fetchYahooChart("TEST");
    assert.equal(result?.candles.length, 1);
    assert.equal(result?.previousClose, null);
    assert.equal(result?.regularMarketPrice, null);
  });

  globalThis.fetch = originalFetch;
}

await main();
