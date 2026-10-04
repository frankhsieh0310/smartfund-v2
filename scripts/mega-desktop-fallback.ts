// Mega-only desktop fallback — PoC, not yet scheduled. Run manually from a normal residential/office
// network (NOT Vercel, NOT GitHub Actions — both are confirmed blocked by Mega's own WAF with an
// identical HTTP 403 "Access Denied", live-probed from both). Intended to eventually run under Windows
// Task Scheduler, timed to follow Mega's own daily official-holdings publication window — not set up
// yet; this script only needs `MEGA_DESKTOP_INGEST_URL` and `MEGA_DESKTOP_INGEST_SECRET` in the
// environment to run as-is.
//
// Fetches every Mega ticker using the EXACT SAME adapter (MegaOfficialPcfAdapter) and canonical-
// snapshot schema the cloud route would have used, then POSTs each successfully-fetched snapshot to
// the Mega-desktop ingest endpoint (app/api/cron/etf-official-holdings-mega-desktop-ingest/route.ts).
// This process never touches the Production DB directly — only HTTPS POST to that one authenticated
// endpoint, which does its own full validation before persisting anything.
//
// Every failure (fetch, network, non-2xx ingest response) is logged explicitly to stderr with the
// ticker and reason — never silently skipped or reported as success. Exit code is non-zero if ANY
// ticker failed, so Task Scheduler (once configured) can alert on a non-zero exit.
import { MegaOfficialPcfAdapter, FUND_ID_MAP } from "../lib/etf-holdings-engine/adapters/mega";

const INGEST_URL = process.env.MEGA_DESKTOP_INGEST_URL;
const INGEST_SECRET = process.env.MEGA_DESKTOP_INGEST_SECRET;

type TickerResult = { ticker: string; ok: boolean; detail: string };

async function runOne(ticker: string): Promise<TickerResult> {
  let snap;
  try {
    snap = await MegaOfficialPcfAdapter.fetchSnapshot(ticker);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[mega-desktop-fallback] FETCH_FAILED ticker=${ticker} error=${message}`);
    return { ticker, ok: false, detail: `fetch_failed: ${message}` };
  }

  let res: Response;
  try {
    res = await fetch(INGEST_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_SECRET}` },
      body: JSON.stringify(snap),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[mega-desktop-fallback] INGEST_NETWORK_FAILED ticker=${ticker} error=${message}`);
    return { ticker, ok: false, detail: `ingest_network_failed: ${message}` };
  }

  const text = await res.text();
  if (!res.ok) {
    console.error(`[mega-desktop-fallback] INGEST_HTTP_${res.status} ticker=${ticker} body=${text.slice(0, 300)}`);
    return { ticker, ok: false, detail: `ingest_http_${res.status}: ${text.slice(0, 300)}` };
  }

  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed?.ok) {
    console.error(`[mega-desktop-fallback] INGEST_REJECTED ticker=${ticker} body=${text.slice(0, 300)}`);
    return { ticker, ok: false, detail: `ingest_rejected: ${text.slice(0, 300)}` };
  }

  console.log(`[mega-desktop-fallback] OK ticker=${ticker} skipped=${parsed.skipped ?? false} snapshotId=${parsed.snapshotId ?? "n/a"} positionsCount=${parsed.positionsCount ?? snap.positions.length}`);
  return { ticker, ok: true, detail: "ok" };
}

// Optional single-ticker canary: `--ticker 00690` (or `--ticker=00690`) restricts the run to exactly
// one ticker, for a one-off Production end-to-end check without touching the rest of today's Mega
// universe. Omit the flag and every Mega ticker runs, unchanged — this never alters the default path.
function parseCanaryTicker(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--ticker") return argv[i + 1];
    if (arg.startsWith("--ticker=")) return arg.slice("--ticker=".length);
  }
  return undefined;
}

async function main() {
  if (!INGEST_URL || !INGEST_SECRET) {
    console.error("[mega-desktop-fallback] MISSING_CONFIG: set MEGA_DESKTOP_INGEST_URL and MEGA_DESKTOP_INGEST_SECRET");
    process.exit(1);
  }

  const canaryTicker = parseCanaryTicker(process.argv.slice(2));
  let tickers = Object.keys(FUND_ID_MAP);
  if (canaryTicker !== undefined) {
    if (!(canaryTicker in FUND_ID_MAP)) {
      console.error(`[mega-desktop-fallback] UNKNOWN_CANARY_TICKER: ${canaryTicker} is not in the Mega FUND_ID_MAP`);
      process.exit(1);
    }
    tickers = [canaryTicker];
    console.log(`[mega-desktop-fallback] CANARY MODE: restricted to single ticker ${canaryTicker}`);
  }
  console.log(`[mega-desktop-fallback] starting, ${tickers.length} Mega ticker(s), ingest=${INGEST_URL}`);

  const results: TickerResult[] = [];
  for (const ticker of tickers) {
    results.push(await runOne(ticker));
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`[mega-desktop-fallback] done: ${results.length - failed.length}/${results.length} succeeded`);
  if (failed.length) {
    console.error(`[mega-desktop-fallback] FAILURES: ${failed.map((f) => `${f.ticker}(${f.detail})`).join("; ")}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
