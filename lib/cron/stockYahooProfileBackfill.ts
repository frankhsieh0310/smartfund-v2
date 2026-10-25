// 選股反查：跨市場掛牌名稱歧義判斷用的Yahoo公司全名/總部國家補值（2026-10-25，使用者核准定案）。
// 見stocks.yahoo_long_name/yahoo_hq_country欄位註解。只補NULL，不覆寫既有值。401/403/429直接
// 停止，不重試繞過。
import { prisma } from "@/lib/prisma";
import { fetchQuoteSummary, type RateStats } from "@/lib/yahoo/productSession";

const MODULES = ["price", "assetProfile"];

export type StaleProfileStock = { id: string; ticker: string; yahooSymbol: string };

// 2026-10-25（使用者核准範圍）: 原本沒有限定範圍，掃全部81,766檔active股票，用不到的冷門股票
// 把預算吃掉，核心母體真正需要的8,121檔反而排不到。改成只補「核心母體（APPROVED ETF/FUND）
// 實際持有」的股票——跟選股反查用的範圍定義一致（stock_security_links驗證過的ETF持股 +
// reverse_current_positions現有已配對的ETF/基金持股）。
export async function findStocksMissingYahooProfile(limit: number, afterTicker: string | null): Promise<StaleProfileStock[]> {
  return prisma.$queryRawUnsafe<StaleProfileStock[]>(
    `WITH held AS (
       SELECT DISTINCT l.stock_id FROM etfs e JOIN etf_holdings h ON h.etf_id=e.id
         JOIN stock_security_links l ON l.security_id=h.security_id AND l.verification_status LIKE 'VERIFIED%'
       WHERE e.is_active AND e.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='ETF' AND status='APPROVED')
       UNION
       SELECT DISTINCT p.stock_id FROM reverse_current_positions p WHERE p.type IN ('ETF','基金')
     )
     SELECT id, ticker, yahoo_symbol AS "yahooSymbol" FROM stocks
      WHERE is_active AND yahoo_long_name IS NULL AND ticker > $2 AND id IN (SELECT stock_id FROM held)
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
