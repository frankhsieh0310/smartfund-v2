// 境外基金全球規模 — TDCC opendata dataset 3-2（境外基金基本資料，data.gov.tw/dataset/11639）。
// VERIFIED 2026-10-31：官方欄位說明原文「基金規模(百萬)」+「基金規模幣別」+「基金規模日期」，
// 用funds.isin比對30檔APPROVED境外基金，命中率100%。這是整個基金（所有級別合計）的全球規模，
// 不是台灣投資人持有金額——跟FundClear境外頁面上標「單位：新臺幣」的612(百萬元)是不同指標
// （那個其實是FundClear頁面上「國人持有比重%」對應的台灣投資人持有金額，單位新臺幣，VERIFIED
// 用LU0955866438核對：FundClear頁面「國人持有比重% 3.01%」跟raw JSON的monthAmtRate:"3.01"
// 完全對應，證實fundGlobalScope這個欄位名稱誤導，實際是台灣持有金額不是全球規模）。
const TDCC_URL = "https://opendata.tdcc.com.tw/getOD.ashx?id=3-2";
const UA = "SmartFund data coverage research contact@smartfund.app";

export type TdccOffshoreScaleRow = {
  isin: string;
  name: string;
  scaleAmountMillions: number; // 基金規模(百萬)，原幣別
  scaleCurrency: string; // 基金規模幣別
  scaleAsOfDate: string; // 'YYYY-MM-DD'，基金規模日期
};

function toIsoDate(yyyymmdd: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(yyyymmdd.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export async function fetchTdccOffshoreScale(): Promise<TdccOffshoreScaleRow[]> {
  const res = await fetch(TDCC_URL, { headers: { "User-Agent": UA, Accept: "text/csv" }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 403 || res.status === 429) throw Object.assign(new Error(`TDCC_3-2_HTTP_${res.status}`), { blocked: true, httpStatus: res.status });
  if (!res.ok) throw new Error(`TDCC_3-2_HTTP_${res.status}`);
  const text = await res.text();
  const lines = text.split("\n");
  const rows: TdccOffshoreScaleRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    const name = cols[1]?.trim();
    const isin = cols[3]?.trim();
    const scaleAmount = Number(cols[12]);
    const scaleCurrency = cols[13]?.trim();
    const scaleAsOfDate = toIsoDate(cols[14] ?? "");
    if (!isin || !name || !Number.isFinite(scaleAmount) || !scaleCurrency || !scaleAsOfDate) continue;
    rows.push({ isin, name, scaleAmountMillions: scaleAmount, scaleCurrency, scaleAsOfDate });
  }
  return rows;
}
