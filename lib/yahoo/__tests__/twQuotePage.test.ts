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

const FIXTURE_HTML = `<html><body>
<li>112.40<span>成交</span><span class="Fw(600) C($c-trend-down)">112.40</span></li>
<li class="price-detail-item"><span>昨收</span><span class="Fw(600) Fz(16px)--mobile Fz(14px) D(f) Ai(c)">114.80</span></li>
</body></html>`;

async function main() {
  const originalFetch = globalThis.fetch;

  await test("fetchYahooTwDayChange: parses 成交/昨收 and computes a signed change/changePercent", async () => {
    globalThis.fetch = (async () => new Response(FIXTURE_HTML, { status: 200 })) as typeof fetch;
    const result = await fetchYahooTwDayChange("0050.TW");
    assert.equal(result?.currentPrice, 112.4);
    assert.equal(result?.previousClose, 114.8);
    assert.ok(result!.changePercent < 0, "a price decline must be negative");
    assert.ok(Math.abs(result!.changePercent - -2.09) < 0.01);
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
