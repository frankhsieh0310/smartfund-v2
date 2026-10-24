// 全球股票最新價格同步（2026-10-24，使用者核准定案）: 原本這件事在Railway上的smartfund-v2
// 服務跑（scripts/data/daily/run-production-yahoo-daily.ts），搬到Vercel cron。範圍限縮為
// 「只處理核心母體需要的股票」——四類核心母體ETF／基金實際有持有的非台股/美股股票
// （findCoreUniverseHeldStockIds，跟Yahoo基本面同步共用同一份清單），不是整個81,766檔全球
// 股票池。價格一律照抄Yahoo chart API的regularMarketPrice/regularMarketTime（fetchChartFull，
// 不需要crumb），不自己算。
import { prisma } from "@/lib/prisma";
import { fetchChartFull } from "@/lib/yahoo/productSession";
import { findCoreUniverseHeldStockIds } from "@/lib/cron/coreUniverseHeldStocks";

export type StaleGlobalPriceStock = { id: string; ticker: string; yahooSymbol: string };

export async function findStaleGlobalPriceStocks(limit: number, afterTicker: string | null): Promise<StaleGlobalPriceStock[]> {
  const heldStockIds = await findCoreUniverseHeldStockIds();
  if (heldStockIds.length === 0) return [];
  return prisma.$queryRawUnsafe<StaleGlobalPriceStock[]>(
    `SELECT id, ticker, yahoo_symbol AS "yahooSymbol" FROM stocks
      WHERE is_active AND id = ANY($3::text[]) AND ticker > $2
        AND (latest_date IS NULL OR latest_date < CURRENT_DATE)
      ORDER BY ticker ASC
      LIMIT $1`,
    limit, afterTicker ?? "", heldStockIds,
  );
}

export type SyncOnePriceResult = { ok: boolean; written: boolean; failureReason?: string };

export async function syncOneStockPrice(stock: StaleGlobalPriceStock, writeEnabled: boolean): Promise<SyncOnePriceResult> {
  const chart = await fetchChartFull(stock.yahooSymbol);
  if (!chart || chart.regularMarketPrice == null || !chart.regularMarketTime) {
    return { ok: false, written: false, failureReason: !chart ? "NO_RESULT" : "NO_PRICE" };
  }
  if (!writeEnabled) return { ok: true, written: false };
  const date = chart.regularMarketTime.slice(0, 10);
  await prisma.$executeRawUnsafe(
    `UPDATE stocks SET latest_close = $1, latest_date = $2::date, updated_at = now() WHERE id = $3`,
    chart.regularMarketPrice, date, stock.id,
  );
  return { ok: true, written: true };
}
