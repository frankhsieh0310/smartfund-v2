// 一次性全量回補台股52週/市值/公司簡介（本地直連production DB）——跟雲端排程
// app/api/cron/stock-yahoo-hk-profile/route.ts共用同一組lib函式(fetchYahooHkRangeCap/
// fetchTwseCompanyProfile)。既有的每日排程(2026-11-08上線)一直只有約48%覆蓋率
// （958/1977），VERIFIED根因是雅虎財經香港站回傳HTTP 503時原本沒被當成BLOCKED、一路
// 硬闖過封鎖——這個bug已經在stockYahooHkProfile.ts修好(5xx一律視同BLOCKED)。這支腳本
// 用修好後的邏輯重跑一次完整回補，不用等每日排程一天一小段地慢慢補。
// 被擋(5xx/401/403/429)時在同一個執行續內冷卻等待(COOLDOWN_MS)後從中斷點繼續，不是立刻
// 重試、不換頭換身分、不是硬闖——這是一次性手動全量回補，不是每天跑一次的排程，被擋整個
// 停掉要等24小時太慢；跟美股那支run-us-stock-yahoo-hk-profile.ts同一套做法。
import { prisma } from "../../../lib/prisma";
import { fetchYahooHkRangeCap, fetchTwseCompanyProfile, inForbiddenWindowTaipei } from "../../../lib/data-platform/web/stockYahooHkProfile";

const REQUEST_DELAY_MS = 2_000;
const COOLDOWN_MS = 120_000;
const MAX_COOLDOWNS = 50;
const TW_EXCHANGES = ["TWSE", "TPEx", "TPEX"];
const PROFILE_REFRESH_DAYS = 25;

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function todayKey(): string { return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }

async function main() {
  const startCursor = process.argv[2] ?? null;
  const wallBudgetMs = Number(process.argv[3] ?? 7_000_000);
  const started = Date.now();

  const allStocks = await prisma.stock.findMany({
    where: { isActive: true, exchange: { in: TW_EXCHANGES } },
    orderBy: { ticker: "asc" },
    select: { id: true, ticker: true, yahooSymbol: true },
  });
  console.log(`[tw-stock-profile] universe=${allStocks.length} startCursor=${startCursor ?? "(start)"}`);

  let cursor = startCursor;
  let succeeded = 0, failed = 0, noProfile = 0, cooldowns = 0, lastTicker: string | null = null;
  const todayDate = todayKey();

  outer: while (cooldowns <= MAX_COOLDOWNS) {
    const stocks = allStocks.filter((s) => !cursor || s.ticker > cursor);
    if (!stocks.length) { console.log("[tw-stock-profile] full universe covered"); break; }

    for (const stock of stocks) {
      if (inForbiddenWindowTaipei()) { console.log("[tw-stock-profile] entering 01:00-05:30 Taipei window, stopping for tonight"); break outer; }
      if (Date.now() - started > wallBudgetMs) { console.log("[tw-stock-profile] wall budget reached, stopping this round"); break outer; }
      try {
        const rangeCap = await fetchYahooHkRangeCap(stock.yahooSymbol);
        if (rangeCap.status === "BLOCKED") {
          cooldowns++;
          console.error(`[tw-stock-profile] BLOCKED HTTP_${rangeCap.httpStatus} at ${stock.ticker} — cooling down ${COOLDOWN_MS / 1000}s (cooldown #${cooldowns}), then resuming from here`);
          cursor = lastTicker;
          await sleep(COOLDOWN_MS);
          continue outer;
        }
        const existing = await prisma.$queryRawUnsafe<Array<{ company_profile_as_of_date: Date | null }>>(
          `SELECT company_profile_as_of_date FROM stock_yahoo_hk_profile WHERE stock_id = $1`, stock.id,
        );
        const profileAge = existing[0]?.company_profile_as_of_date
          ? (Date.now() - new Date(existing[0].company_profile_as_of_date).getTime()) / 86_400_000
          : Infinity;
        let profileText: string | null = null;
        let profileFetched = false;
        if (profileAge > PROFILE_REFRESH_DAYS) {
          await sleep(REQUEST_DELAY_MS);
          const profile = await fetchTwseCompanyProfile(stock.ticker);
          if (profile.status === "BLOCKED") {
            cooldowns++;
            console.error(`[tw-stock-profile] BLOCKED HTTP_${profile.httpStatus} (MOPS) at ${stock.ticker} — cooling down ${COOLDOWN_MS / 1000}s (cooldown #${cooldowns}), then resuming from here`);
            cursor = lastTicker;
            await sleep(COOLDOWN_MS);
            continue outer;
          }
          if (profile.status === "OK") { profileText = profile.data; profileFetched = true; }
          else { noProfile++; profileFetched = true; }
        }

        if (rangeCap.status === "OK") {
          await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO stock_yahoo_hk_profile (stock_id, week52_low, week52_high, week52_as_of_date, market_cap_raw_text, market_cap_value, market_cap_unit, market_cap_as_of_date, range_cap_source, company_profile, company_profile_as_of_date, profile_source, updated_at)
               VALUES ($1,$2,$3,$4::date,$5,$6,$7,$4::date,'YAHOO_HK_FINANCE',$8,CASE WHEN $9 THEN $4::date ELSE NULL END,'TWSE_MOPS_T05ST03',now())
               ON CONFLICT (stock_id) DO UPDATE SET
                 week52_low=EXCLUDED.week52_low, week52_high=EXCLUDED.week52_high, week52_as_of_date=EXCLUDED.week52_as_of_date,
                 market_cap_raw_text=EXCLUDED.market_cap_raw_text, market_cap_value=EXCLUDED.market_cap_value, market_cap_unit=EXCLUDED.market_cap_unit, market_cap_as_of_date=EXCLUDED.market_cap_as_of_date,
                 company_profile=CASE WHEN $9 THEN EXCLUDED.company_profile ELSE stock_yahoo_hk_profile.company_profile END,
                 company_profile_as_of_date=CASE WHEN $9 THEN EXCLUDED.company_profile_as_of_date ELSE stock_yahoo_hk_profile.company_profile_as_of_date END,
                 profile_source=CASE WHEN $9 THEN EXCLUDED.profile_source ELSE stock_yahoo_hk_profile.profile_source END,
                 updated_at=now()`,
              stock.id, rangeCap.data.week52Low, rangeCap.data.week52High, todayDate,
              rangeCap.data.marketCapRawText, rangeCap.data.marketCapValue, rangeCap.data.marketCapUnit,
              profileText, profileFetched,
            );
            const verify = await tx.$queryRawUnsafe<Array<{ week52_low: unknown }>>(`SELECT week52_low FROM stock_yahoo_hk_profile WHERE stock_id=$1`, stock.id);
            if (!verify.length) throw new Error(`verify failed for ${stock.ticker}`);
          });
          succeeded++;
        } else {
          failed++;
          console.error(`[tw-stock-profile] rangeCap status=${rangeCap.status} for ${stock.ticker} (${stock.yahooSymbol})`);
        }
      } catch (e) {
        failed++;
        console.error(`[tw-stock-profile] error for ${stock.ticker}`, e instanceof Error ? e.message : e);
      }
      lastTicker = stock.ticker;
      cursor = stock.ticker;
      if ((succeeded + failed) % 20 === 0) console.log(`[tw-stock-profile] progress: succeeded=${succeeded} failed=${failed} noProfile=${noProfile} cooldowns=${cooldowns} lastTicker=${lastTicker}`);
      await sleep(REQUEST_DELAY_MS);
    }
    break;
  }

  console.log(`[tw-stock-profile] DONE succeeded=${succeeded} failed=${failed} noProfile=${noProfile} cooldowns=${cooldowns} lastTicker=${lastTicker} elapsedMs=${Date.now() - started}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
