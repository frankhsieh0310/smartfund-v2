// 2026-11-08（使用者第36輪指令第三點核准）: 52週區間／市值改用雅虎財經香港站（hk.finance.yahoo.com）
// 個股頁，跟證交所官方「主要經營業務」抓公司簡介——兩個都直接寫在伺服器回傳的原始網頁/回應裡，
// 不需要執行網頁JavaScript，一般HTTP請求＋誠實的識別名稱就能讀到（已逐檔驗證過，不是用模擬瀏覽器）。
// 數字一律照抄雅虎顯示的文字，不自己用股價*股數或歷史股價推算；市值只做單位换算（"萬億"→兆、
// "億"→億），不是重新計算市值本身。
const HONEST_USER_AGENT = "SmartMatch-DataBot/1.0 (+https://smartfund-v2.vercel.app; contact: data@smartfund)";

export type YahooHkRangeCap = {
  week52Low: number | null;
  week52High: number | null;
  marketCapRawText: string | null;
  marketCapValue: number | null;
  marketCapUnit: "兆" | "億" | null;
};

export type FetchOutcome<T> =
  | { status: "OK"; data: T }
  | { status: "NOT_FOUND" }
  | { status: "BLOCKED"; httpStatus: number } // 401/403/429/5xx -- 呼叫端必須整批停下來，不可以重試/繞過
  | { status: "PARSE_FAILED" };

function parseMarketCapText(raw: string): { value: number | null; unit: "兆" | "億" | null } {
  // 雅虎香港站目前看到的格式："55.366萬億"（=55.366兆）、"3.16萬億"。較小市值的個股可能顯示
  // "億"——兩種都照抄數字本身，只做單位換算（1萬億=1兆=10^12元；1億=10^8元），不做其他計算。
  const trillion = raw.match(/^([\d.]+)萬億$/);
  if (trillion) return { value: Number(trillion[1]), unit: "兆" };
  const billion = raw.match(/^([\d.]+)億$/);
  if (billion) return { value: Number(billion[1]), unit: "億" };
  return { value: null, unit: null };
}

export async function fetchYahooHkRangeCap(yahooSymbol: string): Promise<FetchOutcome<YahooHkRangeCap>> {
  const url = `https://hk.finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": HONEST_USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { status: "PARSE_FAILED" };
  }
  // 2026-11-11 使用者回報核實擴大美股範圍時發現：連續打幾十檔之後，雅虎財經香港站會開始回傳
  // HTTP 503（服務暫時不可用）——VERIFIED：原本這裡只把401/403/429算成BLOCKED，503落到下面
  // `!res.ok`那條直接被當成「這檔解析失敗」，呼叫端完全沒有停下來，繼續往下一檔打，等於一路
  // 硬闖過封鎖，完全違反「遇到被擋就停下來」的規則——而且不只這次新加的美股受影響，既有的台股
  // 排程（2026-11-08上線至今）很可能也被同一個bug悄悄擋了很多檔（958/1977≈48%覆蓋率跟這個
  // 現象吻合）。5xx一律當成BLOCKED：不確定是真的被節流還是暫時性伺服器錯誤，兩種狀況正確的
  // 處置都一樣——停下來，不要硬闖，隔天（或下一輪）自然重試。
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) return { status: "BLOCKED", httpStatus: res.status };
  if (res.status === 404) return { status: "NOT_FOUND" };
  if (!res.ok) return { status: "PARSE_FAILED" };
  const html = await res.text();
  const rangeMatch = html.match(/data-field="fiftyTwoWeekRange"[^>]*>([^<]+)</);
  const capMatch = html.match(/data-field="marketCap"[^>]*>([^<]+)</);
  if (!rangeMatch) return { status: "PARSE_FAILED" };
  const [lowText, highText] = rangeMatch[1].split("-").map((s) => s.trim().replaceAll(",", ""));
  const week52Low = lowText ? Number(lowText) : null;
  const week52High = highText ? Number(highText) : null;
  const capRaw = capMatch ? capMatch[1].trim() : null;
  const { value, unit } = capRaw ? parseMarketCapText(capRaw) : { value: null, unit: null };
  return {
    status: "OK",
    data: {
      week52Low: Number.isFinite(week52Low) ? week52Low : null,
      week52High: Number.isFinite(week52High) ? week52High : null,
      marketCapRawText: capRaw,
      marketCapValue: value,
      marketCapUnit: unit,
    },
  };
}

// 2026-11-11（使用者更正定案）: 美股公司簡介原本試過雅虎財經香港站自己的"描述"欄位，VERIFIED
// 那段文字即使頁面其他介面都是中文，"描述"本身仍是雅虎自己回傳的純英文原文（抽查NVDA頁面確認）。
// 使用者核准改用CMoney美股公司簡介頁為主、MoneyDJ財經百科為輔（見stockUsCompanyProfile.ts），
// 雅虎來源保留給52週/市值用，不再用於公司簡介。

export async function fetchTwseCompanyProfile(tickerCode: string): Promise<FetchOutcome<string>> {
  const url = `https://mopsov.twse.com.tw/mops/web/ajax_t05st03?encodeURIComponent=1&step=1&firstin=1&off=1&keyword4=&code1=&TYPEK2=&checkbtn=&queryName=co_id&inpuType=co_id&TYPEK=all&co_id=${encodeURIComponent(tickerCode)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": HONEST_USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { status: "PARSE_FAILED" };
  }
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) return { status: "BLOCKED", httpStatus: res.status };
  if (!res.ok) return { status: "PARSE_FAILED" };
  const html = await res.text();
  const match = html.match(/主要經營業務<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
  if (!match) return { status: "NOT_FOUND" };
  const text = match[1].replace(/<br\s*\/?>/gi, "").replace(/\s+/g, "").trim();
  if (!text) return { status: "NOT_FOUND" };
  return { status: "OK", data: text };
}

// 凌晨01:00-05:30台北時間不跑大量工作（跟既有 restore-reverse-index 同一條規則）。
export function inForbiddenWindowTaipei(): boolean {
  const h = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).find((p) => p.type === "hour")?.value ?? "12");
  return h >= 1 && h < 6;
}
