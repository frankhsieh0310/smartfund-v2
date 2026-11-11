// 2026-11-11（使用者核准定案，美股公司簡介改用中文來源）: 美股公司簡介主要來源CMoney美股公司
// 簡介頁（網址格式 cmoney.tw/usfinance/{代號}/us0026），抓「中文公司簡介」欄位，照原文抄，不改寫
// 不翻譯。VERIFIED：抽查NVDA/AAPL/TSLA/JPM四檔，頁面都是伺服器端渲染（純HTTP GET就讀得到，
// 不需要執行頁面JavaScript），四檔都有真實中文簡介內容。
//
// 次要來源（MoneyDJ財經百科）：查過MoneyDJ最接近的「經營概述」欄位在
// https://www.moneydj.com/us/basic/basic0001/{代號} 這頁——VERIFIED這頁內容是透過用戶端
// JavaScript（Knockout.js資料繫結）在頁面載入後才填入，純HTTP GET拿到的HTML（47KB）遠小於瀏覽器
// 實際渲染後的DOM（115KB），抓不到「經營概述」那段文字。這個repo既有的抓取方式全部是純HTTP
// GET（不開無頭瀏覽器、不换裝成瀏覽器的User-Agent去繞過），MoneyDJ這個頁面不符合這個限制，
// 目前沒有實作MoneyDJ備援，回報給使用者決定（同一個網站／換一個可能讀得到的頁面格式，或維持
// CMoney讀不到時直接隱藏）。
const HONEST_USER_AGENT = "SmartMatch-DataBot/1.0 (+https://smartfund-v2.vercel.app; contact: data@smartfund)";

export type ProfileFetchOutcome =
  | { status: "OK"; data: string }
  | { status: "NOT_FOUND" }
  | { status: "BLOCKED"; httpStatus: number }
  | { status: "PARSE_FAILED" };

export async function fetchCMoneyUsCompanyProfile(ticker: string): Promise<ProfileFetchOutcome> {
  const url = `https://www.cmoney.tw/usfinance/${encodeURIComponent(ticker)}/us0026`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": HONEST_USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { status: "PARSE_FAILED" };
  }
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) return { status: "BLOCKED", httpStatus: res.status };
  if (res.status === 404) return { status: "NOT_FOUND" };
  if (!res.ok) return { status: "PARSE_FAILED" };
  const html = await res.text();
  const match = html.match(/中文公司簡介<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
  if (!match) return { status: "NOT_FOUND" };
  const text = match[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/<[^>]+>/g, "").trim();
  if (!text) return { status: "NOT_FOUND" };
  return { status: "OK", data: text };
}
