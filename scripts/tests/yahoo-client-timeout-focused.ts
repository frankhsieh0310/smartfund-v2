// Regression test for the 2026-10-08 timeout fix: fetchYahooChart, fetchYahooQuotes and
// fetchYahooChartPeriod in lib/services/dataProviders/yahoo/yahooClient.ts must pass an
// AbortSignal to fetch() — without it, a stalled Yahoo connection hangs the calling cron
// (CLOUD_ETF_PRICE) until Vercel's hard maxDuration kill, as confirmed live in Production.
// No network call is made: global.fetch is stubbed to capture and assert on the call options.
import assert from 'node:assert/strict';
import { fetchYahooChart, fetchYahooQuotes, fetchYahooChartPeriod } from '../../lib/services/dataProviders/yahoo/yahooClient';

type Capture = { url: string; init?: RequestInit };
let captured: Capture[] = [];

const originalFetch = global.fetch;
function stubFetch(jsonBody: unknown) {
  captured = [];
  global.fetch = (async (url: string, init?: RequestInit) => {
    captured.push({ url: String(url), init });
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => jsonBody,
    } as unknown as Response;
  }) as typeof fetch;
}

async function main() {
  stubFetch({ chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{}], adjclose: [{}] } }] } });
  await fetchYahooChart('AAPL');
  assert.equal(captured.length, 1);
  assert.ok(captured[0].init?.signal instanceof AbortSignal, 'fetchYahooChart must pass an AbortSignal');
  console.log('fetchYahooChart: PASS (signal present)');

  stubFetch({ quoteResponse: { result: [] } });
  await fetchYahooQuotes(['AAPL', 'MSFT']);
  assert.equal(captured.length, 1);
  assert.ok(captured[0].init?.signal instanceof AbortSignal, 'fetchYahooQuotes must pass an AbortSignal');
  console.log('fetchYahooQuotes: PASS (signal present)');

  stubFetch({ chart: { result: [{ meta: {}, timestamp: [], indicators: { quote: [{}], adjclose: [{}] } }] } });
  await fetchYahooChartPeriod('0050.TW', 1000, 2000);
  assert.equal(captured.length, 1);
  assert.ok(captured[0].init?.signal instanceof AbortSignal, 'fetchYahooChartPeriod must pass an AbortSignal (this is what CLOUD_ETF_PRICE calls directly)');
  console.log('fetchYahooChartPeriod: PASS (signal present)');

  global.fetch = originalFetch;
}

main()
  .then(() => console.log('YAHOO_CLIENT_TIMEOUT_REGRESSION: PASS'))
  .catch((e) => {
    global.fetch = originalFetch;
    console.error(e);
    process.exitCode = 1;
  });
