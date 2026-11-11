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
  | { status: "NOT_CHINESE" } // 雅虎這頁有"描述"但是純英文——only used by fetchYahooHkCompanyProfileZh
  | { status: "BLOCKED"; httpStatus: number } // 401/403/429 -- 呼叫端必須整批停下來，不可以重試/繞過
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
  if (res.status === 401 || res.status === 403 || res.status === 429) return { status: "BLOCKED", httpStatus: res.status };
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

// 2026-11-11（使用者核准，美股總覽頁52週/市值/簡介補齊）: 美股公司簡介沒有像TWSE MOPS那種官方
// 中文來源，使用者核准先只用雅虎財經香港站自己的"描述"欄位，有中文才收，沒中文（VERIFIED：抽查
// NVDA這頁本身雖然標題"英偉達"、介面文字都是中文，但"描述"段落本身是雅虎自己回傳的純英文原文，
// 不是我們沒抓到）就不收、不自己翻譯、不換來源，呼叫端自己統計"沒有中文簡介"的檔數。
// 跟52週/市值不同頁（/quote/{symbol}/profile/，不是/quote/{symbol}/），純HTTP GET即可讀到
// （VERIFIED：server-rendered，不需要執行頁面JavaScript）。
const hasCjk = (text: string) => /[一-鿿]/.test(text);

export async function fetchYahooHkCompanyProfileZh(yahooSymbol: string): Promise<FetchOutcome<string>> {
  const url = `https://hk.finance.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}/profile/`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": HONEST_USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { status: "PARSE_FAILED" };
  }
  if (res.status === 401 || res.status === 403 || res.status === 429) return { status: "BLOCKED", httpStatus: res.status };
  if (res.status === 404) return { status: "NOT_FOUND" };
  if (!res.ok) return { status: "PARSE_FAILED" };
  const html = await res.text();
  const match = html.match(/描述\s*<\/h3>[\s\S]*?<p>([\s\S]*?)<\/p>/);
  if (!match) return { status: "NOT_FOUND" };
  const text = match[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/<[^>]+>/g, "").trim();
  if (!text) return { status: "NOT_FOUND" };
  if (!hasCjk(text)) return { status: "NOT_CHINESE" }; // 純英文描述——不是抓失敗，是雅虎這頁本來就沒有中文版，誠實回報沒有，不自己翻譯
  return { status: "OK", data: text };
}

export async function fetchTwseCompanyProfile(tickerCode: string): Promise<FetchOutcome<string>> {
  const url = `https://mopsov.twse.com.tw/mops/web/ajax_t05st03?encodeURIComponent=1&step=1&firstin=1&off=1&keyword4=&code1=&TYPEK2=&checkbtn=&queryName=co_id&inpuType=co_id&TYPEK=all&co_id=${encodeURIComponent(tickerCode)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": HONEST_USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { status: "PARSE_FAILED" };
  }
  if (res.status === 401 || res.status === 403 || res.status === 429) return { status: "BLOCKED", httpStatus: res.status };
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
