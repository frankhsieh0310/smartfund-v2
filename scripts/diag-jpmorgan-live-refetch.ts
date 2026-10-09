import { JpmorganOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/jpmorgan.ts";
async function main() {
  const snap = await JpmorganOfficialPcfAdapter.fetchSnapshot("00401A");
  const seen = new Map<string, number>();
  for (const p of snap.positions) seen.set(p.securityCode, (seen.get(p.securityCode) ?? 0) + 1);
  console.log(JSON.stringify({
    dataDate: snap.dataDate, positionCount: snap.positions.length,
    duplicates: [...seen.entries()].filter(([, c]) => c > 1),
    positions: snap.positions,
  }, null, 2));
}
main().catch((e) => console.error("FAILED:", e));
