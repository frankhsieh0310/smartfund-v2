// 前十大持股改以各投信官網「依投信投顧公會規定，每月第10個營業日揭露基金持有前10大標的」的月報
// 頁面為主要來源，MoneyDJ降為備援（2026-11-02使用者核准定案）。
//
// 用Puppeteer（lib/etf-holdings-engine/adapters/browserUtil.ts既有的withPage()，跟ETF官方持股同一套
// chromium/本機puppeteer切換邏輯，今天這輪已經修好chromium bundling）讀取「渲染後」的頁面文字，不是
// 直接call官網的JSON API——VERIFIED國泰(cathaysite.com.tw)的真正資料API
// cwapi.cathaysite.com.tw/api/Fund/GetMainInvestmentInfo沒有偽裝瀏覽器UA會被WAF擋403，使用者明確
// 禁止偽裝User-Agent，所以改用Puppeteer真實瀏覽器（送出瀏覽器自己真正的UA，不是硬編造的字串）去
// 渲染頁面、讀取畫面上呈現的文字——跟我在這個session裡手動核對兩家官網時看到的文字一模一樣，
// 不解析任何內部JSON/RSC payload格式（元大的頁面原始HTML裡雖然有資料，但格式是Next.js的RSC
// streaming格式、有值interning，VERIFIED直接regex解析會漏掉重複比重的列，不可靠，所以同樣改用
// 渲染後文字）。
import { withPage } from "../etf-holdings-engine/adapters/browserUtil";

export type IssuerHoldingRow = { name: string; weight: number };
export type IssuerMonthlyHoldingsResult = {
  holdings: IssuerHoldingRow[];
  dataMonth: string; // "YYYY/MM"
  sourceUrl: string;
};

// 2026-11-02 VERIFIED：官網排版常在中文名稱的字與字之間插全形/半形空白（例如「力 成」），但
// 英文/數字名稱（例如公債「STRIP PRINC 0% 02/15/2053」）的空白是有意義的、不能一起清掉——只清掉
// 兩個中文字之間的空白，其餘原樣照抄。
function stripCjkInternalSpacing(name: string): string {
  return name.trim().replace(/(?<=[一-鿿])\s+(?=[一-鿿])/g, "");
}

export class IssuerSiteBlockedError extends Error {
  constructor(public issuer: string, public httpStatus: number | null, reason: string) {
    super(`ISSUER_SITE_BLOCKED_${issuer}_${httpStatus ?? "NA"}: ${reason}`);
  }
}

async function renderPageText(url: string, clickTabText: string | null, timeoutMs = 30_000, forceReload = false): Promise<string> {
  return withPage(async (page) => {
    const response = await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });
    const status = response?.status() ?? null;
    if (status === 429 || status === 403) {
      throw new IssuerSiteBlockedError("UNKNOWN", status, `HTTP_${status}`);
    }
    if (forceReload) {
      // 2026-11-03 VERIFIED：野村的URL是hash路由（.../#/...?groupId=...），page.goto對hash-only
      // 差異不會觸發真正的瀏覽器導覽，Puppeteer會在Angular還沒重新渲染新路由內容前就回傳——
      // 實測兩檔基金連續抓會讀到上一檔的殘留畫面文字（第一檔抓到DATE_NOT_FOUND、第二檔卻讀到
      // 第一檔的持股）。page.reload()強制整頁重新載入，繞過hash-only導覽不觸發重render的問題。
      await page.reload({ waitUntil: "networkidle2", timeout: timeoutMs });
    }
    if (clickTabText) {
      // 2026-11-02 VERIFIED：元大頁面預設顯示「績效表現」頁籤，「投資組合」(前10大標的)要先點
      // 頁籤切換才看得到——純渲染innerText讀不到，必須模擬點擊這一步。
      const clicked = await page.evaluate((label: string) => {
        const nodes = Array.from(document.querySelectorAll("button, a, div, span")) as HTMLElement[];
        const target = nodes.find((n) => n.textContent?.trim() === label && n.offsetParent !== null);
        if (target) { target.click(); return true; }
        return false;
      }, clickTabText);
      if (clicked) await new Promise((r) => setTimeout(r, 1500));
    }
    return page.evaluate(() => document.body.innerText);
  });
}

// 元大投信（yuantafunds.com）：fund-information頁，「前10大標的」區塊渲染後文字是
// 「股票 NAME WEIGHT% 股票 NAME WEIGHT% ...」（表格兩欄被攤平成一長串），結尾是
// 「資料日期：YYYY/MM/DD，依投信投顧公會規定...」這行公會規定文字。
export async function fetchYuantaMonthlyHoldings(yuantaFundId: string): Promise<IssuerMonthlyHoldingsResult> {
  const sourceUrl = `https://www.yuantafunds.com/myfund/information/${yuantaFundId}`;
  let text: string;
  try {
    text = await renderPageText(sourceUrl, "投資組合");
  } catch (e) {
    if (e instanceof IssuerSiteBlockedError) throw new IssuerSiteBlockedError("YUANTA", e.httpStatus, e.message);
    throw e;
  }
  const headerIdx = text.indexOf("前10大標的");
  if (headerIdx < 0) throw new Error(`YUANTA_MARKER_NOT_FOUND:${yuantaFundId}`);
  const dateMatch = text.slice(headerIdx).match(/資料日期：(\d{4}\/\d{2})\/\d{2}/);
  if (!dateMatch) throw new Error(`YUANTA_DATE_NOT_FOUND:${yuantaFundId}`);
  const scope = text.slice(headerIdx, headerIdx + (text.slice(headerIdx).indexOf(dateMatch[0]) + dateMatch[0].length));
  // 2026-11-02 VERIFIED（抽查00969B元大零息超長期美國政府債券ETF基金發現原本regex只認「股票」
  // 漏掉債券類，已修正成通用抓「類別\n名稱\n比重%」三行一組，不限定股票）：每列是「類別」「名稱」
  // 「比重%」各自獨立一行（表格兩欄被攤平成一長串），類別可能是股票/債券/其他。
  const rowRe = /\n+(股票|債券|其他)\n+([^\n]+)\n+([\d.]+)%/g;
  const holdings: IssuerHoldingRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(scope)) && holdings.length < 10) {
    holdings.push({ name: stripCjkInternalSpacing(m[2]), weight: Number(m[3]) });
  }
  if (holdings.length !== 10) throw new Error(`YUANTA_HOLDINGS_COUNT_${holdings.length}:${yuantaFundId}`);
  return { holdings, dataMonth: dateMatch[1], sourceUrl };
}

// 國泰投信（cathaysite.com.tw）：fund-details/<code>?tab=portfolio頁，「主要投資標的」區塊渲染後
// 文字是「NAME CATEGORY-股票 WEIGHT% ...」每筆3行一組，結尾同樣是公會規定文字。名稱裡官網原文
// 常見全形字間空白（例如「欣 興」），照抄原文但去掉這種字間空白還原成正常名稱再寫入。
export async function fetchCathayMonthlyHoldings(cathayFundCode: string): Promise<IssuerMonthlyHoldingsResult> {
  const sourceUrl = `https://www.cathaysite.com.tw/fund-details/${cathayFundCode}?tab=portfolio`;
  let text: string;
  try {
    text = await renderPageText(sourceUrl, null);
  } catch (e) {
    if (e instanceof IssuerSiteBlockedError) throw new IssuerSiteBlockedError("CATHAY", e.httpStatus, e.message);
    throw e;
  }
  const headerIdx = text.indexOf("主要投資標的");
  if (headerIdx < 0) throw new Error(`CATHAY_MARKER_NOT_FOUND:${cathayFundCode}`);
  const dateMatch = text.slice(headerIdx).match(/資料日期｜(\d{4}\/\d{2})/);
  if (!dateMatch) throw new Error(`CATHAY_DATE_NOT_FOUND:${cathayFundCode}`);
  const nextSectionIdx = text.indexOf("各類資產佔比", headerIdx);
  const scope = text.slice(headerIdx, nextSectionIdx > 0 ? nextSectionIdx : headerIdx + 3000);
  const rowRe = /\n([^\n%]+?)\n[^\n]*股票\n([\d.]+)%/g;
  const holdings: IssuerHoldingRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(scope)) && holdings.length < 10) {
    const name = stripCjkInternalSpacing(m[1]);
    if (!name || name === "類別" || name === "名稱") continue;
    holdings.push({ name, weight: Number(m[2]) });
  }
  if (holdings.length !== 10) throw new Error(`CATHAY_HOLDINGS_COUNT_${holdings.length}:${cathayFundCode}`);
  return { holdings, dataMonth: dateMatch[1], sourceUrl };
}

// 野村投信（nomurafunds.com.tw）：基金介紹→基金持股頁，URL用groupId+gradeId（從官網選單／搜尋
// 結果點進去才拿得到，不是可猜的流水號），渲染後文字是「主要持股\n\n資料來源：嘉實資訊
// 資料日期：YYYY/MM/DD\n\n名稱\n比重%\n名稱\n比重%\n...」10組、接著「國家分布」區塊。
// 2026-11-03 使用者已用公司內部資料核對野村鴻運基金（groupId=E0FF51FB-DEC2-41F3-B66D-8F1A2991FFE7,
// gradeId=27）這10檔名稱和比例完全一致，照這個格式實作。
export async function fetchNomuraMonthlyHoldings(groupId: string, gradeId: string): Promise<IssuerMonthlyHoldingsResult> {
  const sourceUrl = `https://www.nomurafunds.com.tw/Web/Content/#/primary/fund/fund-list/introduction?groupId=${groupId}&gradeId=${gradeId}&pageType=shareholding`;
  let text: string;
  try {
    text = await renderPageText(sourceUrl, null, 30_000, true);
  } catch (e) {
    if (e instanceof IssuerSiteBlockedError) throw new IssuerSiteBlockedError("NOMURA", e.httpStatus, e.message);
    throw e;
  }
  const headerIdx = text.indexOf("主要持股");
  if (headerIdx < 0) throw new Error(`NOMURA_MARKER_NOT_FOUND:${groupId}/${gradeId}`);
  const dateMatch = text.slice(headerIdx).match(/資料日期：(\d{4}\/\d{2})\/\d{2}/);
  if (!dateMatch) throw new Error(`NOMURA_DATE_NOT_FOUND:${groupId}/${gradeId}`);
  const nextSectionIdx = text.indexOf("國家分布", headerIdx);
  const scope = text.slice(headerIdx, nextSectionIdx > 0 ? nextSectionIdx : headerIdx + 2000);
  const rowRe = /\n([^\n%]+?)\n([\d.]+)%/g;
  const holdings: IssuerHoldingRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(scope)) && holdings.length < 10) {
    const name = stripCjkInternalSpacing(m[1]);
    if (!name || name.includes("資料來源") || name.includes("資料日期")) continue;
    holdings.push({ name, weight: Number(m[2]) });
  }
  if (holdings.length !== 10) throw new Error(`NOMURA_HOLDINGS_COUNT_${holdings.length}:${groupId}/${gradeId}`);
  return { holdings, dataMonth: dateMatch[1], sourceUrl };
}

// 群益投信（capitalfund.com.tw）：基金持股頁有真正的JSON API（POST /CFWeb/api/fundhold/list/
// <fundNo>，fundNo是官網選單→基金總覽→點進個別基金的/fund/detail/<fundNo>這個代號，不是猜的），
// 直接讀渲染後頁面實際呼叫的這支API，不解析HTML文字——比元大/國泰/野村三家都乾淨，因為官網
// 本身就是結構化資料、不需要額外解析排版。VERIFIED「群益馬拉松基金」(fundNo=003)10檔逐列核對
// 跟官網頁面一致。
export async function fetchCapitalMonthlyHoldings(fundNo: string): Promise<IssuerMonthlyHoldingsResult> {
  const sourceUrl = `https://www.capitalfund.com.tw/fund/detail/${fundNo}/hold`;
  const json = await withPage(async (page) => {
    const response = await page.goto(sourceUrl, { waitUntil: "networkidle2", timeout: 30_000 });
    const status = response?.status() ?? null;
    if (status === 429 || status === 403) throw new IssuerSiteBlockedError("CAPITAL", status, `HTTP_${status}`);
    return page.evaluate(async (no: string) => {
      const res = await fetch(`/CFWeb/api/fundhold/list/${no}`, { method: "POST" });
      if (res.status === 429 || res.status === 403) throw new Error(`BLOCKED_${res.status}`);
      return res.json();
    }, fundNo);
  });
  const items = json?.data?.items as Array<{ seqNo: number; stocName: string; stocPerc: number; tdate: string }> | undefined;
  if (!items || items.length === 0) throw new Error(`CAPITAL_HOLDINGS_EMPTY:${fundNo}`);
  // 照抄官網原文，含"聖暉*"這類帶星號註記的名稱——不自行判斷星號是否該清掉。
  const holdings: IssuerHoldingRow[] = items.slice(0, 10).map((it) => ({ name: it.stocName.trim(), weight: it.stocPerc }));
  if (holdings.length !== 10) throw new Error(`CAPITAL_HOLDINGS_COUNT_${holdings.length}:${fundNo}`);
  const dataMonth = items[0].tdate.slice(0, 7); // "YYYY-MM-DDThh:mm:ss+08:00" -> "YYYY-MM"
  return { holdings, dataMonth: dataMonth.replace("-", "/"), sourceUrl };
}

// 富邦投信（fubon.com）：基金總覽→點進個別基金→「基金資產配置」頁，「前十大投資標的」表格
// 渲染後文字是「投資類型\t投資標的\t比例(%)」三欄表格，每列「產業類別 名稱 比重%」。Fd參數是
// 從官網選單點進去才拿得到的基金代號（例如"01A"），不是猜的。
export async function fetchFubonMonthlyHoldings(fd: string): Promise<IssuerMonthlyHoldingsResult> {
  const sourceUrl = `https://www.fubon.com/asset-management/fund/info/assets?Fd=${fd}`;
  const text = await renderPageText(sourceUrl, null);
  const headerIdx = text.indexOf("前十大投資標的");
  if (headerIdx < 0) throw new Error(`FUBON_MARKER_NOT_FOUND:${fd}`);
  const dateMatch = text.slice(headerIdx).match(/資料日期：(\d{4}\/\d{2})\/\d{2}/);
  if (!dateMatch) throw new Error(`FUBON_DATE_NOT_FOUND:${fd}`);
  const nextSectionIdx = text.indexOf("每季投資金額", headerIdx);
  const scope = text.slice(headerIdx, nextSectionIdx > 0 ? nextSectionIdx : headerIdx + 3000);
  // 2026-11-03 VERIFIED：每列是「產業\t標的名稱\t比重」用tab分三欄、整個表格逐行渲染。改成
  // 逐行比對（不是跨行regex帶trailing\n），避免regex.exec的lastIndex吃掉分隔用的換行、導致
  // 隔列漏抓（已驗證過这個bug：原本跨行版本只抓到第1/3/5/7/9列，偶數列全部漏掉）。
  const holdings: IssuerHoldingRow[] = [];
  for (const line of scope.split("\n")) {
    if (holdings.length >= 10) break;
    const m = line.match(/^([^\t]+)\t([^\t]+)\t([\d.]+)$/);
    if (!m || m[1] === "投資類型") continue;
    holdings.push({ name: stripCjkInternalSpacing(m[2]), weight: Number(m[3]) });
  }
  if (holdings.length !== 10) throw new Error(`FUBON_HOLDINGS_COUNT_${holdings.length}:${fd}`);
  return { holdings, dataMonth: dateMatch[1], sourceUrl };
}

// 台新投信（tsit.com.tw）：/Fund/FundPortfolio?fundID=<id>頁是一般GET、伺服器端渲染（ASP.NET
// MVC），不需要Puppeteer也不需要偽裝User-Agent（2026-11-03 VERIFIED：plain fetch不帶任何自訂
// header，逐列比對兩檔基金的結果跟瀏覽器實際顯示100%一致）。fundID是從官網「基金淨值」頁
// a.fundID元素的value屬性讀出來的（每個級別各自一個fundID），不是猜的——同一檔基金不同幣別/
// 級別的fundID各不相同，但前十大持股是基金層級資料，所有級別的頁面回傳同一份表格，所以用任一
// 代表fundID抓一次即可覆蓋整檔基金。
export async function fetchTaishinMonthlyHoldings(fundId: string): Promise<IssuerMonthlyHoldingsResult> {
  const sourceUrl = `https://www.tsit.com.tw/Fund/FundPortfolio?fundID=${fundId}`;
  const res = await fetch(sourceUrl);
  if (res.status === 429 || res.status === 403) throw new IssuerSiteBlockedError("TAISHIN", res.status, `HTTP_${res.status}`);
  const html = await res.text();
  const headerIdx = html.indexOf("基金前十大投資明細");
  if (headerIdx < 0) throw new Error(`TAISHIN_MARKER_NOT_FOUND:${fundId}`);
  // 年/月數字各自包在自己的<span id="year">/<span id="month">裡，中間夾著收尾標籤，直接對raw HTML
  // 比對會因為標籤插在數字和「年」/「月」之間而配不到，所以先去標籤再比對。
  const dateMatch = html.slice(headerIdx, headerIdx + 500).replace(/<[^>]+>/g, "").match(/(\d{4})年(\d{1,2})月/);
  if (!dateMatch) throw new Error(`TAISHIN_DATE_NOT_FOUND:${fundId}`);
  const nextSectionIdx = html.indexOf("投資分佈", headerIdx);
  const scope = html.slice(headerIdx, nextSectionIdx > 0 ? nextSectionIdx : headerIdx + 5000);
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const holdings: IssuerHoldingRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(scope)) && holdings.length < 10) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1].replace(/<[^>]+>/g, "").trim());
    if (tds.length < 4 || !/^\d+$/.test(tds[0])) continue;
    holdings.push({ name: stripCjkInternalSpacing(tds[2]), weight: Number(tds[3]) });
  }
  if (holdings.length !== 10) throw new Error(`TAISHIN_HOLDINGS_COUNT_${holdings.length}:${fundId}`);
  return { holdings, dataMonth: `${dateMatch[1]}/${dateMatch[2].padStart(2, "0")}`, sourceUrl };
}
