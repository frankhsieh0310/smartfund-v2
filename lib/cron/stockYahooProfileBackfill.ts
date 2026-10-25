// 選股反查：跨市場掛牌名稱歧義判斷用的Yahoo公司全名/總部國家補值（2026-10-25，使用者核准定案）。
// 見stocks.yahoo_long_name/yahoo_hq_country欄位註解。只補NULL，不覆寫既有值。401/403/429直接
// 停止，不重試繞過。
import { prisma } from "@/lib/prisma";
import { fetchQuoteSummary, type RateStats } from "@/lib/yahoo/productSession";

const MODULES = ["price", "assetProfile"];

export type StaleProfileStock = { id: string; ticker: string; yahooSymbol: string };

export async function findStocksMissingYahooProfile(limit: number, afterTicker: string | null): Promise<StaleProfileStock[]> {
  return prisma.$queryRawUnsafe<StaleProfileStock[]>(
    `SELECT id, ticker, yahoo_symbol AS "yahooSymbol" FROM stocks
      WHERE is_active AND yahoo_long_name IS NULL AND ticker > $2
      ORDER BY ticker ASC
      LIMIT $1`,
    limit, afterTicker ?? "",
  );
}

export type ProfileBackfillResult = { ok: boolean; written: boolean; failureReason?: string };

export async function backfillOneStockProfile(stock: StaleProfileStock, writeEnabled: boolean, stats?: RateStats): Promise<ProfileBackfillResult> {
  const qs = await fetchQuoteSummary(stock.yahooSymbol, MODULES, stats);
  if (!qs) return { ok: false, written: false, failureReason: stats?.lastFailure ?? "NO_RESULT" };
  const longName: string | null = qs.result?.price?.longName ?? null;
  const hqCountry: string | null = qs.result?.assetProfile?.country ?? null;
  // longName是必要欄位（用來確認「是不是同一家公司」），沒有longName就不寫入任何一半的資料，
  // 避免之後比對邏輯誤判「有longName但沒有國家」為某種確定狀態。
  if (!longName) return { ok: true, written: false, failureReason: "NO_LONG_NAME" };
  if (!writeEnabled) return { ok: true, written: false };
  const rowCount = await prisma.$executeRawUnsafe(
    `UPDATE stocks SET yahoo_long_name = $1, yahoo_hq_country = $2, updated_at = now() WHERE id = $3 AND yahoo_long_name IS NULL`,
    longName, hqCountry, stock.id,
  );
  return { ok: true, written: rowCount > 0 };
}
