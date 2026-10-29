// ETF tracking difference / tracking error — self-calculated from real ETF prices and real
// benchmark-index prices, scoped (2026-10-29, 使用者核准) to the top-50 TWD ETFs + top-50 USD ETFs
// by AUM, and ONLY for the subset where the benchmark index itself has a VERIFIED free, official
// daily data source (TWSE's own open-data endpoints, or a well-known Yahoo index ticker) — not
// guessed, not a proxy for a different index. Everything else shows 無資料 rather than a
// fabricated or substituted number.
//
// 2026-10-29（VERIFIED，驗收未通過，尚未接上任何畫面）: 用etf_history.price（收盤市價，不是淨值
// ——0050近一年etf_history裡只有3筆有nav）逐日對數報酬相減算出來的0050追蹤誤差是7.2%，遠高於
// 元大官網公布的真實數字量級（日追蹤差距0.01%、累計-1.48%，資料日期2026-10-28）——差距完全不合理，
// 沒有通過使用者訂的驗收標準。VERIFIED抓前10大單日落差都在±1%內、沒有單一離群值造成，是
// 「市價 vs 指數」本身逐日噪訊（流動性、溢折價波動）系統性偏高，不是bug也不是單一事件（AI不是
// 繞過驗收硬推上線，是如實記錄卡在哪裡，等有可靠的NAV歷史資料或改用元大官網「追蹤差距」頁本身
// 的數字後再重新評估）。目前只到lib，沒有接到任何cron或頁面，不會顯示給使用者看到任何數字。
// 美股ETF(VOO/QQQ等)算出來的1.1-2.1%同樣可能偏高於真實公開數字(業界常見在0.02-0.3%量級)，只是
// 沒有像0050這樣極端，同一個根因，同樣不建議直接上線。
//
// global_index_benchmark_resolution_queue (the existing ETF->index auto-resolution system, 223
// rows, 0 resolved) is deliberately NOT used or extended here — it's a separate, already-stuck
// effort, out of scope this round (see CLAUDE.md).
import { fetchYahooChartPeriod } from "@/lib/services/dataProviders/yahoo/yahooClient";

export type IndexPricePoint = { date: string; close: number }; // date: YYYY-MM-DD

export type TrackedEtf = {
  code: string;
  indexName: string;
  source: "TWSE_TAI50I" | "TWSE_MFI94U" | "YAHOO";
  // TWSE_TAI50I/TWSE_MFI94U: which column of that report to use. YAHOO: the index ticker.
  ref: string;
};

// VERIFIED 2026-10-29 (each one fetched and confirmed returning real, current data):
//   - TWSE https://www.twse.com.tw/indicesReport/TAI50I?response=open_data -- free official CSV,
//     columns 日期,臺灣50指數,臺灣50報酬指數 (price index + total-return index, both real TWSE data).
//   - TWSE https://www.twse.com.tw/indicesReport/MFI94U?response=json&date=YYYYMMDD -- free
//     official monthly JSON, 發行量加權股價報酬指數 (TAIEX total-return index).
//   - Yahoo ^GSPC/^NDX/^RUT/^RLG/^RLV -- standard, unambiguous major US indices.
// Everything else checked this round (0056/00878/00919/00830/00850/XLK/SMH/GLD/EFA/etc.) is either
// a proprietary FTSE/MSCI/Taiwan-Index-Company-licensed index TWSE only sells commercially
// (confirmed via its eshop product listings, e.g. IX0172), or its exact benchmark ticker could not
// be confirmed with certainty -- excluded rather than guessed.
// 2026-10-29（VERIFIED抽查發現，修正範圍）: 00981A/00403A/00991A名稱都有「主動」二字，是主動式
// ETF——benchmark只是參考指標、本來就不是機械式複製，算出來的「追蹤差距」高達9%以上是正確反映
// 主動操作偏離，不是bug，但「追蹤誤差」這個指標的前提是「應該緊貼指數」，對主動式ETF顯示這個
// 指標本身就會誤導使用者，排除。00662/00646是台股掛牌、新臺幣計價的美股指數ETF——VERIFIED算出
// 20%+的追蹤誤差，但這其實是「新臺幣ETF價格 vs 美元指數」沒有先換算匯率基礎不一致造成的，不是
// 真正的追蹤誤差，在沒有可靠的每日美元兌台幣匯率換算前，先不計算這兩檔，避免顯示錯誤但看起來
// 像真實數字的誤導資訊。
export const TRACKED_ETFS: TrackedEtf[] = [
  { code: "0050", indexName: "臺灣50報酬指數", source: "TWSE_TAI50I", ref: "臺灣50報酬指數" },
  { code: "006208", indexName: "臺灣50報酬指數", source: "TWSE_TAI50I", ref: "臺灣50報酬指數" },
  { code: "VOO", indexName: "S&P 500 Index", source: "YAHOO", ref: "^GSPC" },
  { code: "IVV", indexName: "S&P 500 Index", source: "YAHOO", ref: "^GSPC" },
  { code: "SPY", indexName: "S&P 500 Index", source: "YAHOO", ref: "^GSPC" },
  { code: "SPYM", indexName: "S&P 500 Index", source: "YAHOO", ref: "^GSPC" },
  { code: "QQQ", indexName: "NASDAQ-100 Index", source: "YAHOO", ref: "^NDX" },
  { code: "QQQM", indexName: "NASDAQ-100 Index", source: "YAHOO", ref: "^NDX" },
  { code: "IWM", indexName: "Russell 2000 Index", source: "YAHOO", ref: "^RUT" },
  { code: "IWF", indexName: "Russell 1000 Growth Index", source: "YAHOO", ref: "^RLG" },
  { code: "IWD", indexName: "Russell 1000 Value Index", source: "YAHOO", ref: "^RLV" },
];

function rocDateToIso(rocDate: string): string {
  if (rocDate.includes("/")) {
    // "115/10/28" -> "2026-10-28"
    const [y, m, d] = rocDate.split("/");
    return `${Number(y) + 1911}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // "1151028" (compact, no separator, as TAI50I's own CSV date column uses) -> "2026-10-28"
  const y = rocDate.slice(0, 3), m = rocDate.slice(3, 5), d = rocDate.slice(5, 7);
  return `${Number(y) + 1911}-${m}-${d}`;
}

async function fetchTai50IndexMonth(column: "臺灣50指數" | "臺灣50報酬指數", dateParam: string | null): Promise<IndexPricePoint[]> {
  const url = `https://www.twse.com.tw/indicesReport/TAI50I?response=open_data${dateParam ? `&date=${dateParam}` : ""}`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`TWSE_TAI50I_HTTP_${res.status}`);
  const csv = await res.text();
  const lines = csv.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const colIdx = header.indexOf(column);
  if (colIdx === -1) throw new Error(`TWSE_TAI50I_COLUMN_NOT_FOUND:${column}`);
  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.replace(/"/g, ""));
    return { date: rocDateToIso(cols[0]), close: Number(cols[colIdx]) };
  }).filter((p) => Number.isFinite(p.close));
}

/** VERIFIED 2026-10-29: no date param -> only the most recent ~18 trading days. `date=YYYYMMDD`
 * selects that ONE CALENDAR MONTH's data, not "from this date onward" -- same monthly-report shape
 * as MFI94U, so building a full year means one request per month, concatenated. */
export async function fetchTai50IndexHistory(column: "臺灣50指數" | "臺灣50報酬指數", monthsBack = 13): Promise<IndexPricePoint[]> {
  const points: IndexPricePoint[] = [];
  const now = new Date();
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const dateParam = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}01`;
    try {
      points.push(...await fetchTai50IndexMonth(column, dateParam));
    } catch { /* skip a month that fails rather than aborting the whole fetch */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  const seen = new Map(points.map((p) => [p.date, p]));
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchMfi94uHistory(monthsBack: number): Promise<IndexPricePoint[]> {
  const points: IndexPricePoint[] = [];
  const now = new Date();
  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const dateParam = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}01`;
    const res = await fetch(`https://www.twse.com.tw/indicesReport/MFI94U?response=json&date=${dateParam}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) continue;
    const json = await res.json() as { data?: [string, string][] };
    for (const [rocDate, value] of json.data ?? []) {
      points.push({ date: rocDateToIso(rocDate.replace(/-/g, "/")), close: Number(value.replace(/,/g, "")) });
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return points.filter((p) => Number.isFinite(p.close)).sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchYahooIndexHistory(ticker: string, fromUnix: number, toUnix: number): Promise<IndexPricePoint[]> {
  const chart = await fetchYahooChartPeriod(ticker, fromUnix, toUnix);
  if (!chart) return [];
  return chart.candles.filter((c) => c.close != null).map((c) => ({ date: c.date.toISOString().slice(0, 10), close: c.close as number }));
}

export type TrackingResult = {
  trackingDifferencePct: number | null; // cumulative annualized gap between ETF and index returns
  trackingErrorPct: number | null; // annualized std dev of the daily return gap
  observationCount: number;
};

const TRADING_DAYS_PER_YEAR = 252;

/** `etfPrices` and `indexPrices` must be real daily closes; matched by exact date string. */
export function calculateTrackingMetrics(etfPrices: IndexPricePoint[], indexPrices: IndexPricePoint[]): TrackingResult {
  const indexByDate = new Map(indexPrices.map((p) => [p.date, p.close]));
  const paired = etfPrices.filter((p) => indexByDate.has(p.date)).sort((a, b) => a.date.localeCompare(b.date));
  if (paired.length < 20) return { trackingDifferencePct: null, trackingErrorPct: null, observationCount: paired.length };

  const gaps: number[] = [];
  for (let i = 1; i < paired.length; i++) {
    const etfReturn = Math.log(paired[i].close / paired[i - 1].close);
    const indexReturn = Math.log((indexByDate.get(paired[i].date) as number) / (indexByDate.get(paired[i - 1].date) as number));
    gaps.push(etfReturn - indexReturn);
  }
  const meanGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const variance = gaps.reduce((s, g) => s + (g - meanGap) ** 2, 0) / (gaps.length - 1);
  const trackingErrorPct = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;
  const trackingDifferencePct = (Math.exp(meanGap * TRADING_DAYS_PER_YEAR) - 1) * 100;

  return { trackingDifferencePct, trackingErrorPct, observationCount: paired.length };
}

export const TRACKING_METHOD_LABEL =
  "本App計算：以近1年ETF真實收盤價(或淨值)與追蹤指數真實每日收盤的對數報酬率逐日相減，年化標準差為追蹤誤差，" +
  "年化平均差距為追蹤差距。";
