// 技術選標 (part 1 of 2 — stock screening). Reverse-lookup to "which ETF/fund holds this stock" is
// NOT duplicated here: this endpoint returns matching tickers, and the client feeds them into the
// already-existing /api/mobile/reverse-holdings (same endpoint the plain stock reverse-lookup
// screen already uses) to get the ETF/fund list — one database of holdings logic, not two.
//
// Reuses stock_technical as-is (MA5/20/60/120/240, MACD, KD, RSI14, Bollinger, ATR14 — already
// computed for 99.99%+ of TW-listed stocks, confirmed via SELECT this round) rather than
// recomputing indicators. Scoped to TW stocks only this round — commodity technical screening
// needs a separate price-history-to-indicator pipeline that doesn't exist yet (see
// docs/specs/technical-screener-reverse-lookup.md), not built here.
//
// KNOWN STALENESS CAVEAT (disclosed, not fixed this round): confirmed live this round that
// stock_technical's latest rows are dated ~2026-07-16 for a sample, ~3 months behind "today" —
// the daily indicator-refresh pipeline (scripts/data/technical/run-production-stock-technical.ts)
// does not appear to have run recently. This screener is correct over whatever data exists, but
// that data itself is stale until that pipeline's own cadence is fixed (separate audit item).
import { prisma } from "@/lib/prisma";

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

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const conditions = parseConditions(q);
  if (conditions.length === 0) {
    return Response.json({ ok: false, error: "NO_CONDITIONS", hint: "rsi_below|rsi_above|macd_histogram_below|macd_histogram_above=<number>, price_vs_ma20|price_vs_ma60=above|below" }, { status: 400, headers });
  }
  const limit = Math.min(50, Math.max(1, Number(q.get("limit")) || 20));
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
