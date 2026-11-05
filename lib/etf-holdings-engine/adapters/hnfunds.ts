// Hua Nan (華南永昌) Securities Investment Trust — official 申購買回清單頁面的「下載Excel」功能，
// 無頭瀏覽器操作，不讀取/重放cookie、不手動加標頭、不直接呼叫API。
//
// VERIFIED 2026-11-05：官網 https://www.hnfunds.com.tw/etf/trading-info/redemption-list 的「下載
// Excel」按鈕，實際上不是瀏覽器原生檔案下載，而是觸發頁面本身對
// POST /WEB_API/HN_OW_PROD/ETF/BuyBack/Excel 的XHR請求，回應JSON裡的Data.FileData是base64編碼的
// xlsx檔。曾經試過從一支獨立腳本直接呼叫同一個網址（不開瀏覽器），一律回401——這個API顯然需要
// 瀏覽器自己的session context才會放行。這支adapter改成讓無頭瀏覽器實際「開頁面→選ETF→按下載」，
// 攔截頁面自己觸發的那個XHR回應來讀資料，不自己組裝/重放任何cookie或token，就是單純的使用者
// 操作自動化——跟CTBC/AB adapter遇到SPA頁面時用同一套withPage()機制。
// 2026-11-05使用者核准定案：不偽裝User-Agent，用無頭瀏覽器預設值，所以這裡特意不呼叫
// page.setUserAgent()（browserUtil.ts的withPage()本身預設會設成桌機版Chrome字串，這裡用
// skipUserAgentOverride跳過，維持Chromium自己的真實UA）。
import * as XLSX from "xlsx";
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";
import { withPage } from "./browserUtil.ts";

const PAGE_URL = "https://www.hnfunds.com.tw/etf/trading-info/redemption-list";

// 這個頁面的「切換ETF」下拉選單本身就用market ticker當顯示文字跟選項值，不需要另外的內部ID
// map——跟USITC adapter同樣的情況（官網本身沒有另一層internal ID）。保留這個Set只是讓「這支
// adapter目前覆蓋哪些ticker」跟其他adapter一樣用同一種方式看得出來。
export const SUPPORTED_TICKERS = new Set(["009808", "009818", "009822"]);

const GOTO_TIMEOUT_MS = 30_000;
const CLICK_WAIT_TIMEOUT_MS = 15_000;
const DOWNLOAD_RESPONSE_TIMEOUT_MS = 20_000;

function num(s: string | number | undefined | null): number {
  if (s === undefined || s === null) return 0;
  return Number(String(s).replace(/[^0-9.-]/g, "")) || 0;
}

/** 用文字內容找並點擊頁面上的元素——只找「沒有子元素的葉節點」，避免點到外層容器導致事件沒有
 * 正確觸發在真正可點擊的按鈕/連結上。模擬的是一般使用者「找到看得到的文字、點下去」的操作，
 * 不是繞過任何東西。 */
async function clickByExactText(page: import("puppeteer-core").Page, text: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (t: string) => Array.from(document.querySelectorAll("body *")).some((el) => el.children.length === 0 && (el.textContent ?? "").trim() === t),
    { timeout: timeoutMs },
    text,
  );
  await page.evaluate((t: string) => {
    const el = Array.from(document.querySelectorAll("body *")).find((e) => e.children.length === 0 && (e.textContent ?? "").trim() === t);
    (el as HTMLElement | undefined)?.click();
  }, text);
}

/** 常見機器人驗證/挑戰頁的文字特徵——偵測到就視同被擋，直接丟EXTERNAL可辨識的錯誤，不嘗試
 * 任何方式通過驗證。 */
function looksLikeChallengePage(bodyText: string): boolean {
  return /checking your browser|cloudflare|驗證您是真人|請稍候.{0,20}驗證|unusual traffic|automated queries/i.test(bodyText);
}

type HnfundsExcelResponse = {
  Data: { FileName: string; FileData: string } | null;
  Message: string;
  MessageType: string;
  ResultCode: string;
};

export const HnfundsOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "HNFUNDS",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    if (!SUPPORTED_TICKERS.has(etfCode)) throw new Error(`HNFUNDS_UNMAPPED_ETF_${etfCode} — not in the supported ticker set, never guessed`);

    const stages: Array<{ stage: string; elapsedMs: number }> = [];
    const t0 = Date.now();
    try {
      return await withPage(
        async (page) => {
          // VERIFIED 2026-11-05：這個「下載Excel」按鈕本身不一定會觸發新的network request——實測
          // 發現選取ETF（下拉選單）這個動作本身就可能已經side-effect地觸發了
          // POST /WEB_API/HN_OW_PROD/ETF/BuyBack/Excel（頁面似乎在選定基金當下就預先取得匯出檔，
          // 按鈕只是把已經拿到的資料存成檔案），不是每次都在「按下下載」那一刻才發送。用持續收集
          // 所有符合的response（而不是只等一次性的waitForResponse）避免錯過在點擊下載按鈕之前就
          // 已經發生的那一次。
          const excelResponses: import("puppeteer-core").HTTPResponse[] = [];
          const onResponse = (res: import("puppeteer-core").HTTPResponse) => {
            if (res.url().includes("/WEB_API/HN_OW_PROD/ETF/BuyBack/Excel") && res.request().method() === "POST") excelResponses.push(res);
          };
          page.on("response", onResponse);
          try {
            await page.goto(PAGE_URL, { waitUntil: "networkidle0", timeout: GOTO_TIMEOUT_MS });
            stages.push({ stage: "goto", elapsedMs: Date.now() - t0 });

            const bodyText = await page.evaluate(() => document.body.innerText);
            if (looksLikeChallengePage(bodyText)) throw new Error(`HNFUNDS_CHALLENGE_PAGE_${etfCode}`);

            // 頁面預設載入某一檔基金（通常是清單第一檔）——一律經過「切換ETF」流程明確選到目標
            // ticker，不依賴預設值，避免issuer調整預設排序時默默抓錯基金。
            await clickByExactText(page, "切換ETF", CLICK_WAIT_TIMEOUT_MS);
            stages.push({ stage: "open_switcher", elapsedMs: Date.now() - t0 });
            // VERIFIED 2026-11-05：如果目標ticker剛好就是頁面目前已經顯示的那一檔，下拉選單裡對應
            // 它的項目行為不穩定（有時點擊照常生效，有時逾時）——這裡短逾時試點一次，逾時就視為
            // 「已經在目標基金上」繼續往下走，不是真的錯誤；下載完成後用官方檔名核對ticker正確
            // 這一步仍然會抓到任何誤判。
            try {
              await clickByExactText(page, etfCode, 4_000);
              stages.push({ stage: "select_etf", elapsedMs: Date.now() - t0 });
            } catch {
              stages.push({ stage: "select_etf_skipped_already_active", elapsedMs: Date.now() - t0 });
            }
            // 切換後頁面需要時間重新渲染——等「下載Excel」按鈕重新出現代表畫面已經換成新選的基金。
            await page.waitForFunction(
              () => Array.from(document.querySelectorAll("body *")).some((el) => el.children.length === 0 && (el.textContent ?? "").trim() === "下載 Excel"),
              { timeout: CLICK_WAIT_TIMEOUT_MS },
            );
            await new Promise((r) => setTimeout(r, 1200));

            // 一般使用者會做的操作：按下下載按鈕。無論剛才選取基金時是否已經side-effect觸發過
            // 這個請求，這裡都照常點一次——多點一次不會造成問題，只是確保按鈕本身真的被操作過。
            await clickByExactText(page, "下載 Excel", CLICK_WAIT_TIMEOUT_MS).catch(() => {
              stages.push({ stage: "download_button_click_failed_but_continuing", elapsedMs: Date.now() - t0 });
            });

            const deadline = Date.now() + DOWNLOAD_RESPONSE_TIMEOUT_MS;
            while (excelResponses.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
            if (!excelResponses.length) throw new Error(`HNFUNDS_NO_EXCEL_RESPONSE_${etfCode}`);
            stages.push({ stage: "download_response", elapsedMs: Date.now() - t0 });
          } finally {
            page.off("response", onResponse);
          }

          const response = excelResponses[excelResponses.length - 1];
          const status = response.status();
          if (status === 401 || status === 403 || status === 429) throw new Error(`HNFUNDS_HTTP_${status}_${etfCode}`);
          if (!response.ok()) throw new Error(`HNFUNDS_HTTP_${status}_${etfCode}`);

          const json: HnfundsExcelResponse = await response.json();
          if (json.ResultCode !== "01" || !json.Data?.FileData) throw new Error(`HNFUNDS_EXCEL_FAILED_${etfCode} — ${json.Message || "no FileData in response"}`);

          // 官方檔名就帶著資料日期（例如"009808_20261106.xlsx"）——照抄，不自己重算；同時用檔名
          // 開頭核對這真的是剛剛選的那一檔，不是畫面還沒切換完成時殘留的舊資料。
          const fileNameMatch = /^(\d{4,6}[A-Z]?)_(\d{8})\.xlsx$/.exec(json.Data.FileName);
          if (!fileNameMatch) throw new Error(`HNFUNDS_UNEXPECTED_FILENAME_${etfCode}_${json.Data.FileName}`);
          if (fileNameMatch[1] !== etfCode) throw new Error(`HNFUNDS_TICKER_MISMATCH_expected_${etfCode}_got_${fileNameMatch[1]} — ETF切換可能沒有完成`);
          const rawDate = fileNameMatch[2];
          const dataDate = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;

          const workbook = XLSX.read(Buffer.from(json.Data.FileData, "base64"), { type: "buffer" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1 });
          stages.push({ stage: "xlsx_parsed", elapsedMs: Date.now() - t0 });

          let fundNav = 0;
          let outstandingUnits = 0;
          const positions: CanonicalPosition[] = [];
          // section: null=還沒進入任何表格區塊；"股票"/"期貨"/"其他資產"=目前正在讀的區塊，用章節
          // 標題（獨立一行、只有一個儲存格的那種列）切換，表格內容照官方Excel原樣逐列讀取，權重
          // 欄位直接複製，不自行計算。
          let section: "股票" | "期貨" | "其他資產" | null = null;
          for (const row of rows) {
            const cells = row.map((c) => (c === undefined || c === null ? "" : String(c).trim()));
            if (cells.every((c) => c === "")) continue; // 空白分隔列
            if (cells.length === 2 && /^每受益權單位淨資產價值/.test(cells[0])) { fundNav = num(cells[1]); continue; }
            if (cells.length === 2 && /^已發行受益權單位總數/.test(cells[0])) { outstandingUnits = num(cells[1]); continue; }
            if (cells.length === 1 && cells[0] === "持股成分") { section = "股票"; continue; }
            if (cells.length === 1 && cells[0] === "期貨") { section = "期貨"; continue; }
            if (cells.length === 1 && cells[0] === "其他資產") { section = "其他資產"; continue; }
            if (cells[0] === "股票代碼" || cells[0] === "期貨代號" || cells[0] === "項目") continue; // 區塊內自己的欄位標頭列

            if (section === "股票" && cells.length >= 4) {
              positions.push({
                securityCode: cells[0], securityName: cells[1],
                positionType: "EQUITY", positionAmount: num(cells[2]), positionUnit: "SHARES",
                weight: num(cells[3]), canonicalSecurityId: null,
              });
            } else if (section === "期貨" && cells.length >= 4) {
              positions.push({
                securityCode: cells[0], securityName: cells[1],
                positionType: "FUTURE", positionAmount: num(cells[2]), positionUnit: "CONTRACTS",
                weight: num(cells[3]), canonicalSecurityId: null,
              });
            } else if (section === "其他資產" && cells.length >= 2) {
              // 現金/保證金/應付贖回款等非個股項目——使用者要求照原樣保留並標示類別，不是丟棄。
              // 這個區塊官方Excel本身沒有權重欄，weight留0，positionAmount放金額原文。
              positions.push({
                securityCode: cells[0], securityName: cells[0],
                positionType: "OTHER", positionAmount: num(cells[1]), positionUnit: "OTHER",
                weight: 0, canonicalSecurityId: null,
              });
            }
          }
          if (!positions.length) throw new Error(`HNFUNDS_NO_HOLDINGS_${etfCode}_${dataDate}`);

          const hasBond = positions.some((p) => p.positionType === "BOND");
          const hasEquity = positions.some((p) => p.positionType === "EQUITY");
          return {
            etfCode,
            issuer: "HNFUNDS",
            assetType: hasBond && hasEquity ? "MULTI_ASSET" : hasBond ? "BOND" : hasEquity ? "EQUITY" : "OTHER",
            dataDate,
            announcementDate: dataDate,
            fundNav,
            outstandingUnits,
            positions,
            source: "HNFUNDS_OFFICIAL_BUYBACK_EXCEL",
            retrievedAt: new Date().toISOString(),
          };
        },
        signal,
        (stage, elapsedMs) => stages.push({ stage, elapsedMs }),
        { skipUserAgentOverride: true },
      );
    } catch (e) {
      const lastStage = stages.length ? stages[stages.length - 1] : { stage: "before_browser_acquired", elapsedMs: Date.now() - t0 };
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${msg} (last_completed_stage=${lastStage.stage} elapsed_ms=${lastStage.elapsedMs} total_ms=${Date.now() - t0})`);
    }
  },
};
