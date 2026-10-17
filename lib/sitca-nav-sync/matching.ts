// Pure matching logic — no DB, no network — so it's unit-testable in isolation. Task Z Part A2
// VERIFIED live: code-matching (SITCA's 基金統編 == funds.code) finds 4,128/4,326 rows (95.4%);
// normalized-name fallback (NFKC + whitespace-strip + 臺->台) finds another 11 (95.7% total); the
// remaining ~187 rows have no match at all in `funds` under either key — those are reported as
// unmatched, NEVER created as new funds (explicit, user-stated constraint on this pipeline).

// 2026-10-18: added `company` (公司名稱) for lib/cron/newFundListingDetection.ts's fund-creation step
// only -- matching.ts/navWriter.ts themselves still NEVER create a fund (see the unmatched-rows note
// above, unchanged); this field is simply carried through so that separate, explicitly-scoped
// pipeline doesn't need its own CSV fetch/parse.
export type SitcaRawRow = { taxId: string; name: string; nav: number; navDate: string; currency: string; company?: string };
export type FundRow = { id: string; code: string | null; name: string; currency: string };

export function nfkcNameKey(name: string): string {
  return String(name ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/臺/g, "台").toLowerCase();
}

export type MatchResult = {
  fundId: string;
  navDate: string;
  nav: number;
  matchedBy: "CODE" | "NAME";
  // SITCA's own currency label for this row, and the matched fund's currency — carried through
  // unchanged so the caller can apply the write-eligibility currency gate (Task Z Part 2 pre-check:
  // funds.currency is fund-family-level, not per-class, so a mismatch here is reported and excluded
  // from writes, never silently written or treated as a match failure).
  sitcaCurrency: string;
  fundCurrency: string;
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
      matched.push({ fundId: byCodeHit.id, navDate: row.navDate, nav: row.nav, matchedBy: "CODE", sitcaCurrency: row.currency, fundCurrency: byCodeHit.currency });
      continue;
    }
    const nameHits = byName.get(nfkcNameKey(row.name));
    if (nameHits && nameHits.length === 1) {
      matched.push({ fundId: nameHits[0].id, navDate: row.navDate, nav: row.nav, matchedBy: "NAME", sitcaCurrency: row.currency, fundCurrency: nameHits[0].currency });
      continue;
    }
    unmatched.push(row); // no match, or ambiguous (multiple funds share this normalized name)
  }

  return { matched, unmatched };
}
