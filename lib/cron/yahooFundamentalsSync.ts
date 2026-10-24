// 選股反查：Yahoo基本面同步（2026-10-24，使用者核准定案，取代自行用財報算TTM的做法，
// 見CLAUDE.md「資料來源原則」）: 本益比、股價淨值比、殖利率、ROE、ROA、營收成長率、盈餘成長率、
// 毛利率、淨利率，一律照抄Yahoo quoteSummary（summaryDetail/financialData/defaultKeyStatistics），
// 不自己用net_income/shareholders_equity/revenue算比率。寫入metric前綴"yahoo_fundamentals."，
// 跟既有MOPS/SEC/BWIBBU來源的metric(financial.*/valuation.pe)分開存——那些資料保留做交叉核對用
// （不一致時列為異常，不是拿來自己選一個當正確答案），不是這次的主要讀取來源。
import { prisma } from "@/lib/prisma";
import { fetchQuoteSummary, rawNum, newRateStats, type RateStats } from "@/lib/yahoo/productSession";

const MODULES = ["summaryDetail", "financialData", "defaultKeyStatistics"];

export type YahooFundamentals = {
  pe: number | null; pb: number | null; dividendYield: number | null;
  roe: number | null; roa: number | null; revenueGrowth: number | null; earningsGrowth: number | null;
  grossMargin: number | null; profitMargin: number | null;
};

export function extractYahooFundamentals(result: any): YahooFundamentals {
  const sd = result.summaryDetail ?? {}, fd = result.financialData ?? {}, ks = result.defaultKeyStatistics ?? {};
  return {
    pe: rawNum(sd.trailingPE), pb: rawNum(ks.priceToBook), dividendYield: rawNum(sd.dividendYield),
    roe: rawNum(fd.returnOnEquity), roa: rawNum(fd.returnOnAssets),
    revenueGrowth: rawNum(fd.revenueGrowth), earningsGrowth: rawNum(fd.earningsGrowth),
    grossMargin: rawNum(fd.grossMargins), profitMargin: rawNum(fd.profitMargins),
  };
}

const METRIC_PREFIX = "yahoo_fundamentals.";
export const YAHOO_FUNDAMENTAL_METRICS = ["pe", "pb", "dividendYield", "roe", "roa", "revenueGrowth", "earningsGrowth", "grossMargin", "profitMargin"] as const;

export type StaleFundamentalStock = { id: string; ticker: string; yahooSymbol: string; currency: string };

// 2026-10-24（獨立代理驗收發現的根因，使用者核准修正）: 原本用「有沒有yahoo_fundamentals.pe」
// 判斷「今天同步過了沒」——虧損股Yahoo本來就不會給PE（Yahoo自己的網頁也不顯示），這種股票會
// 永遠被判定「還沒同步」，每小時都重新打一次Yahoo（浪費），而且screener那邊的PE備援邏輯也沒辦法
// 分辨「Yahoo還沒查過」跟「Yahoo查過了、真的沒有PE」——兩種情況都是「沒有yahoo_fundamentals.pe
// 這筆資料」，長得一模一樣，導致後者也會被誤接去讀舊的官方備援來源，違反「Yahoo沒有的數字顯示
// 無資料，不准補算」。改用一個獨立的「_synced」標記：只要今天成功打過一次Yahoo（不管九個欄位裡
// 有沒有真的拿到值），就寫這筆標記——判斷「今天同不同步過」看這個，不是看pe本身有沒有值。
const SYNCED_MARKER_METRIC = `${METRIC_PREFIX}_synced`;

/** Stocks Yahoo hasn't been successfully checked for today, oldest/never-synced first (ticker
 * order gives a stable, resumable cursor across runs within the same day). */
// 2026-10-24（使用者核准修正，範圍缺陷）: 原本沒有country篩選，掃描全部81,766檔全球活躍股票
// （DE/IT/FR/HK/CN/GB/CA/JP/AU/KR/NL/SE/SG...），但選股反查(stockScreener.ts)只服務
// market "TW"/"US"兩種——其他市場的基本面同步完全是浪費額度，而且因為ticker排序，TW要等
// 掃完前6791檔、US要等掃完前33735檔才會輪到，等於優先權完全錯置。改成只掃TW+US。
export async function findStaleFundamentalStocks(limit: number, afterTicker: string | null): Promise<StaleFundamentalStock[]> {
  return prisma.$queryRawUnsafe<StaleFundamentalStock[]>(
    `SELECT s.id, s.ticker, s.yahoo_symbol AS "yahooSymbol", s.currency
       FROM stocks s
      WHERE s.is_active AND s.country IN ('TW', 'US') AND s.ticker > $2
        AND NOT EXISTS (
          SELECT 1 FROM stock_financial_facts f
           WHERE f.stock_id = s.id AND f.metric = $3 AND f.period_end = CURRENT_DATE
        )
      ORDER BY s.ticker ASC
      LIMIT $1`,
    limit, afterTicker ?? "", SYNCED_MARKER_METRIC,
  );
}

export type SyncOneResult = { ok: boolean; written: number; failureReason?: string };

/** Fetches one stock's Yahoo fundamentals and (if writeEnabled) upserts today's snapshot row per
 * metric that Yahoo actually returned a value for -- missing fields are simply not written (no
 * "無資料" placeholder row, no estimate). */
export async function syncOneStockFundamentals(stock: StaleFundamentalStock, writeEnabled: boolean, stats?: RateStats): Promise<SyncOneResult> {
  const qs = await fetchQuoteSummary(stock.yahooSymbol, MODULES, stats);
  if (!qs) return { ok: false, written: 0, failureReason: stats?.lastFailure ?? "NO_RESULT" };
  const fundamentals = extractYahooFundamentals(qs.result);
  const rows = YAHOO_FUNDAMENTAL_METRICS
    .map((key) => ({ key: key as string, value: fundamentals[key] }))
    .filter((r): r is { key: string; value: number } => r.value !== null && Number.isFinite(r.value));
  if (!writeEnabled) return { ok: true, written: 0 };

  const today = new Date().toISOString().slice(0, 10);
  // _synced一定要寫（即使九個欄位全部是null，例如虧損股沒有PE也沒有ROE）——這是「今天查過
  // Yahoo了」的標記本身，不是某個欄位的值；findStaleFundamentalStocks跟screener的PE備援都靠
  // 這筆標記判斷「Yahoo有沒有被問過」，不是看特定欄位有沒有值。
  const allRows = [...rows, { key: "_synced", value: 1 }];
  // 2026-10-24（這一版第一次正式執行就FAILED，查production_scheduler_runs的error欄位抓到的
  // 根因，使用者核准修正）: updated_at在schema.prisma標@updatedAt，但那只在Prisma Client的
  // 一般create/update呼叫才會自動帶，這裡是$executeRawUnsafe直接寫SQL，繞過了那層自動填值，
  // DB本身updated_at是NOT NULL、沒有DEFAULT，INSERT沒給值就直接違反NOT NULL整個transaction
  // 失敗（attempted=1, failed=1, 0筆真的寫進去）。INSERT跟ON CONFLICT UPDATE都要補上。
  await prisma.$executeRawUnsafe(
    `INSERT INTO stock_financial_facts (id, stock_id, metric, period_end, value, unit, currency, source, source_fact_key, source_document_url, imported_at, updated_at)
     SELECT gen_random_uuid()::text, $1, value->>'metric', $2::date, (value->>'value')::numeric, 'RATIO', $3, 'YAHOO_QUOTE_SUMMARY', value->>'sourceFactKey', $4, now(), now()
       FROM jsonb_array_elements($5::jsonb) value
     ON CONFLICT (stock_id, metric, period_end, source, source_fact_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    stock.id, today, stock.currency, qs.url,
    JSON.stringify(allRows.map((r) => ({ metric: `${METRIC_PREFIX}${r.key}`, value: r.value, sourceFactKey: `${stock.yahooSymbol}:${today}` }))),
  );
  return { ok: true, written: rows.length };
}
