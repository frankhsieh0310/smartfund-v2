// Focused verification only — 00860B / 009823, no DB write, no full-331 refetch.
import { CapitalOfficialPcfAdapter } from "../lib/etf-holdings-engine/adapters/capital.ts";

const TARGETS = ["00860B", "009823"];

async function main() {
  for (const t of TARGETS) {
    const snap = await CapitalOfficialPcfAdapter.fetchSnapshot(t);
    const seen = new Map<string, number>();
    for (const p of snap.positions) seen.set(p.securityCode, (seen.get(p.securityCode) ?? 0) + 1);
    const dups = [...seen.entries()].filter(([, c]) => c > 1);
    const cashRows = snap.positions.filter((p) => p.securityName === "Cash" || p.securityName === "現金");
    console.log(JSON.stringify({
      ticker: t, dataDate: snap.dataDate, positionCount: snap.positions.length,
      duplicateSecurityCodes: dups,
      cashRows: cashRows.map((p) => ({ code: p.securityCode, name: p.securityName, amount: p.positionAmount })),
    }, null, 2));
    await new Promise((r) => setTimeout(r, 400));
  }
}
main();
