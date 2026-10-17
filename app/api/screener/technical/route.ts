// 技術選標 — 股票面 (part 1 of 2 — stock screening). Reverse-lookup to "which ETF/fund holds this
// stock" is NOT duplicated here: this endpoint returns matching tickers, and the client feeds them
// into the already-existing /api/mobile/reverse-holdings (same endpoint the plain stock
// reverse-lookup screen already uses) to get the ETF/fund list — one database of holdings logic,
// not two.
//
// Reuses stock_technical as-is (MA5/20/60/120/240, MACD, KD, RSI14, Bollinger, ATR14 — already
// computed for 99.99%+ of TW-listed stocks, confirmed via SELECT this round) rather than
// recomputing indicators.
//
// KNOWN STALENESS CAVEAT (disclosed, not fixed this round): confirmed live this round that
// stock_technical's latest rows are dated ~2026-07-16 for a sample, ~3 months behind "today" —
// the daily indicator-refresh pipeline (scripts/data/technical/run-production-stock-technical.ts)
// does not appear to have run recently. This screener is correct over whatever data exists, but
// that data itself is stale until that pipeline's own cadence is fixed (separate audit item).
//
// 2026-10-17 (item 1): added 商品面 (?scope=commodity) screening. The docs/specs/technical-
// screener-reverse-lookup.md note that "commodity technical screening needs a separate pipeline
// that doesn't exist yet" is now stale -- lib/cron/commodityTechnicalUpdate.ts has been built and
// writes real, near-daily technical indicators (VERIFIED: observed_at within 1-2 days of today)
// into futures_technical_analytics for all 21 CORE_COMMODITY_ROOTS. Universe is tiny (21 rows), so
// this fetches the latest row per root and filters in JS rather than building raw SQL over JSONB.
import { prisma } from "@/lib/prisma";
import { CORE_COMMODITY_ROOTS } from "@/lib/cron/commodityUpdate";
import { COMMODITY_TECHNICAL_SOURCE } from "@/lib/cron/commodityTechnicalUpdate";
import { COMMODITY_ETF_MAPPING } from "@/lib/data-platform/commodityEtfMapping";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

type Condition =
  | { field: "rsi14"; op: "lt" | "gt"; value: number }
  | { field: "macd_histogram"; op: "lt" | "gt"; value: number }
  | { field: "price_vs_ma20"; op: "above" | "below" }
  | { field: "price_vs_ma60"; op: "above" | "below" };

function parseConditions(q: URLSearchParams): Condition[] {
  const conditions: Condition[] = [];
  const rsiBelow = q.get("rsi_below");
  const rsiAbove = q.get("rsi_above");
  if (rsiBelow !== null && Number.isFinite(Number(rsiBelow))) conditions.push({ field: "rsi14", op: "lt", value: Number(rsiBelow) });
  if (rsiAbove !== null && Number.isFinite(Number(rsiAbove))) conditions.push({ field: "rsi14", op: "gt", value: Number(rsiAbove) });
  const macdBelow = q.get("macd_histogram_below");
  const macdAbove = q.get("macd_histogram_above");
  if (macdBelow !== null && Number.isFinite(Number(macdBelow))) conditions.push({ field: "macd_histogram", op: "lt", value: Number(macdBelow) });
  if (macdAbove !== null && Number.isFinite(Number(macdAbove))) conditions.push({ field: "macd_histogram", op: "gt", value: Number(macdAbove) });
  const priceVsMa20 = q.get("price_vs_ma20");
  if (priceVsMa20 === "above" || priceVsMa20 === "below") conditions.push({ field: "price_vs_ma20", op: priceVsMa20 });
  const priceVsMa60 = q.get("price_vs_ma60");
  if (priceVsMa60 === "above" || priceVsMa60 === "below") conditions.push({ field: "price_vs_ma60", op: priceVsMa60 });
  return conditions;
}

function buildWhere(conditions: Condition[]): string {
  const clauses = conditions.map((c) => {
    if (c.field === "rsi14") return `t.rsi14 IS NOT NULL AND t.rsi14 ${c.op === "lt" ? "<" : ">"} ${c.value}`;
    if (c.field === "macd_histogram") return `t.macd_histogram IS NOT NULL AND t.macd_histogram ${c.op === "lt" ? "<" : ">"} ${c.value}`;
    if (c.field === "price_vs_ma20") return `t.ma20 IS NOT NULL AND s.latest_close IS NOT NULL AND s.latest_close ${c.op === "above" ? ">" : "<"} t.ma20`;
    return `t.ma60 IS NOT NULL AND s.latest_close IS NOT NULL AND s.latest_close ${c.op === "above" ? ">" : "<"} t.ma60`;
  });
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

// yahoo_symbol -> the CommodityKey used by /api/screener/commodity-products, only for the
// commodities that genuinely have a TW-listed direct ETF (VERIFIED live SELECT, see
// commodityEtfMapping.ts's own doc comment for the full list of commodities checked and ruled out).
const YAHOO_SYMBOL_TO_COMMODITY_KEY: Record<string, string> = { "GC=F": "GOLD", "SI=F": "SILVER", "CL=F": "WTI_CRUDE", "BZ=F": "BRENT_CRUDE", "HG=F": "COPPER", "ZS=F": "SOYBEANS" };

function matchesConditions(conditions: Condition[], metrics: { rsi14: number | null; macdHistogram: number | null; priceVsSma20: boolean | null }): boolean {
  return conditions.every((c) => {
    if (c.field === "rsi14") return metrics.rsi14 !== null && (c.op === "lt" ? metrics.rsi14 < c.value : metrics.rsi14 > c.value);
    if (c.field === "macd_histogram") return metrics.macdHistogram !== null && (c.op === "lt" ? metrics.macdHistogram < c.value : metrics.macdHistogram > c.value);
    if (c.field === "price_vs_ma20") return metrics.priceVsSma20 !== null && (c.op === "above" ? metrics.priceVsSma20 : !metrics.priceVsSma20);
    return false; // price_vs_ma60 has no commodity equivalent (only sma20/50/200 exist) -- honestly unsupported, not approximated
  });
}

async function screenCommodities(conditions: Condition[], limit: number) {
  const rows = await prisma.$queryRawUnsafe<{ root_id: string; yahoo_symbol: string; observed_at: Date; metrics: unknown; latest_close: string | null }[]>(
    `SELECT DISTINCT ON (t.root_id) t.root_id, t.yahoo_symbol, t.observed_at, t.metrics,
            (SELECT o.close::text FROM futures_root_market_observations o
              WHERE o.root_id = t.root_id ORDER BY o.observed_date DESC LIMIT 1) AS latest_close
       FROM futures_technical_analytics t
      WHERE t.source = $1
      ORDER BY t.root_id, t.observed_at DESC`,
    COMMODITY_TECHNICAL_SOURCE,
  );
  const nameBySymbol = new Map(CORE_COMMODITY_ROOTS.map((r) => [r.yahooSymbol, r.name]));
  const results = rows
    .map((r) => {
      const m = r.metrics as { rsi14?: number; macd?: { histogram?: number }; sma?: { "20"?: number }; computedFromClosesThrough?: string } | null;
      const rsi14 = typeof m?.rsi14 === "number" ? m.rsi14 : null;
      const macdHistogram = typeof m?.macd?.histogram === "number" ? m.macd.histogram : null;
      const sma20 = typeof m?.sma?.["20"] === "number" ? m.sma["20"] : null;
      const latestClose = r.latest_close !== null ? Number(r.latest_close) : null;
      const priceVsSma20 = sma20 !== null && latestClose !== null ? latestClose > sma20 : null;
      return { r, rsi14, macdHistogram, latestClose, priceVsSma20, computedThrough: m?.computedFromClosesThrough ?? null };
    })
    .filter(({ rsi14, macdHistogram, priceVsSma20 }) => matchesConditions(conditions, { rsi14, macdHistogram, priceVsSma20 }))
    .slice(0, limit);
  return results.map(({ r, rsi14, macdHistogram, latestClose, computedThrough }) => ({
    assetType: "COMMODITY" as const,
    yahooSymbol: r.yahoo_symbol,
    name: nameBySymbol.get(r.yahoo_symbol) ?? r.yahoo_symbol,
    asOfDate: computedThrough,
    rsi14,
    macdHistogram,
    latestPrice: latestClose,
    directTwEtfCommodityKey: YAHOO_SYMBOL_TO_COMMODITY_KEY[r.yahoo_symbol] ?? null,
    hasDirectTwEtf: Boolean(YAHOO_SYMBOL_TO_COMMODITY_KEY[r.yahoo_symbol] && COMMODITY_ETF_MAPPING.some((e) => e.commodity === YAHOO_SYMBOL_TO_COMMODITY_KEY[r.yahoo_symbol])),
  }));
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const conditions = parseConditions(q);
  if (conditions.length === 0) {
    return Response.json({ ok: false, error: "NO_CONDITIONS", hint: "rsi_below|rsi_above|macd_histogram_below|macd_histogram_above=<number>, price_vs_ma20|price_vs_ma60=above|below, scope=stock|commodity (commodity scope doesn't support price_vs_ma60)" }, { status: 400, headers });
  }
  const limit = Math.min(50, Math.max(1, Number(q.get("limit")) || 20));
  const scope = q.get("scope") === "commodity" ? "commodity" : "stock";

  if (scope === "commodity") {
    const results = await screenCommodities(conditions, limit);
    return Response.json({ ok: true, scope, conditions, total: results.length, generated_at: new Date().toISOString(), results }, { headers });
  }

  const where = buildWhere(conditions);

  // Lateral-join per stock (bounded to ~2,000 TW stocks via the stock_technical(stock_id,date)
  // index) rather than a naive WHERE over the full 106M-row table, which this round confirmed
  // times out (no index on date alone). VERIFIED runtime ~3.8s against production this round.
  const rows = await prisma.$queryRawUnsafe<
    { ticker: string; company_name: string; date: string; rsi14: string | null; macd_histogram: string | null; ma20: string | null; ma60: string | null; latestPrice: string | null }[]
  >(
    `SELECT s.ticker, s.company_name, t.date::text, t.rsi14::text, t.macd_histogram::text, t.ma20::text, t.ma60::text, s.latest_close::text AS "latestPrice"
       FROM stocks s
       CROSS JOIN LATERAL (
         SELECT * FROM stock_technical st WHERE st.stock_id = s.id ORDER BY st.date DESC LIMIT 1
       ) t
      WHERE s.is_active AND s.exchange IN ('TWSE','TPEx') ${where}
      ORDER BY t.date DESC
      LIMIT ${limit}`,
  );

  return Response.json({
    ok: true,
    conditions,
    total: rows.length,
    generated_at: new Date().toISOString(),
    results: rows.map((r) => ({
      ticker: r.ticker,
      name: r.company_name,
      asOfDate: r.date,
      rsi14: r.rsi14 !== null ? Number(r.rsi14) : null,
      macdHistogram: r.macd_histogram !== null ? Number(r.macd_histogram) : null,
      ma20: r.ma20 !== null ? Number(r.ma20) : null,
      ma60: r.ma60 !== null ? Number(r.ma60) : null,
      latestPrice: r.latestPrice !== null ? Number(r.latestPrice) : null,
    })),
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
