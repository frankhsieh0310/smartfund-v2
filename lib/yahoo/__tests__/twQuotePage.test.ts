import assert from "node:assert/strict";
import { fetchYahooTwDayChange, YahooTwQuoteRateLimitedError } from "../twQuotePage.ts";

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

// Mirrors Yahoo奇摩's real markup: the sign lives only in the trend-up/trend-down class, never a
// literal "-" in the text, and 漲跌幅 must not be confused with 漲跌 by a naive substring search.
const DOWN_FIXTURE_HTML = `<html><body>
<li class="price-detail-item"><span>漲跌幅</span><span class="Fw(600) C($c-trend-down)">2.09%</span></li>
<li class="price-detail-item"><span>漲跌</span><span class="Fw(600) C($c-trend-down)">2.40</span></li>
</body></html>`;

const UP_FIXTURE_HTML = `<html><body>
<li class="price-detail-item"><span>漲跌幅</span><span class="Fw(600) C($c-trend-up)">1.23%</span></li>
<li class="price-detail-item"><span>漲跌</span><span class="Fw(600) C($c-trend-up)">0.85</span></li>
</body></html>`;

async function main() {
  const originalFetch = globalThis.fetch;

  await test("fetchYahooTwDayChange: copies a down day's 漲跌/漲跌幅 verbatim, both negative", async () => {
    globalThis.fetch = (async () => new Response(DOWN_FIXTURE_HTML, { status: 200 })) as typeof fetch;
    const result = await fetchYahooTwDayChange("0050.TW");
    assert.equal(result?.change, -2.4);
    assert.equal(result?.changePercent, -2.09);
  });

  await test("fetchYahooTwDayChange: copies an up day's 漲跌/漲跌幅 verbatim, both positive", async () => {
    globalThis.fetch = (async () => new Response(UP_FIXTURE_HTML, { status: 200 })) as typeof fetch;
    const result = await fetchYahooTwDayChange("0056.TW");
    assert.equal(result?.change, 0.85);
    assert.equal(result?.changePercent, 1.23);
  });

  await test("fetchYahooTwDayChange: 429 throws YahooTwQuoteRateLimitedError", async () => {
    globalThis.fetch = (async () => new Response("", { status: 429 })) as typeof fetch;
    await assert.rejects(() => fetchYahooTwDayChange("0050.TW"), YahooTwQuoteRateLimitedError);
  });

  await test("fetchYahooTwDayChange: missing fields in the page returns null, not a throw", async () => {
    globalThis.fetch = (async () => new Response("<html><body>nothing here</body></html>", { status: 200 })) as typeof fetch;
    const result = await fetchYahooTwDayChange("9999.TW");
    assert.equal(result, null);
  });

  globalThis.fetch = originalFetch;
}

await main();
