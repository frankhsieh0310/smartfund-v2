// 境外基金年度費用率／報酬率（2026-11-05使用者核准新增，獨立模組，不動既有sitca-nav-sync排程）。
// 來源：基金資訊觀測站(fundclear.com.tw，TDCC/集保結算所)的境外基金版 query-rate 端點——跟既有
// lib/fundclear-annual-sync/fetch.ts（境內版 /api/onshore/fund-basic/query-rate）是同一組API的
// 境外鏡像，透過瀏覽器實際操作「安盛環球基金-全球綜合債券基金A CAP歐元」(AXAWGRA)這檔基金、
// 展開「基金運用狀況」頁籤，用read_network_requests抓到真實呼叫
// POST /api/offshore/fund-basic/query-rate 才確認存在，不是猜的。不偽裝User-Agent（不比照
// fetch.ts既有的UA字串，使用者明確禁止）。
//
// VERIFIED（2026-11-05即時比對AXAWGRA）：
//   網站畫面「近五年報酬率」2025:1.68% 2024:-0.11% 2023:3.11% 2022:-14.6% 2021:-2.82%
//   query-rate回應feeRate1~5全部是0.97%、feeNote:"晨星"（晨星=Morningstar，原文本來就這樣標示）
//   同一個fund-basic-info頁面另一支API（query-fund-report）的欄位名叫"fiveYearsFeeRate"但內容其實
//   是報酬率數字（跟上面returnRate1~5一樣）——這是fundclear自己API的欄位命名誤導，PROVEN不能拿
//   那個欄位當費用率使用，只能用這裡的query-rate。
const URL = "https://www.fundclear.com.tw/api/offshore/fund-basic/query-rate";
const TIMEOUT_MS = 20_000;

export type OffshoreAnnualRateRow = {
  year: string;
  returnPct: number | null;
  feeRatePct: number | null;
  returnSource: string | null; // feeNote，原文照抄（例如"晨星"），不是我方判斷
};

export class FundclearOffshoreRateLimitedError extends Error {
  httpStatus: number;
  constructor(httpStatus: number) {
    super(`FUNDCLEAR_OFFSHORE_RATE_HTTP_${httpStatus}`);
    this.httpStatus = httpStatus;
  }
}

function pct(s: string | undefined): number | null {
  if (!s || s === "N/A") return null;
  const n = Number(s.replace("%", ""));
  return Number.isFinite(n) ? n : null;
}

export async function fetchFundclearOffshoreAnnualRate(fundCode: string): Promise<OffshoreAnnualRateRow[]> {
  const res = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fundCode }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new FundclearOffshoreRateLimitedError(res.status);
  if (!res.ok) return [];
  const json = (await res.json()) as { dateList?: string[]; offshoreQueryResultVO?: Record<string, string> };
  const years = json.dateList ?? [];
  const v = json.offshoreQueryResultVO ?? {};
  const returnSource = v.feeNote ?? null;
  return years.map((year, i) => ({
    year,
    returnPct: pct(v[`returnRate${i + 1}`]),
    feeRatePct: pct(v[`feeRate${i + 1}`]),
    returnSource,
  }));
}
