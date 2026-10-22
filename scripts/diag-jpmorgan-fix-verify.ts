import { JpmorganOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/jpmorgan.ts";
async function main() {
  for (const t of ["00401A", "00989A"]) {
    const snap = await JpmorganOfficialPcfAdapter.fetchSnapshot(t);
    const seen = new Map<string, number>();
    for (const p of snap.positions) seen.set(p.securityCode, (seen.get(p.securityCode) ?? 0) + 1);
    console.log(JSON.stringify({
      ticker: t, dataDate: snap.dataDate, positionCount: snap.positions.length,
      duplicates: [...seen.entries()].filter(([, c]) => c > 1),
    }));
  }
}
main().catch((e) => console.error("FAILED:", e));
