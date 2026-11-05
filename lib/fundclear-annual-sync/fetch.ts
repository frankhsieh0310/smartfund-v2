// FundClear (基金資訊觀測站, fundclear.com.tw, 集保結算所/TDCC) 境內基金年度報酬率與年度費用率
// (query-rate 端點) — 用基金代碼查詢，分不出級別，所以只適用「只有一個級別」的境內基金。
// 跟 SITCA 的月實際費用（占淨資產比率）是完全不同的指標：這裡是整個曆年（1~12月）彙總的年度
// 費用率，不可混在一起顯示，畫面要標「YYYY 年度費用率（FundClear）」。
// 2026-10-31 驗證：raw fetch 跟真人瀏覽器顯示的圖表數字逐欄一致（00974066、00512651 兩檔直接
// 瀏覽器核對，00505048/00512527/00512532 三檔 API 回應格式一致但未逐一開瀏覽器核對）。
// 2026-11-05使用者核准拿掉：這裡原本寫死瀏覽器User-Agent，跟使用者「不偽裝User-Agent」的規則
// 衝突（這支程式比新的境外模組fetchOffshore.ts早，當時沒有這條規則）。拿掉後試抓3檔確認仍正常
// （見app/api/cron/fundclear-offshore-annual-sync同輪回報）。
const URL = "https://www.fundclear.com.tw/api/onshore/fund-basic/query-rate";

export type AnnualRateRow = {
  year: string; // 'YYYY'
  returnPct: number | null;
  feeRatePct: number | null;
  returnSource: string | null; // rtnSor, e.g. 公會/morningstar/Lipper/台大績效評比
};

export class FundclearRateLimitedError extends Error {
  httpStatus: number;
  constructor(httpStatus: number) {
    super(`FUNDCLEAR_RATE_HTTP_${httpStatus}`);
    this.httpStatus = httpStatus;
  }
}

function pct(s: string | undefined): number | null {
  if (!s || s === "N/A") return null;
  const n = Number(s.replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

export async function fetchFundclearAnnualRate(fundCode: string): Promise<AnnualRateRow[]> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fundCode }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403 || res.status === 429) throw new FundclearRateLimitedError(res.status);
  if (!res.ok) return [];
  const json = (await res.json()) as { dateList?: string[]; onshoreQueryResultVO?: Record<string, string> };
  const years = json.dateList ?? [];
  const v = json.onshoreQueryResultVO ?? {};
  const returnSource = v.rtnSor ?? null;
  return years.map((year, i) => ({
    year,
    returnPct: pct(v[`returnRate${i + 1}`]),
    feeRatePct: pct(v[`feeRate${i + 1}`]),
    returnSource,
  }));
}
