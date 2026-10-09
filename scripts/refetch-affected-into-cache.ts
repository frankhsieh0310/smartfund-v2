// Targeted re-fetch of ONLY the tickers whose identity bug was just fixed (not all 331), then merges
// the corrected snapshots back into the existing runtime/etf-holdings-fetch-cache/latest-fetch-batch.json
// in place. Every other cached ticker (already 331/331 clean) is left untouched.
import * as fs from "fs";
import * as path from "path";
import type { OfficialPcfAdapter } from "../lib/etf-holdings-engine/types.ts";
import { CtbcOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/ctbc.ts";
import { YuantaOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/yuanta.ts";
import { BlackRockOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/blackrock.ts";
import { JpmorganOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/jpmorgan.ts";
import { TaishinOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/taishin.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE_PATH = path.join(ROOT, "runtime", "etf-holdings-fetch-cache", "latest-fetch-batch.json");
const CTBC_EXPLICIT_DATE = "2026-09-24";

const CTBC_TICKERS = [
  "00406A", "00752", "00753L", "00882", "00891", "00894", "00896", "00902", "00912", "00917",
  "00934", "00941", "00954", "00956", "00963", "00964", "009800", "009801", "009819", "009828",
  "00983A", "00995A", "00772B", "00773B", "00795B", "00847B", "00848B", "00849B", "00862B",
  "00863B", "00864B", "00884B", "00928", "00948B", "00955", "00981D",
];

// Second-pass identity refinements: CTBC (name_+cur_ combined) and BlackRock (maturity+name for bonds,
// asset class for FX/cash) needed a follow-up fix after the first pass. JPMorgan/Yuanta already clean
// and already merged — not re-fetched again here.
const TAISHIN_TICKERS = [
  "00703", "00775B", "00851", "00904", "00936", "00947", "00951", "00962", "009805", "00986A",
  "00987A", "00734B", "00842B", "00844B", "00867B", "00942B", "00970B", "009806", "009807",
  "00980B", "00989B",
];

const TARGETS: { issuer: string; adapter: OfficialPcfAdapter; tickers: string[]; explicitDate?: string }[] = [
  { issuer: "Taishin", adapter: TaishinOfficialPcfAdapter, tickers: TAISHIN_TICKERS },
];

async function main() {
  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  const byKey = new Map<string, any>(cache.results.map((r: any) => [`${r.issuer}:${r.ticker}`, r]));

  for (const t of TARGETS) {
    for (const ticker of t.tickers) {
      try {
        const snap = t.explicitDate
          ? await t.adapter.fetchSnapshot(ticker, t.explicitDate)
          : await t.adapter.fetchSnapshot(ticker);
        if (!snap.positions.length) throw new Error("empty positions");
        byKey.set(`${t.issuer}:${ticker}`, { issuer: t.issuer, ticker, snapshot: snap });
        console.error(`[refetch] ${t.issuer} ${ticker} OK (${snap.positions.length} positions)`);
      } catch (e) {
        console.error(`[refetch] ${t.issuer} ${ticker} FAILED:`, e instanceof Error ? e.message : e);
        process.exit(1); // do not silently leave a stale/broken entry in the cache
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  cache.results = [...byKey.values()];
  cache.writtenAt = new Date().toISOString();
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.error(`[refetch] cache updated, ${cache.results.length} total entries`);
}
main();
