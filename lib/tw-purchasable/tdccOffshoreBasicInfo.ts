// TDCC open-data dataset 3-2 ("境外基金－基本資料"), the authoritative list of offshore funds
// officially approved for sale in Taiwan -- distinct from dataset 3-4 ("境外基金－基金淨值",
// see lib/offshore-nav-sync/tdccBatchSource.ts), which is a NAV feed that happens to cover a
// similar population but is not itself the approval registry. Per
// docs/specs/technical-screener-reverse-lookup.md's VERIFIED 2026-10-14 finding: 5,295 distinct
// fund share-class names, no single official-id column (no 基金統編 equivalent), so identity here
// is exact fund NAME -- same technique already used elsewhere for offshore funds (funds.code/isin
// are NULL for the vast majority of them).
export const TDCC_OFFSHORE_BASIC_INFO_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=3-2";
export const TDCC_OFFSHORE_BASIC_INFO_SOURCE = "TDCC_OPENDATA_3-2";

export type TdccOffshoreBasicInfoRow = { name: string };

// CSV header (VERIFIED live 2026-10-17, this round -- the spec doc's older note that column 0 was
// 基金名稱 was wrong, corrected here): 資料日期,基金名稱,基金代碼,基金ISIN_CODE,基金英文名稱,
// 基金種類,投資區域,基金類股規模(百萬),計價幣別,基金總代理名稱,境外基金機構,基金管理機構, ...
// -- i.e. 基金名稱 is column INDEX 1, not 0. 基金總代理名稱 is column INDEX 9.
export function parseTdccOffshoreBasicInfoCsv(csvText: string): Set<string> {
  const names = new Set<string>();
  const lines = csvText.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const name = line.split(",")[1]?.trim();
    if (name) names.add(name);
  }
  return names;
}

export async function fetchTdccOffshoreBasicInfoNames(): Promise<Set<string>> {
  const res = await fetch(TDCC_OFFSHORE_BASIC_INFO_URL, { headers: { Accept: "text/csv" } });
  if (!res.ok) throw new Error(`TDCC 3-2 fetch failed: ${res.status}`);
  const csvText = await res.text();
  return parseTdccOffshoreBasicInfoCsv(csvText);
}

// 2026-10-18: 帶出 基金總代理名稱（column index 9），補建境外基金時填 funds.company 用，
// 不要用佔位文字。回傳 name -> 總代理名稱 的 Map；沒有值或空字串就不放進 Map，由呼叫端自己
// 決定沒有總代理名稱時怎麼處理，這裡不編造。
export async function fetchTdccOffshoreBasicInfoAgents(): Promise<Map<string, string>> {
  const res = await fetch(TDCC_OFFSHORE_BASIC_INFO_URL, { headers: { Accept: "text/csv" } });
  if (!res.ok) throw new Error(`TDCC 3-2 fetch failed: ${res.status}`);
  const csvText = await res.text();
  const agents = new Map<string, string>();
  const lines = csvText.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    const name = cols[1]?.trim();
    const agent = cols[9]?.trim();
    if (name && agent) agents.set(name, agent);
  }
  return agents;
}
