// 一次性全量補美股52週/市值/公司簡介（本地直連production DB）——跟雲端排程
// app/api/cron/stock-yahoo-hk-profile/route.ts共用同一組lib函式(fetchYahooHkRangeCap/
// fetchCMoneyUsCompanyProfile)，只是這支腳本一次處理完整個美股清單，不像雲端排程受290秒
// maxDuration限制要跨日checkpoint接續。之後的每日增量交給雲端排程處理（已經在那支route.ts裡
// 擴大涵蓋美股），這支只是為了不用等好幾天的每日批次才把現有美股清單補齊一輪。
// 2026-11-11 使用者更正：公司簡介改用CMoney美股公司簡介頁（中文公司簡介欄位），不再用雅虎財經
// 香港站的英文"描述"欄位。52週/市值仍是雅虎。MoneyDJ備援查過需要執行頁面JavaScript才抓得到內容，
// 跟這個repo既有的純HTTP GET原則衝突，沒有實作。
// 2026-11-11 使用者回報核實擴大到美股後發現：雅虎財經香港站連續打幾十檔後開始回傳HTTP 503
// （VERIFIED），就算間隔拉到2秒也只撐2-3檔就被擋。「被擋就自動停、隔天續跑」原本的設計沒錯，
// 但這支是一次性手動全量回補（不是每天跑一次的排程），被擋就整個停掉要等24小時才能繼續，太慢。
// 改成：被擋時在同一個執行續內冷卻等待（COOLDOWN_MS），之後從中斷的那檔繼續，不是立刻重試、
// 不換頭換身分、不是硬闖——純粹是「等一下再試」，跟使用者站在瀏覽器前被擋住、等幾分鐘再重新
// 整理頁面是同一件事。每日排程（route.ts）仍然是單次invocation內遇到BLOCKED就整個停止、隔天
// 自然從checkpoint接續，沒有改那支的行為。
import { prisma } from "../../../lib/prisma";
import { fetchYahooHkRangeCap, inForbiddenWindowTaipei } from "../../../lib/data-platform/web/stockYahooHkProfile";
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
      if (inForbiddenWindowTaipei()) { console.log("[us-stock-profile] entering 01:00-05:30 Taipei window, stopping for tonight"); break outer; }
      if (Date.now() - started > wallBudgetMs) { console.log("[us-stock-profile] wall budget reached, stopping this round"); break outer; }
      try {
        const rangeCap = await fetchYahooHkRangeCap(stock.yahooSymbol);
        if (rangeCap.status === "BLOCKED") {
          cooldowns++;
          console.error(`[us-stock-profile] BLOCKED HTTP_${rangeCap.httpStatus} at ${stock.ticker} — cooling down ${COOLDOWN_MS / 1000}s (cooldown #${cooldowns}), then resuming from here`);
          cursor = lastTicker;
          await sleep(COOLDOWN_MS);
          continue outer;
        }
        await sleep(REQUEST_DELAY_MS);
        const profile = await fetchCMoneyUsCompanyProfile(stock.ticker);
        if (profile.status === "BLOCKED") {
          cooldowns++;
          console.error(`[us-stock-profile] BLOCKED HTTP_${profile.httpStatus} (CMoney) at ${stock.ticker} — cooling down ${COOLDOWN_MS / 1000}s (cooldown #${cooldowns}), then resuming from here`);
          cursor = lastTicker;
          await sleep(COOLDOWN_MS);
          continue outer;
        }
        const profileText = profile.status === "OK" ? profile.data : null;
        if (profile.status !== "OK") noProfile++;

        if (rangeCap.status === "OK") {
          await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO stock_yahoo_hk_profile (stock_id, week52_low, week52_high, week52_as_of_date, market_cap_raw_text, market_cap_value, market_cap_unit, market_cap_as_of_date, range_cap_source, company_profile, company_profile_as_of_date, profile_source, updated_at)
               VALUES ($1,$2,$3,$4::date,$5,$6,$7,$4::date,'YAHOO_HK_FINANCE',$8,$4::date,'CMONEY_US0026',now())
               ON CONFLICT (stock_id) DO UPDATE SET
                 week52_low=EXCLUDED.week52_low, week52_high=EXCLUDED.week52_high, week52_as_of_date=EXCLUDED.week52_as_of_date,
                 market_cap_raw_text=EXCLUDED.market_cap_raw_text, market_cap_value=EXCLUDED.market_cap_value, market_cap_unit=EXCLUDED.market_cap_unit, market_cap_as_of_date=EXCLUDED.market_cap_as_of_date,
                 company_profile=EXCLUDED.company_profile, company_profile_as_of_date=EXCLUDED.company_profile_as_of_date,
                 profile_source=EXCLUDED.profile_source, updated_at=now()`,
              stock.id, rangeCap.data.week52Low, rangeCap.data.week52High, todayDate,
              rangeCap.data.marketCapRawText, rangeCap.data.marketCapValue, rangeCap.data.marketCapUnit,
              profileText,
            );
            const verify = await tx.$queryRawUnsafe<Array<{ week52_low: unknown }>>(`SELECT week52_low FROM stock_yahoo_hk_profile WHERE stock_id=$1`, stock.id);
            if (!verify.length) throw new Error(`verify failed for ${stock.ticker}`);
          });
          succeeded++;
        } else {
          failed++;
          console.error(`[us-stock-profile] rangeCap status=${rangeCap.status} for ${stock.ticker} (${stock.yahooSymbol})`);
        }
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
