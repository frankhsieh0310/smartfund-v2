// SITCA's own ASP.NET WebForms statistics pages — GET the form, read __VIEWSTATE/__VIEWSTATEGENERATOR/
// __EVENTVALIDATION plus the native hidden radio-group value, POST back using the page's own field
// names (no User-Agent spoofing, no bypassing any protection). Verified live 2026-10-31: selecting
// "所有公司" (blank Comid) on both pages returns the ENTIRE market in one request/month — not one
// request per investment-trust company.
const UA = "SmartFund data coverage research contact@smartfund.app";

function extractHidden(html: string, name: string): string {
  const m = html.match(new RegExp(`id="${name}"[^>]*value="([^"]*)"`));
  if (!m) throw new Error(`SITCA_DISCLOSURE_MISSING_FIELD_${name}`);
  return m[1];
}

async function sitcaGetThenPost(url: string, extraFields: Record<string, string>): Promise<string> {
  const getRes = await fetch(url, { headers: { "User-Agent": UA } });
  if (getRes.status === 403) throw Object.assign(new Error("SITCA_DISCLOSURE_HTTP_403"), { blocked: true, httpStatus: 403 });
  if (!getRes.ok) throw new Error(`SITCA_DISCLOSURE_GET_HTTP_${getRes.status}`);
  const setCookie = getRes.headers.get("set-cookie");
  const html = await getRes.text();
  const cookieHeader = setCookie ? setCookie.split(",").map((c) => c.split(";")[0]).join("; ") : "";

  const body = new URLSearchParams({
    __VIEWSTATE: extractHidden(html, "__VIEWSTATE"),
    __VIEWSTATEGENERATOR: extractHidden(html, "__VIEWSTATEGENERATOR"),
    __EVENTVALIDATION: extractHidden(html, "__EVENTVALIDATION"),
    ...extraFields,
  });

  const postRes = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader },
    body: body.toString(),
  });
  if (postRes.status === 403 || postRes.status === 429) {
    throw Object.assign(new Error(`SITCA_DISCLOSURE_HTTP_${postRes.status}`), { blocked: true, httpStatus: postRes.status });
  }
  if (!postRes.ok) throw new Error(`SITCA_DISCLOSURE_POST_HTTP_${postRes.status}`);
  return postRes.text();
}

export type FeeDisclosureRow = {
  baseFundCode: string; // 基金統編 — fund-level, shared by all share classes
  mgmtFeeAmount: number;
  mgmtFeePct: number;
  custodianFeeAmount: number;
  custodianFeePct: number;
  otherFeeAmount: number;
  otherFeePct: number;
  totalFeeAmount: number;
  totalFeePct: number;
};

const FEE_URL = "https://www.sitca.org.tw/ROC/Industry/IN2211.aspx?pid=IN2222_01";

function parseNum(s: string): number {
  return Number(s.replace(/,/g, "").replace("%", "")) || 0;
}

export async function fetchFeeDisclosureAllCompanies(yearMonth6?: string): Promise<{ yearMonth: string; rows: FeeDisclosureRow[] }> {
  const getRes = await fetch(FEE_URL, { headers: { "User-Agent": UA } });
  if (getRes.status === 403) throw Object.assign(new Error("SITCA_FEE_HTTP_403"), { blocked: true, httpStatus: 403 });
  if (!getRes.ok) throw new Error(`SITCA_FEE_GET_HTTP_${getRes.status}`);
  const getHtml = await getRes.text();
  const ymMatch = getHtml.match(/<option selected="selected" value="(\d{4})"/);
  const year = ymMatch ? ymMatch[1] : String(new Date().getUTCFullYear());
  const monthMatch = getHtml.match(/ctl00_ContentPlaceHolder1_ddlQ_M"[\s\S]*?<option selected="selected" value="(\w+)"/);
  const month = yearMonth6?.slice(4) ?? monthMatch?.[1] ?? "1";

  const html = await sitcaGetThenPost(FEE_URL, {
    "ctl00$ContentPlaceHolder1$ddlQ_Y": year,
    "ctl00$ContentPlaceHolder1$ddlQ_M": month,
    "ctl00$ContentPlaceHolder1$ddlQ_Comid": "",
    "ctl00$ContentPlaceHolder1$ddlQ_Fund": "",
    "ctl00$ContentPlaceHolder1$BtnQuery": "查詢",
  });

  // Column order after 類型代號/基金統編/基金名稱 is: 手續費, 交易稅, ETF申購買回交易費 (3 skipped
  // amount+rate pairs), 經理費, 保管費 (captured), 保證費 (skipped), 其他項費用, 合計 (captured) —
  // verified byte-for-byte against both the raw POST response and the live rendered page for
  // 野村鴻運基金/元大2001基金/景順潛力基金 2026-10-31.
  const rowRe =
    /<tr><td class='DT\w+' align=center>[^<]*<\/td><td class='DT\w+' align=left>(\d+)<\/td><td class='DT\w+' align=left>[^<]*(?:<br\s*\/?>[^<]*)*<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td>/g;
  const rows: FeeDisclosureRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    rows.push({
      baseFundCode: m[1],
      mgmtFeeAmount: parseNum(m[2]),
      mgmtFeePct: parseNum(m[3]),
      custodianFeeAmount: parseNum(m[4]),
      custodianFeePct: parseNum(m[5]),
      otherFeeAmount: parseNum(m[6]),
      otherFeePct: parseNum(m[7]),
      totalFeeAmount: parseNum(m[8]),
      totalFeePct: parseNum(m[9]),
    });
  }
  return { yearMonth: `${year}-${month.padStart(2, "0")}`, rows };
}

export type AumDisclosureRow = {
  classCode: string; // exact funds.code, including share-class letter suffix where present
  aumTwd: number;
  navTwd: number;
  unitsOutstanding: number;
  naturalPersonHolders: number;
  institutionalHolders: number;
  totalHolders: number;
  subscriptionTwd: number;
  redemptionTwd: number;
};

const AUM_URL = "https://www.sitca.org.tw/ROC/Industry/IN2201.aspx?pid=IN2221_01";

export async function fetchAumDisclosureAllCompanies(): Promise<{ yearMonth: string; rows: AumDisclosureRow[] }> {
  const getRes = await fetch(AUM_URL, { headers: { "User-Agent": UA } });
  if (getRes.status === 403) throw Object.assign(new Error("SITCA_AUM_HTTP_403"), { blocked: true, httpStatus: 403 });
  if (!getRes.ok) throw new Error(`SITCA_AUM_GET_HTTP_${getRes.status}`);
  const getHtml = await getRes.text();
  const ymMatch = getHtml.match(/<option selected="selected" value="(\d{6})"/);
  const yearMonth6 = ymMatch?.[1];
  if (!yearMonth6) throw new Error("SITCA_AUM_NO_DEFAULT_YEARMONTH");

  const html = await sitcaGetThenPost(AUM_URL, {
    "ctl00$ContentPlaceHolder1$ddlQ_YM": yearMonth6,
    "ctl00$ContentPlaceHolder1$ddlQ_COLUMN": "1",
    "ctl00$ContentPlaceHolder1$rdo1": "rbComid",
    "ctl00$ContentPlaceHolder1$ddlQ_Comid": "",
    "ctl00$ContentPlaceHolder1$ddlQ_CLASS": "0",
    "ctl00$ContentPlaceHolder1$ddlQ_CURRENCY": "",
    "ctl00$ContentPlaceHolder1$BtnQuery": "查詢",
  });

  const rowRe =
    /<tr><td class='DT\w+' align=center>[^<]*<\/td><td class='DT\w+' align=left>([^<]*)<\/td><td class='DT\w+' align=left>[^<]*(?:<br\s*\/?>[^<]*)*<\/td><td class='DT\w+' align=center>[^<]*<\/td><td class='DT\w+' align=center>[^<]*<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>[^<]*<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>([^<]*)<\/td><td class='DT\w+' align=right>[^<]*<\/td>/g;
  const rows: AumDisclosureRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html))) {
    rows.push({
      classCode: m[1],
      aumTwd: parseNum(m[2]),
      navTwd: parseNum(m[3]),
      unitsOutstanding: parseNum(m[4]),
      naturalPersonHolders: parseNum(m[5]),
      institutionalHolders: parseNum(m[6]),
      totalHolders: parseNum(m[7]),
      subscriptionTwd: parseNum(m[8]),
      redemptionTwd: parseNum(m[9]),
    });
  }
  return { yearMonth: `${yearMonth6.slice(0, 4)}-${yearMonth6.slice(4)}`, rows };
}
