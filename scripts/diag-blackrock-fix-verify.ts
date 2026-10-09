import { BlackRockOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/blackrock.ts";
async function main() {
  for (const t of ["009813", "009826", "00991B", "00985D"]) {
    const snap = await BlackRockOfficialPcfAdapter.fetchSnapshot(t);
    const seen = new Map<string, number>();
    for (const p of snap.positions) seen.set(p.securityCode, (seen.get(p.securityCode) ?? 0) + 1);
    console.log(JSON.stringify({
      ticker: t, dataDate: snap.dataDate, positionCount: snap.positions.length,
      duplicates: [...seen.entries()].filter(([, c]) => c > 1),
    }));
    await new Promise((r) => setTimeout(r, 300));
  }
}
main().catch((e) => console.error("FAILED:", e));
