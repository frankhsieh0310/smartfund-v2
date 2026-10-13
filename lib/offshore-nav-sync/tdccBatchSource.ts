// Official, single-file batch source for offshore fund NAV: TDCC's own open-data platform publishes
// ALL approved offshore funds' daily NAV in one CSV (dataset id 3-4, "境外基金－基金淨值",
// https://data.gov.tw/en/datasets/11641), the SAME authority that runs 境外基金資訊觀測站
// (fundclear.com.tw) -- cross-checked 2 funds live against fundclear's own search UI 2026-10-14
// (AXAWAAC: 188.71 EUR/2026-10-12, MFHYA1E: 25.57 EUR/2026-10-12), both exact matches. This is a far
// cheaper and more authoritative alternative to querying Yahoo奇摩 per-fund for the 3,711 "approved but
// unsynced" offshore funds found by this round's QA audit: ONE daily HTTP GET instead of ~3,700
// individually-rate-limited scrapes (which would otherwise take ~1.4-3.4 hours/day, see
// docs/specs/offshore-fund-classification.md).
//
// Our funds.code is NULL for most of these 3,711 funds (never assigned, see offshore-fund-
// classification.md), so this joins by exact fund NAME instead -- same technique already used to
// classify these funds against TDCC's "基本資料" dataset (id 3-2). Verified 2026-10-14: 3,706 of 5,039
// stale (data_provider='yahoo', not updated in 14+ days) funds match a CSV row by exact name --
// consistent with the known 3,711-fund "(b)" population from that earlier classification.
export const TDCC_NAV_CSV_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=3-4";
export const TDCC_NAV_SOURCE = "TDCC_OPENDATA_NAV";

export type TdccNavRow = {
  code: string;
  name: string;
  navDate: string; // YYYY-MM-DD
  nav: number;
  isin: string | null;
  currency: string | null;
};

function toIsoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** Parses the CSV and keeps only the LATEST VALID row per fund name (the CSV carries a rolling
 * ~1-week window per fund, several dates per row). A fund name appearing more than once with the SAME
 * latest date is kept as first-seen (the CSV is one row per fund code, and in this dataset a fund name
 * maps 1:1 to a code -- no de-dup logic beyond "most recent valid date wins" is needed here).
 *
 * "Valid" excludes nav <= 0: confirmed live 2026-10-14 that the source itself publishes a `-9999`
 * sentinel for "not yet reported" on the most recent date for SOME funds (1,759 of 22,946 rows in one
 * fetch, spanning many different 總代理機構 -- not an isolated glitch). Silently falls back to that
 * fund's own most recent genuinely-positive row rather than writing the sentinel or skipping the fund
 * outright. */
export function parseTdccNavCsv(csvText: string): Map<string, TdccNavRow> {
  const byName = new Map<string, TdccNavRow>();
  const lines = csvText.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(",");
    if (parts.length < 6) continue;
    const [code, name, dateRaw, navRaw, isin, currency] = parts;
    const nav = Number(navRaw);
    if (!code || !name || !dateRaw || !Number.isFinite(nav) || nav <= 0) continue;
    const navDate = toIsoDate(dateRaw);
    const existing = byName.get(name);
    if (!existing || existing.navDate < navDate) {
      byName.set(name, { code, name, navDate, nav, isin: isin || null, currency: currency || null });
    }
  }
  return byName;
}

export async function fetchTdccNavCsv(): Promise<string> {
  const res = await fetch(TDCC_NAV_CSV_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`TDCC_NAV_CSV_HTTP_${res.status}`);
  return res.text();
}
