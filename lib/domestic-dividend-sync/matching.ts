// Same matching convention as lib/sitca-nav-sync/matching.ts (code-first, name-fallback), reusing its
// nfkcNameKey helper directly rather than re-deriving the normalization rules.
import { nfkcNameKey } from "../sitca-nav-sync/matching";
import type { SitcaDividendRow, FundRow, DividendMatchResult, DividendMatchOutcome } from "./types";

export { nfkcNameKey };

export function matchDividendRows(rows: SitcaDividendRow[], funds: FundRow[]): DividendMatchOutcome {
  const byCode = new Map<string, FundRow>();
  for (const f of funds) if (f.code) byCode.set(f.code, f);

  const byName = new Map<string, FundRow[]>();
  for (const f of funds) {
    const key = nfkcNameKey(f.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(f);
  }

  const matched: DividendMatchResult[] = [];
  const unmatched: SitcaDividendRow[] = [];

  for (const row of rows) {
    const byCodeHit = byCode.get(row.taxId);
    if (byCodeHit) {
      matched.push({ fundId: byCodeHit.id, sitcaCurrency: row.currency, fundCurrency: byCodeHit.currency, matchedBy: "CODE", row });
      continue;
    }
    const nameHits = byName.get(nfkcNameKey(row.fundName));
    if (nameHits && nameHits.length === 1) {
      matched.push({ fundId: nameHits[0].id, sitcaCurrency: row.currency, fundCurrency: nameHits[0].currency, matchedBy: "NAME", row });
      continue;
    }
    unmatched.push(row);
  }

  return { matched, unmatched };
}
