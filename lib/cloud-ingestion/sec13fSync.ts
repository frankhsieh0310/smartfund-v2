// SEC EDGAR 13F-HR sync — fetches the official quarterly 13F holdings filing for the small, curated
// institutional_institutions universe (16 rows, CIKs already resolved) once each quarter's filing
// deadline has passed. Mirrors the same three-table shape the existing historical data was loaded
// into (institutional_filings -> institutional_portfolio_snapshots -> institutional_holdings) and the
// existing cusip-unresolved queue (institutional_security_mapping_queue) — this does not invent a new
// schema, it fills the one that is already there and already has 93% of its data from a one-time
// manual load.
//
// SEC fair-access rules (not negotiable, per CLAUDE.md's "遇到401/403/429就停下來回報，不准繞過"):
//   - User-Agent must name the app and a real contact email (SEC_USER_AGENT env var, same convention
//     already used by app/api/cron/cloud-sec-financial-incremental/route.ts).
//   - Max ~10 req/sec. REQUEST_DELAY_MS below (300ms) keeps us under 4 req/sec with margin.
//   - On 403/429/5xx: stop this institution's attempt, record the failure, move on — never retry in a
//     tight loop, never change the User-Agent to work around a block.

const SEC_HEADERS = { Accept: "application/json, text/xml, application/xml", "User-Agent": process.env.SEC_USER_AGENT ?? "SmartFund data platform contact@smartfund.app" };
export const REQUEST_DELAY_MS = 300;

export class SecHttpError extends Error {
  constructor(public httpStatus: number, message: string) { super(message); }
}

async function secFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, { headers: SEC_HEADERS, signal: controller.signal });
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      throw new SecHttpError(response.status, `SEC EDGAR HTTP_${response.status} for ${url}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 13F-HR filing deadlines: 45 days after each quarter end (2/14, 5/15, 8/14, 11/14 in a non-leap
// year — SEC states the deadline as "45 days after quarter end", which lands on 2/14 (or 2/15 in a
// leap year, since Q4 ends 12/31); computed below rather than hardcoded so a leap year is handled
// correctly instead of silently wrong.
function addDaysUTC(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** The most recent calendar-quarter-end whose 45-day 13F deadline has already passed, as of `now`. */
export function latestExpectedReportingPeriod(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const quarterEnds = [
    new Date(Date.UTC(year - 1, 11, 31)), // Q4 of prior year
    new Date(Date.UTC(year, 2, 31)),      // Q1 (Mar 31)
    new Date(Date.UTC(year, 5, 30)),      // Q2 (Jun 30)
    new Date(Date.UTC(year, 8, 30)),      // Q3 (Sep 30)
    new Date(Date.UTC(year, 11, 31)),     // Q4 of this year
  ];
  let latest: Date | null = null;
  for (const periodEnd of quarterEnds) {
    const deadline = addDaysUTC(periodEnd, 45);
    if (deadline.getTime() <= now.getTime() && (!latest || periodEnd.getTime() > latest.getTime())) latest = periodEnd;
  }
  // Fallback should never trigger in practice (there's always a passed deadline by any real `now`
  // after 1980), but keeps this total instead of possibly returning undefined.
  return (latest ?? quarterEnds[0]).toISOString().slice(0, 10);
}

type SecSubmissionsRecent = { form: string[]; accessionNumber: string[]; filingDate: string[]; reportDate: string[]; primaryDocument: string[] };

export async function findLatest13FFiling(cik: string, periodEnd: string): Promise<{ accessionNumber: string; filingDate: string; reportDate: string } | null> {
  const padded = cik.replace(/\D/g, "").padStart(10, "0");
  const response = await secFetch(`https://data.sec.gov/submissions/CIK${padded}.json`);
  if (response.status === 404) return null; // no EDGAR submissions history for this CIK — not a failure, just nothing to do
  if (!response.ok) throw new SecHttpError(response.status, `submissions fetch failed: ${response.status}`);
  const data = (await response.json()) as { filings: { recent: SecSubmissionsRecent } };
  const recent = data.filings.recent;
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === "13F-HR" && recent.reportDate[i] === periodEnd) {
      return { accessionNumber: recent.accessionNumber[i], filingDate: recent.filingDate[i], reportDate: recent.reportDate[i] };
    }
  }
  return null;
}

/** Finds the actual information-table XML file inside a filing's folder — its filename is not
 * predictable (e.g. "infotable.xml" for some filers, a bare numeric doc id like "56757.xml" for
 * others), so this reads the filing's own index rather than guessing a fixed name. */
export async function findInformationTableUrl(cik: string, accessionNumber: string): Promise<string | null> {
  // EDGAR's /Archives/edgar/data/ path wants the CIK WITHOUT leading zeros (unlike the
  // data.sec.gov/submissions/ API, which wants it zero-padded to 10 digits) — verified against a
  // real filing: .../data/1067983/... works, .../data/0001067983/... 404s.
  const bareCik = cik.replace(/\D/g, "").replace(/^0+/, "") || "0";
  const accessionNoDashes = accessionNumber.replace(/-/g, "");
  const response = await secFetch(`https://www.sec.gov/Archives/edgar/data/${bareCik}/${accessionNoDashes}/index.json`);
  if (!response.ok) throw new SecHttpError(response.status, `filing index fetch failed: ${response.status}`);
  const data = (await response.json()) as { directory: { item: Array<{ name: string }> } };
  const xmlFiles = data.directory.item.filter((item) => /\.xml$/i.test(item.name) && !/primary_doc/i.test(item.name));
  if (!xmlFiles.length) return null;
  // The information table is always the (one) non-primary-doc XML file in a 13F-HR filing folder.
  const chosen = xmlFiles[0].name;
  return `https://www.sec.gov/Archives/edgar/data/${bareCik}/${accessionNoDashes}/${chosen}`;
}

export type InfoTableRow = {
  nameOfIssuer: string;
  titleOfClass: string | null;
  cusip: string | null;
  // VERIFIED against a real filing (Berkshire Hathaway, CIK 1067983, period 2026-06-30): Ally
  // Financial, value=577211815, shares=12561737 -> $45.95/share, Ally's real trading range -- this
  // is whole USD dollars. Older SEC guidance describes the 13F `value` field as reported in
  // thousands, but the 2023 SEC XML-schema update to Form 13F moved it to whole dollars; do not
  // re-apply a *1000 scale anywhere this field is consumed.
  value: number | null;
  shares: number | null;
  shareOrPrincipalType: string | null;
  putCall: string | null;
  investmentDiscretion: string | null;
  otherManager: string | null;
  votingSole: number | null;
  votingShared: number | null;
  votingNone: number | null;
};

function tagText(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? match[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">") : null;
}

function tagNumber(block: string, tag: string): number | null {
  const text = tagText(block, tag);
  if (text == null) return null;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Regex-based parse, matching the lightweight XML-handling convention already used for RSS feeds
 * elsewhere in this codebase (lib/consensus/sourceFetch.ts) rather than adding a new XML-parser
 * dependency for one flat, well-known SEC schema. */
export function parseInformationTable(xml: string): InfoTableRow[] {
  const blocks = xml.match(/<infoTable[^>]*>[\s\S]*?<\/infoTable>/gi) ?? [];
  return blocks.map((block) => {
    const votingBlock = block.match(/<votingAuthority[^>]*>[\s\S]*?<\/votingAuthority>/i)?.[0] ?? "";
    return {
      nameOfIssuer: tagText(block, "nameOfIssuer") ?? "UNKNOWN",
      titleOfClass: tagText(block, "titleOfClass"),
      cusip: tagText(block, "cusip"),
      value: tagNumber(block, "value"),
      shares: tagNumber(block, "sshPrnamt"),
      shareOrPrincipalType: tagText(block, "sshPrnamtType"),
      putCall: tagText(block, "putCall"),
      investmentDiscretion: tagText(block, "investmentDiscretion"),
      otherManager: tagText(block, "otherManager"),
      votingSole: tagNumber(votingBlock, "Sole"),
      votingShared: tagNumber(votingBlock, "Shared"),
      votingNone: tagNumber(votingBlock, "None"),
    };
  }).filter((row) => row.cusip != null);
}

export { secFetch };
