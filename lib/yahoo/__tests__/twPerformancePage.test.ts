import assert from "node:assert/strict";
import { fetchYahooTwPerformance, YahooTwRateLimitedError } from "../twPerformancePage.ts";

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
<script>root.App.main = {"context":{"performerConfig":undefined,"dispatcher":{"stores":{"QuoteSummaryStore":{"performance":{"volumeK":"106348.658","totalReturn":{"price_1w":"-3.52","price_1m":"5.15","price_3m":"6.68","price_6m":"40.31","priceYtd":"71.29","price_1y":"87.99","price_2yl":"56.06","price_3yl":"55.98","price_5yl":"31.41","price_10yl":"23.95"},"navReturn":{"nav_1w":"-1.51","nav_1m":"6.49","nav_3m":"9.38","nav_6m":"42.06","navYtd":"77.21","nav_1y":"89.64","nav_2yl":"56.64","nav_3yl":"55.10","nav_5yl":"29.49","nav_10yl":"21.47"},"changeData":{"price":"-0.20","percent":"0.17"}}}}}}};
</script>
<div>註：以 2026/10/12 為基準日，依淨值計算</div>
</body></html>`;

async function main() {
  const originalFetch = globalThis.fetch;

  await test("fetchYahooTwPerformance: parses navReturn/priceReturn and asOfDate from the page bootstrap JSON", async () => {
    globalThis.fetch = (async () => new Response(FIXTURE_HTML, { status: 200 })) as typeof fetch;
    const result = await fetchYahooTwPerformance("0050.TW");
    assert.equal(result?.asOfDate, "2026-10-12");
    assert.equal(result?.navReturn.y1, 89.64);
    assert.equal(result?.priceReturn.y1, 87.99);
    assert.equal(result?.navReturn.m1, 6.49);
    assert.equal(result?.navReturn.m3, 9.38);
  });

  await test("fetchYahooTwPerformance: survives the surrounding blob not being valid whole-document JSON (bare `undefined`)", async () => {
    globalThis.fetch = (async () => new Response(FIXTURE_HTML, { status: 200 })) as typeof fetch;
    // The fixture's bootstrap blob intentionally contains a bare `undefined` value elsewhere in the
    // object (someUndefinedField) -- JSON.parse on the WHOLE blob would throw; this must still work
    // because we only ever parse the isolated "performance" sub-object.
    const result = await fetchYahooTwPerformance("0050.TW");
    assert.ok(result !== null);
  });

  await test("fetchYahooTwPerformance: 429 throws YahooTwRateLimitedError, not a generic error", async () => {
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    await assert.rejects(() => fetchYahooTwPerformance("0050.TW"), YahooTwRateLimitedError);
  });

  await test("fetchYahooTwPerformance: a non-200, non-rate-limit response returns null, not a throw", async () => {
    globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    const result = await fetchYahooTwPerformance("9999.TW");
    assert.equal(result, null);
  });

  await test("fetchYahooTwPerformance: a page with no matching bootstrap blob returns null", async () => {
    globalThis.fetch = (async () => new Response("<html><body>no data here</body></html>", { status: 200 })) as typeof fetch;
    const result = await fetchYahooTwPerformance("0050.TW");
    assert.equal(result, null);
  });

  globalThis.fetch = originalFetch;
}

await main();
