import { TaishinOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/taishin.ts";
const TICKERS = [
  "00703", "00775B", "00851", "00904", "00936", "00947", "00951", "00962", "009805", "00986A",
  "00987A", "00734B", "00842B", "00844B", "00867B", "00942B", "00970B", "009806", "009807",
  "00980B", "00989B",
];
async function main() {
  for (const t of TICKERS) {
    try {
      const snap = await TaishinOfficialPcfAdapter.fetchSnapshot(t);
      const maxWeight = Math.max(...snap.positions.map((p) => Math.abs(p.weight)));
      const overflow = snap.positions.some((p) => Math.abs(p.weight) >= 999999.9999) || Math.abs(snap.fundNav) >= 1e20 || Math.abs(snap.outstandingUnits) >= 1e20;
      const bondRows = snap.positions.filter((p) => p.positionType === "BOND").length;
      console.log(JSON.stringify({ ticker: t, positionCount: snap.positions.length, bondRows, maxWeight, overflow }));
    } catch (e) {
      console.log(JSON.stringify({ ticker: t, error: e instanceof Error ? e.message : String(e) }));
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
main();
