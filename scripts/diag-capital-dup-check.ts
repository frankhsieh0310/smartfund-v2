// Bounded diagnosis only — no DB write, no full-331 refetch. Checks Capital's futures/rps/assets-bearing
// ETFs (the structural suspects: futures use txDesc as securityCode, rps use bondsName, assets use asDesc
// — all description text, not real codes) for duplicate securityCode within one snapshot.
import { CapitalOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/capital.ts";

const SUSPECTS = ["00685L", "00860B", "009823"];

async function main() {
  for (const t of SUSPECTS) {
    const snap = await CapitalOfficialPcfAdapter.fetchSnapshot(t);
    const seen = new Map<string, number>();
    for (const p of snap.positions) seen.set(p.securityCode, (seen.get(p.securityCode) ?? 0) + 1);
    const dups = [...seen.entries()].filter(([, c]) => c > 1);
    console.log(JSON.stringify({
      ticker: t, dataDate: snap.dataDate, positionCount: snap.positions.length,
      duplicateSecurityCodes: dups,
      sampleFutures: snap.positions.filter((p) => p.positionType === "FUTURE").map((p) => p.securityCode),
      sampleOther: snap.positions.filter((p) => p.positionType === "OTHER").map((p) => p.securityCode),
    }, null, 2));
    await new Promise((r) => setTimeout(r, 400));
  }
}
main();
