// 一次性全量補美股52週/市值/公司簡介（本地直連production DB）——跟雲端排程
// app/api/cron/stock-yahoo-hk-profile/route.ts共用同一組lib函式(fetchYahooHkRangeCap/
// fetchYahooHkCompanyProfileZh)，只是這支腳本一次處理完整個美股清單，不像雲端排程受290秒
// maxDuration限制要跨日checkpoint接續。之後的每日增量交給雲端排程處理（已經在那支route.ts裡
// 擴大涵蓋美股），這支只是為了不用等好幾天的每日批次才把現有美股清單補齊一輪。
import { prisma } from "../../../lib/prisma";
import { fetchYahooHkRangeCap, fetchYahooHkCompanyProfileZh, inForbiddenWindowTaipei } from "../../../lib/data-platform/web/stockYahooHkProfile";

const REQUEST_DELAY_MS = 1_000;
const US_EXCHANGES = ["NASDAQ", "NYSE", "NYQ", "NMS", "NCM", "NGM"];

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function todayKey(): string { return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }

async function main() {
  const startCursor = process.argv[2] ?? null;
  const wallBudgetMs = Number(process.argv[3] ?? 7_000_000);
  const started = Date.now();

  const stocks = await prisma.stock.findMany({
    where: { isActive: true, exchange: { in: US_EXCHANGES }, ...(startCursor ? { ticker: { gt: startCursor } } : {}) },
    orderBy: { ticker: "asc" },
    select: { id: true, ticker: true, yahooSymbol: true },
  });
  console.log(`[us-stock-profile] universe=${stocks.length} startCursor=${startCursor ?? "(start)"}`);

  let succeeded = 0, failed = 0, noChineseProfile = 0, blocked = false, lastTicker: string | null = null;
  const todayDate = todayKey();

  for (const stock of stocks) {
    if (inForbiddenWindowTaipei()) { console.log("[us-stock-profile] entering 01:00-05:30 Taipei window, stopping for tonight"); break; }
    if (Date.now() - started > wallBudgetMs) { console.log("[us-stock-profile] wall budget reached, stopping this round"); break; }
    try {
      const rangeCap = await fetchYahooHkRangeCap(stock.yahooSymbol);
      if (rangeCap.status === "BLOCKED") { console.error(`[us-stock-profile] BLOCKED HTTP_${rangeCap.httpStatus} at ${stock.ticker} — stopping, resume tomorrow from this ticker`); blocked = true; break; }
      await sleep(REQUEST_DELAY_MS);
      const profile = await fetchYahooHkCompanyProfileZh(stock.yahooSymbol);
      if (profile.status === "BLOCKED") { console.error(`[us-stock-profile] BLOCKED HTTP_${profile.httpStatus} at ${stock.ticker} — stopping, resume tomorrow from this ticker`); blocked = true; break; }
      const profileText = profile.status === "OK" ? profile.data : null;
      if (profile.status === "NOT_CHINESE") noChineseProfile++;

      if (rangeCap.status === "OK") {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO stock_yahoo_hk_profile (stock_id, week52_low, week52_high, week52_as_of_date, market_cap_raw_text, market_cap_value, market_cap_unit, market_cap_as_of_date, range_cap_source, company_profile, company_profile_as_of_date, profile_source, updated_at)
             VALUES ($1,$2,$3,$4::date,$5,$6,$7,$4::date,'YAHOO_HK_FINANCE',$8,$4::date,'YAHOO_HK_FINANCE_PROFILE_ZH',now())
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
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(`[us-stock-profile] DONE succeeded=${succeeded} failed=${failed} noChineseProfile=${noChineseProfile} blocked=${blocked} lastTicker=${lastTicker} elapsedMs=${Date.now() - started}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
