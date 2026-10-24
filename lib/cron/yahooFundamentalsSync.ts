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

/** Stocks whose yahoo_fundamentals facts are missing or not from today, oldest/never-synced
 * first (ticker order gives a stable, resumable cursor across runs within the same day). */
export async function findStaleFundamentalStocks(limit: number, afterTicker: string | null): Promise<StaleFundamentalStock[]> {
  return prisma.$queryRawUnsafe<StaleFundamentalStock[]>(
    `SELECT s.id, s.ticker, s.yahoo_symbol AS "yahooSymbol", s.currency
       FROM stocks s
      WHERE s.is_active AND s.ticker > $2
        AND NOT EXISTS (
          SELECT 1 FROM stock_financial_facts f
           WHERE f.stock_id = s.id AND f.metric = $3 AND f.period_end = CURRENT_DATE
        )
      ORDER BY s.ticker ASC
      LIMIT $1`,
    limit, afterTicker ?? "", `${METRIC_PREFIX}pe`,
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
  if (!writeEnabled || rows.length === 0) return { ok: true, written: 0 };

  const today = new Date().toISOString().slice(0, 10);
  await prisma.$executeRawUnsafe(
    `INSERT INTO stock_financial_facts (id, stock_id, metric, period_end, value, unit, currency, source, source_fact_key, source_document_url)
     SELECT gen_random_uuid()::text, $1, value->>'metric', $2::date, (value->>'value')::numeric, 'RATIO', $3, 'YAHOO_QUOTE_SUMMARY', value->>'sourceFactKey', $4
       FROM jsonb_array_elements($5::jsonb) value
     ON CONFLICT (stock_id, metric, period_end, source, source_fact_key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    stock.id, today, stock.currency, qs.url,
    JSON.stringify(rows.map((r) => ({ metric: `${METRIC_PREFIX}${r.key}`, value: r.value, sourceFactKey: `${stock.yahooSymbol}:${today}` }))),
  );
  return { ok: true, written: rows.length };
}
