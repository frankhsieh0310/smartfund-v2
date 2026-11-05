// 2026-11-05（使用者核准）：街口投信00992B（街口優息非投債ETF）2026-10-08才上櫃，查證過官網所有
// 公開管道都還沒有逐筆持股資料（見同輪調查），使用者判斷第一份月報大約11月10日前後才會公布。
// 這支檢查不把「00992B目前沒有持股資料」算成BLOCKING/MINOR/EXTERNAL任何一級異常（本來就沒有
// 任何現行的健康檢查項目在監控這類被動式ETF的持股缺口，不需要刻意抑制），而是單純每天檢查一次
// 「月報出現了沒有」，11/15前完全不查（給官方足夠時間），11/15起每天查，一旦查到就在當天的
// Telegram摘要多加一行提醒，查到之後這支檢查就完成任務（不會一直重複提醒，見route.ts呼叫端的
// 判斷）。
//
// 這個頁面是SPA（Nuxt/React），「檔案下載」區塊的連結是客戶端渲染出來的，純文字fetch拿到的是
// 渲染前的殼，看不到實際內容——用跟hnfunds.ts/CTBC/AB同一套無頭瀏覽器操作，只是單純打開頁面讀
// 文字，不做任何表單操作、不繞過任何東西。
import { withPage } from "../etf-holdings-engine/adapters/browserUtil";

const PAGE_URL = "https://www.jkoam.com/etf/etf-info/62?tab=1";
export const CHECK_START_DATE = "2026-11-15";

export type JkoamMonthlyReportCheckResult = {
  checked: boolean;
  found: boolean;
  note?: string;
};

function looksLikeChallengePage(bodyText: string): boolean {
  return /checking your browser|cloudflare|驗證您是真人|請稍候.{0,20}驗證|unusual traffic|automated queries/i.test(bodyText);
}

export async function check00992BMonthlyReport(todayTaipei: string): Promise<JkoamMonthlyReportCheckResult> {
  if (todayTaipei < CHECK_START_DATE) return { checked: false, found: false };

  try {
    const bodyText = await withPage(
      async (page) => {
        await page.goto(PAGE_URL, { waitUntil: "networkidle0", timeout: 30_000 });
        await new Promise((r) => setTimeout(r, 1000));
        return page.evaluate(() => document.body.innerText);
      },
      undefined,
      undefined,
      { skipUserAgentOverride: true },
    );
    if (looksLikeChallengePage(bodyText)) return { checked: true, found: false, note: "CHALLENGE_PAGE" };
    // 「檔案下載」區塊目前只有「公開說明書」「簡式公開說明書」兩個連結（VERIFIED
    // 2026-11-05）——出現「月報」兩個字就代表多了新的下載項目。
    const found = /檔案下載/.test(bodyText) && /月報/.test(bodyText);
    return { checked: true, found };
  } catch (e) {
    return { checked: true, found: false, note: String(e instanceof Error ? e.message : e).slice(0, 200) };
  }
}
