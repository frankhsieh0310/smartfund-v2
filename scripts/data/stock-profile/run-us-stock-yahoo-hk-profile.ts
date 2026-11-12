// 一次性全量補美股公司簡介+流通在外股數（本地直連production DB）——跟雲端排程
// app/api/cron/stock-yahoo-hk-profile/route.ts共用同一個lib函式(fetchCMoneyUsCompanyProfile)，
// 只是這支腳本一次處理完整個美股清單，不像雲端排程受290秒maxDuration限制要跨日checkpoint接續。
// 之後的每月增量交給雲端排程處理，這支只是為了不用等好幾個月的每月批次才把現有美股清單補齊一輪。
// 2026-11-11 使用者更正：公司簡介改用CMoney美股公司簡介頁（中文公司簡介欄位），不再用雅虎財經
// 香港站的英文"描述"欄位。MoneyDJ備援查過需要執行頁面JavaScript才抓得到內容，跟這個repo既有的
// 純HTTP GET原則衝突，沒有實作。
// 2026-11-11 使用者再次更正定案：美股52週區間/市值不再抓取（雅虎財經香港站VERIFIED連續打幾十檔
// 就回傳HTTP 503，擴大到美股後完全撐不住），改成serve時用我們自己的stock_history現算52週、
// 用最新收盤價×這支抓到的流通在外股數算市值——這支腳本因此也不再呼叫fetchYahooHkRangeCap，
// 只剩公司簡介+流通在外股數（同一次CMoney HTTP GET一起抓），被擋(5xx/401/403/429)時冷卻
// COOLDOWN_MS後從中斷點繼續（這是一次性手動全量回補，不是每天跑一次的排程，被擋整個停掉要等
// 24小時太慢；純粹是「等一下再試」，不換頭換身分、不是硬闖）。
// 2026-11-12 使用者核准定案：凌晨01:00-05:30台北時間遇到就暫停（整個process留著等），不是直接
// 結束——視窗過了之後同一個process自動從中斷點繼續跑，不用使用者再手動重新啟動。
import { prisma } from "../../../lib/prisma";
import { inForbiddenWindowTaipei } from "../../../lib/data-platform/web/stockYahooHkProfile";
import { fetchCMoneyUsCompanyProfile } from "../../../lib/data-platform/web/stockUsCompanyProfile";

const REQUEST_DELAY_MS = 3_000; // 放慢速度，降低被節流機率
const COOLDOWN_MS = 120_000; // 被擋(5xx/401/403/429)時冷卻等待2分鐘再從中斷點繼續，不是重試/硬闖
const MAX_COOLDOWNS = 50; // 保險上限，避免真的被永久封鎖時無限空等
const US_EXCHANGES = ["NASDAQ", "NYSE", "NYQ", "NMS", "NCM", "NGM"];

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function todayKey(): string { return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }

async function main() {
  const startCursor = process.argv[2] ?? null;
  const wallBudgetMs = Number(process.argv[3] ?? 7_000_000);
  const started = Date.now();

  const allStocks = await prisma.stock.findMany({
    where: { isActive: true, exchange: { in: US_EXCHANGES } },
    orderBy: { ticker: "asc" },
    select: { id: true, ticker: true, yahooSymbol: true },
  });
  console.log(`[us-stock-profile] universe=${allStocks.length} startCursor=${startCursor ?? "(start)"}`);

  let cursor = startCursor;
  let succeeded = 0, failed = 0, noProfile = 0, cooldowns = 0, lastTicker: string | null = null;
  const todayDate = todayKey();

  outer: while (cooldowns <= MAX_COOLDOWNS) {
    const stocks = allStocks.filter((s) => !cursor || s.ticker > cursor);
    if (!stocks.length) { console.log("[us-stock-profile] full universe covered"); break; }

    for (const stock of stocks) {
      if (inForbiddenWindowTaipei()) {
        console.log("[us-stock-profile] entering 01:00-05:30 Taipei window, pausing (not exiting) — will auto-resume once the window passes");
        while (inForbiddenWindowTaipei()) await sleep(60_000);
        console.log("[us-stock-profile] forbidden window passed, resuming");
      }
      if (Date.now() - started > wallBudgetMs) { console.log("[us-stock-profile] wall budget reached, stopping this round"); break outer; }
      try {
        const profile = await fetchCMoneyUsCompanyProfile(stock.ticker);
        if (profile.status === "BLOCKED") {
          cooldowns++;
          console.error(`[us-stock-profile] BLOCKED HTTP_${profile.httpStatus} (CMoney) at ${stock.ticker} — cooling down ${COOLDOWN_MS / 1000}s (cooldown #${cooldowns}), then resuming from here`);
          cursor = lastTicker;
          await sleep(COOLDOWN_MS);
          continue outer;
        }
        const profileText = profile.status === "OK" ? profile.data : null;
        const sharesOutstanding = profile.status === "OK" || profile.status === "NOT_FOUND" ? profile.sharesOutstanding : null;
        const nameZh = profile.status === "OK" || profile.status === "NOT_FOUND" ? profile.nameZh : null;
        if (profile.status !== "OK") noProfile++;

        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO stock_yahoo_hk_profile (stock_id, company_profile, company_profile_as_of_date, shares_outstanding, shares_outstanding_as_of_date, profile_source, updated_at)
             VALUES ($1,$2,$3::date,$4,$3::date,'CMONEY_US0026',now())
             ON CONFLICT (stock_id) DO UPDATE SET
               company_profile=EXCLUDED.company_profile, company_profile_as_of_date=EXCLUDED.company_profile_as_of_date,
               shares_outstanding=EXCLUDED.shares_outstanding, shares_outstanding_as_of_date=EXCLUDED.shares_outstanding_as_of_date,
               profile_source=EXCLUDED.profile_source, updated_at=now()`,
            stock.id, profileText, todayDate, sharesOutstanding,
          );
          if (nameZh) {
            await tx.$executeRawUnsafe(`UPDATE stocks SET company_name_zh = $1 WHERE id = $2 AND company_name_zh IS NULL`, nameZh, stock.id);
          }
          const verify = await tx.$queryRawUnsafe<Array<{ stock_id: unknown }>>(`SELECT stock_id FROM stock_yahoo_hk_profile WHERE stock_id=$1`, stock.id);
          if (!verify.length) throw new Error(`verify failed for ${stock.ticker}`);
        });
        succeeded++;
      } catch (e) {
        failed++;
        console.error(`[us-stock-profile] error for ${stock.ticker}`, e instanceof Error ? e.message : e);
      }
      lastTicker = stock.ticker;
      cursor = stock.ticker;
      if ((succeeded + failed) % 20 === 0) console.log(`[us-stock-profile] progress: succeeded=${succeeded} failed=${failed} noProfile=${noProfile} cooldowns=${cooldowns} lastTicker=${lastTicker}`);
      await sleep(REQUEST_DELAY_MS);
    }
    break; // finished the stocks list without hitting `continue outer`
  }

  console.log(`[us-stock-profile] DONE succeeded=${succeeded} failed=${failed} noProfile=${noProfile} cooldowns=${cooldowns} lastTicker=${lastTicker} elapsedMs=${Date.now() - started}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
