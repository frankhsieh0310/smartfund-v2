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

// 2026-11-11（使用者核准定案，市值改自行計算）: 美股市值不再抄雅虎，改成「我們資料庫最新收盤價
// × 流通在外股數」自行計算。VERIFIED CMoney這同一頁（抓中文公司簡介時已經在讀的頁面）基本資料表
// 裡就有「流通在外股數」那一列（<th>流通在外股數</th> <td>24147000000</td>，NVDA實測確認），
// 跟中文簡介用同一次HTTP GET、同一個regex掃描同一份html，不另外多發一次請求。
export type ProfileFetchOutcome =
  | { status: "OK"; data: string; sharesOutstanding: number | null; nameZh: string | null }
  | { status: "NOT_FOUND"; sharesOutstanding: number | null; nameZh: string | null }
  | { status: "BLOCKED"; httpStatus: number }
  | { status: "PARSE_FAILED" };

function extractSharesOutstanding(html: string): number | null {
  const match = html.match(/流通在外股數<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
  if (!match) return null;
  const digits = match[1].replace(/<[^>]+>/g, "").replace(/[^\d]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const HAS_CJK = /[一-鿿]/;
// 2026-11-12 使用者核准定案（中文名稱缺漏，「Meta Meta」重複顯示/美光顯示英文）: CMoney頁面
// <h1>標題本身就有公司中文名稱（VERIFIED：<h1><span>美光科技</span> <span class="addInfo__
// titleId">MU</span></h1>），抓公司簡介的同一次HTTP GET一併讀出來，不多發請求。有些公司
// CMoney沒有中文名稱、<h1>直接回英文原名（例如NFLX顯示"Netflix"、ADBE顯示"Adobe"）——這裡
// 判斷抓到的字串裡有沒有中文字（CJK），沒有中文字就當作「CMoney也沒有中文名」，回null，不會
// 把英文名字當成中文名存起來（那樣沒有意義，跟原本沒有名稱一樣，不能解決重複顯示問題）。
function extractNameZh(html: string): string | null {
  const match = html.match(/<h1[^>]*>\s*<span>([\s\S]*?)<\/span>/);
  if (!match) return null;
  const name = match[1].replace(/<[^>]+>/g, "").trim();
  return name && HAS_CJK.test(name) ? name : null;
}

export async function fetchCMoneyUsCompanyProfile(ticker: string): Promise<ProfileFetchOutcome> {
  const url = `https://www.cmoney.tw/usfinance/${encodeURIComponent(ticker)}/us0026`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": HONEST_USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  } catch {
    return { status: "PARSE_FAILED" };
  }
  if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) return { status: "BLOCKED", httpStatus: res.status };
  if (res.status === 404) return { status: "NOT_FOUND", sharesOutstanding: null, nameZh: null };
  if (!res.ok) return { status: "PARSE_FAILED" };
  const html = await res.text();
  const sharesOutstanding = extractSharesOutstanding(html);
  const nameZh = extractNameZh(html);
  const match = html.match(/中文公司簡介<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
  if (!match) return { status: "NOT_FOUND", sharesOutstanding, nameZh };
  const text = match[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/<[^>]+>/g, "").trim();
  if (!text) return { status: "NOT_FOUND", sharesOutstanding, nameZh };
  return { status: "OK", data: text, sharesOutstanding, nameZh };
}
