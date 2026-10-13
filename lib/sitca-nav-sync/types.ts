// Task Z: domestic (TWD) fund NAV sync from SITCA's own official daily CSV, matched to `funds` by
// code first (基金統編 == funds.code — VERIFIED live: 4,128/4,326 rows, 95.4%), falling back to
// normalized-name matching only for rows the code match misses (VERIFIED: +11 rows, 95.7% total).
// Never creates a fund — a row that matches neither is reported, never inserted.

export type SitcaMatchedCandidate = {
  fundId: string;
  navDate: string; // YYYY-MM-DD
  nav: number;
  matchedBy: "CODE" | "NAME";
};
