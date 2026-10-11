// Pure matching logic — no DB, no network — so it's unit-testable in isolation. Task Z Part A2
// VERIFIED live: code-matching (SITCA's 基金統編 == funds.code) finds 4,128/4,326 rows (95.4%);
// normalized-name fallback (NFKC + whitespace-strip + 臺->台) finds another 11 (95.7% total); the
// remaining ~187 rows have no match at all in `funds` under either key — those are reported as
// unmatched, NEVER created as new funds (explicit, user-stated constraint on this pipeline).

export type SitcaRawRow = { taxId: string; name: string; nav: number; navDate: string };
export type FundRow = { id: string; code: string | null; name: string };

export function nfkcNameKey(name: string): string {
  return String(name ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/臺/g, "台").toLowerCase();
}

export type MatchResult = {
  fundId: string;
  navDate: string;
  nav: number;
  matchedBy: "CODE" | "NAME";
};

export type MatchOutcome = {
  matched: MatchResult[];
  unmatched: SitcaRawRow[]; // no code match, and either no name match or an ambiguous (multi-fund) name match
};

export function matchSitcaRows(rows: SitcaRawRow[], funds: FundRow[]): MatchOutcome {
  const byCode = new Map<string, FundRow>();
  for (const f of funds) if (f.code) byCode.set(f.code, f);

  const byName = new Map<string, FundRow[]>();
  for (const f of funds) {
    const key = nfkcNameKey(f.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(f);
  }

  const matched: MatchResult[] = [];
  const unmatched: SitcaRawRow[] = [];

  for (const row of rows) {
    const byCodeHit = byCode.get(row.taxId);
    if (byCodeHit) {
      matched.push({ fundId: byCodeHit.id, navDate: row.navDate, nav: row.nav, matchedBy: "CODE" });
      continue;
    }
    const nameHits = byName.get(nfkcNameKey(row.name));
    if (nameHits && nameHits.length === 1) {
      matched.push({ fundId: nameHits[0].id, navDate: row.navDate, nav: row.nav, matchedBy: "NAME" });
      continue;
    }
    unmatched.push(row); // no match, or ambiguous (multiple funds share this normalized name)
  }

  return { matched, unmatched };
}
