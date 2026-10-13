// 投信投顧公會 (SITCA) 「基金配息資料」 (IN2213.aspx) -- a classic ASP.NET WebForms page, not a REST
// API: a GET first to obtain __VIEWSTATE/__VIEWSTATEGENERATOR/__EVENTVALIDATION, then a POST of those
// plus the query fields (ddlQ_YM month, rdo1="rbComid" + ddlQ_Comid="" for "所有公司") back to the
// SAME URL, which returns a full HTML page with the result table embedded (id=QryTable is just the
// filter form; the actual data is a plain inner <table> further down, rows marked class='DTeven').
// Live-verified: a single query for one month returns the WHOLE market (~1,500 rows across all 36
// member companies) in one request -- no per-company iteration needed.
import type { SitcaDividendRow } from "./types";

export const SITCA_DIVIDEND_URL = "https://www.sitca.org.tw/ROC/Industry/IN2213.aspx?pid=IN2222_03";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class RateLimitedError extends Error {
  httpStatus: number;
  constructor(status: number) {
    super(`SITCA_RATE_LIMITED_${status}`);
    this.httpStatus = status;
  }
}

function extractHiddenField(html: string, name: string): string {
  const m = new RegExp(`id="${name}" value="([^"]*)"`).exec(html);
  if (!m) throw new Error(`SITCA_MISSING_FIELD_${name}`);
  return m[1];
}

/** All "YYYYMM" option values currently offered by the page's own year-month dropdown -- discovered
 * live, never hardcoded, so this naturally picks up new months as SITCA publishes them. */
export function extractAvailableMonths(html: string): string[] {
  // SITCA renders the currently-selected option (always the newest month) with its attributes in a
  // different order -- <option selected="selected" value="...">, not <option value="...">. A regex
  // anchored to "<option value=" immediately would silently drop exactly that one option every time,
  // permanently hiding the newest month. Match value="..." anywhere inside the <option ...> tag instead.
  const re = /<option\b[^>]*\bvalue="(\d{6})"/g;
  const months: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) months.push(m[1]);
  return [...new Set(months)];
}

async function fetchPage(): Promise<string> {
  const res = await fetch(SITCA_DIVIDEND_URL, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new RateLimitedError(res.status);
  if (!res.ok) throw new Error(`SITCA_HTTP_${res.status}`);
  return res.text();
}

export async function fetchAvailableMonths(): Promise<string[]> {
  return extractAvailableMonths(await fetchPage());
}

function parseDate(yyyymmdd: string | undefined): string | null {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return null;
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

export function parseResultTable(html: string): SitcaDividendRow[] {
  const headerIdx = html.indexOf("DTHeader");
  if (headerIdx === -1) return []; // no results table at all for this month (e.g. not yet published)
  const tableStart = html.lastIndexOf("<table>", headerIdx);
  const tableEnd = html.indexOf("</table>", headerIdx);
  if (tableStart === -1 || tableEnd === -1) return [];
  const tableHtml = html.slice(tableStart, tableEnd);

  const rows: SitcaDividendRow[] = [];
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(tableHtml))) {
    const rowHtml = rowMatch[1];
    if (!rowHtml.includes("DTeven") && !rowHtml.includes("DTodd")) continue; // header row
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowHtml))) cells.push(cellMatch[1].trim());
    if (cells.length < 8) continue;
    const [fundType, taxId, fundName, currency, baseDateRaw, exDateRaw, payDateRaw, amountRaw] = cells;
    const exDate = parseDate(exDateRaw);
    const baseDate = parseDate(baseDateRaw);
    const amount = Number(amountRaw);
    if (!taxId || !fundName || !currency || !exDate || !baseDate || !Number.isFinite(amount) || amount <= 0) continue;
    rows.push({ fundType, taxId, fundName, currency, baseDate, exDate, payDate: parseDate(payDateRaw), amount });
  }
  return rows;
}

/** One month, whole market ("所有公司"), in a single request. yearMonth is "YYYYMM". */
export async function fetchSitcaDividendsForMonth(yearMonth: string): Promise<SitcaDividendRow[]> {
  const getHtml = await fetchPage();
  const viewstate = extractHiddenField(getHtml, "__VIEWSTATE");
  const viewstategen = extractHiddenField(getHtml, "__VIEWSTATEGENERATOR");
  const eventvalidation = extractHiddenField(getHtml, "__EVENTVALIDATION");

  const body = new URLSearchParams({
    __EVENTTARGET: "", __EVENTARGUMENT: "", __LASTFOCUS: "",
    __VIEWSTATE: viewstate, __VIEWSTATEGENERATOR: viewstategen, __EVENTVALIDATION: eventvalidation,
    "ctl00$ContentPlaceHolder1$ddlQ_YM": yearMonth,
    "ctl00$ContentPlaceHolder1$rdo1": "rbComid",
    "ctl00$ContentPlaceHolder1$ddlQ_Comid": "",
    "ctl00$ContentPlaceHolder1$BtnQuery": "查詢",
  });
  const postRes = await fetch(SITCA_DIVIDEND_URL, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (postRes.status === 401 || postRes.status === 403 || postRes.status === 429) throw new RateLimitedError(postRes.status);
  if (!postRes.ok) throw new Error(`SITCA_HTTP_${postRes.status}`);
  const postHtml = await postRes.text();
  return parseResultTable(postHtml);
}
