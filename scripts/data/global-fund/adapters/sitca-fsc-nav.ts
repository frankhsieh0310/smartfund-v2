import Papa from "papaparse";

export const SITCA_FSC_NAV_SOURCE = "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV";
export const SITCA_FSC_NAV_URL = "https://www.sitca.org.tw/MemberK0000/F/03/nav.csv";

export type SitcaFundNavRecord = {
  source: typeof SITCA_FSC_NAV_SOURCE;
  sourceRecordId: string;
  code: string;
  name: string;
  company: string;
  currency: string;
  nav: string;
  navDate: Date;
};

export function sitcaSourceRecordId(company: string, code: string, name: string) {
  return `${company.trim()}|${code.trim()}|${name.trim().normalize("NFKC")}`;
}

function required(row: Record<string, string>, key: string) {
  const value = row[key]?.trim();
  if (!value) throw new Error(`SITCA_REQUIRED_FIELD_MISSING:${key}`);
  return value;
}

export function parseSitcaFscNav(csv: string): SitcaFundNavRecord[] {
  const parsed = Papa.parse<Record<string, string>>(csv.replace(/^\uFEFF/, ""), {
    header: true,
    skipEmptyLines: true,
  });
  if (parsed.errors.length) throw new Error(`SITCA_CSV_PARSE_ERROR:${parsed.errors[0]?.message}`);

  const records: SitcaFundNavRecord[] = [];
  for (const row of parsed.data) {
    const code = row["基金代號"]?.trim();
    const name = row["基金名稱"]?.trim();
    const nav = row["基金淨值"]?.trim();
    const rawDate = row["日期"]?.trim();
    if (!code || !name || !nav || !rawDate || name.toUpperCase().includes("ETF")) continue;
    if (!/^\d{8}$/.test(rawDate) || !Number.isFinite(Number(nav)) || Number(nav) <= 0) continue;
    records.push({
      source: SITCA_FSC_NAV_SOURCE,
      sourceRecordId: sitcaSourceRecordId(required(row, "公司名稱"), code, name),
      code,
      name,
      company: required(row, "公司名稱"),
      currency: row["幣別"]?.trim() || "TWD",
      nav,
      navDate: new Date(`${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}T00:00:00.000Z`),
    });
  }
  if (!records.length) throw new Error("SITCA_MUTUAL_FUND_NAV_RECORDS_NOT_FOUND");
  return records;
}

export async function fetchSitcaFscNav(): Promise<SitcaFundNavRecord[]> {
  const response = await fetch(SITCA_FSC_NAV_URL, {
    headers: { "user-agent": "SmartFund data engineering" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`SITCA_HTTP_${response.status}`);
  return parseSitcaFscNav(await response.text());
}
