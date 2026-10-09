import { CtbcOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/ctbc.ts";
const TICKERS = [
  "00406A", "00752", "00753L", "00882", "00891", "00894", "00896", "00902", "00912", "00917",
  "00934", "00941", "00954", "00956", "00963", "00964", "009800", "009801", "009819", "009828",
  "00983A", "00995A", "00772B", "00773B", "00795B", "00847B", "00848B", "00849B", "00862B",
  "00863B", "00864B", "00884B", "00928", "00948B", "00955", "00981D",
];
async function main() {
  let anyDup = false;
  for (const t of TICKERS) {
    const snap = await CtbcOfficialPcfAdapter.fetchSnapshot(t, "2026-09-24");
    const seen = new Map<string, number>();
    for (const p of snap.positions) seen.set(p.securityCode, (seen.get(p.securityCode) ?? 0) + 1);
    const dups = [...seen.entries()].filter(([, c]) => c > 1);
    if (dups.length) { anyDup = true; console.log(JSON.stringify({ ticker: t, positionCount: snap.positions.length, dups })); }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!anyDup) console.log("ALL_36_CLEAN");
}
main().catch((e) => console.error("FAILED:", e));
