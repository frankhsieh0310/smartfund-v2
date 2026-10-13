// SmartMatch 共識雷達 — historical signal accuracy (Phase 5). No AI. Deterministic + re-computable.
//
// Signal universe: CLASSIFIED consensus_stock_links with stance in ('BULLISH','BEARISH').
// Entry price : first trading day STRICTLY AFTER event_at's calendar date  (conservative, no look-ahead;
//               we never assume we could have traded the same session the statement was made).
// Forward     : first trading day >= (entry_date + 1 / 3 / 6 calendar months). Not yet reached / no
//               data -> NULL (never a fabricated partial number).
// Correctness : BULLISH  ret>0 HIT | ret<0 MISS ; BEARISH ret<0 HIT | ret>0 MISS ; |ret|<FLAT_PCT FLAT.
// Alpha       : stock_return - benchmark_return over the SAME [entry_date, price_date] window.

export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;

export const FLAT_PCT = 0.01; // |return| < 1% -> FLAT (neither HIT nor MISS)
export const MIN_SAMPLE = { "1m": 5, "3m": 5, "6m": 3 } as const;

export type Hit = "HIT" | "MISS" | "FLAT";
export function classifyHit(stance: "BULLISH" | "BEARISH", ret: number | null): Hit | null {
  if (ret == null || !Number.isFinite(ret)) return null;
  if (Math.abs(ret) < FLAT_PCT) return "FLAT";
  const up = ret > 0;
  if (stance === "BULLISH") return up ? "HIT" : "MISS";
  return up ? "MISS" : "HIT";
}

export function addMonthsISO(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0); // clamp end-of-month overflow
  return d.toISOString().slice(0, 10);
}

const CLOSE = "coalesce(adjusted_close, close)";

async function stockCloseStrictlyAfter(query: QueryFn, stockId: string, dateStr: string) {
  const r = await query<{ d: string; c: string }>(
    `select date::text d, ${CLOSE}::float8 c from stock_history
      where stock_id = $1 and date > $2::date and ${CLOSE} is not null
      order by date asc limit 1`,
    [stockId, dateStr],
  );
  return r[0] ? { date: r[0].d, close: Number(r[0].c) } : null;
}
async function stockCloseOnOrAfter(query: QueryFn, stockId: string, dateStr: string) {
  const r = await query<{ d: string; c: string }>(
    `select date::text d, ${CLOSE}::float8 c from stock_history
      where stock_id = $1 and date >= $2::date and ${CLOSE} is not null
      order by date asc limit 1`,
    [stockId, dateStr],
  );
  return r[0] ? { date: r[0].d, close: Number(r[0].c) } : null;
}
async function indexCloseOnOrAfter(query: QueryFn, codes: string[], dateStr: string) {
  const r = await query<{ c: string }>(
    `select ${CLOSE}::float8 c
       from index_history h join market_indexes mi on mi.id = h.index_id
      where mi.code = any($1) and h.date >= $2::date and ${CLOSE} is not null
      order by (mi.code <> $3), h.date asc limit 1`,
    [codes, dateStr, codes[0]],
  );
  return r[0] ? Number(r[0].c) : null;
}

export type BenchmarkResolved = { primary: string; fallback: string | null; label: string | null } | null;
export async function resolveBenchmark(query: QueryFn, exchange: string | null, country: string | null): Promise<BenchmarkResolved> {
  const keys = [exchange, country].filter(Boolean) as string[];
  if (keys.length === 0) return null;
  const r = await query<{ benchmark_code: string; fallback_code: string | null; label: string | null }>(
    `select benchmark_code, fallback_code, label from consensus_benchmark_map where key = any($1)
      order by array_position($1, key) limit 1`,
    [keys],
  );
  return r[0] ? { primary: r[0].benchmark_code, fallback: r[0].fallback_code, label: r[0].label } : null;
}

export type HorizonResult = {
  price_date: string | null; price: number | null;
  stock_return: number | null; benchmark_return: number | null; alpha: number | null;
  hit: Hit | null;
};

export type SignalPerf = {
  entry_trade_date: string | null;
  entry_price: number | null;
  benchmark_symbol: string | null;
  h1m: HorizonResult; h3m: HorizonResult; h6m: HorizonResult;
};

const EMPTY: HorizonResult = { price_date: null, price: null, stock_return: null, benchmark_return: null, alpha: null, hit: null };

export async function computeSignalPerformance(
  query: QueryFn,
  input: {
    stockId: string | null;
    exchange: string | null;
    country: string | null;
    stance: "BULLISH" | "BEARISH";
    eventAtIso: string;
  },
): Promise<SignalPerf> {
  const base: SignalPerf = { entry_trade_date: null, entry_price: null, benchmark_symbol: null, h1m: EMPTY, h3m: EMPTY, h6m: EMPTY };
  if (!input.stockId) return base;

  const eventDate = input.eventAtIso.slice(0, 10);
  const entry = await stockCloseStrictlyAfter(query, input.stockId, eventDate);
  if (!entry) return base; // no post-event price yet -> nothing is mature
  base.entry_trade_date = entry.date;
  base.entry_price = entry.close;

  const bench = await resolveBenchmark(query, input.exchange, input.country);
  const benchCodes = bench ? [bench.primary, ...(bench.fallback ? [bench.fallback] : [])] : [];
  base.benchmark_symbol = bench?.primary ?? null;
  const benchEntry = benchCodes.length ? await indexCloseOnOrAfter(query, benchCodes, entry.date) : null;

  const todayIso = new Date().toISOString().slice(0, 10);
  for (const [months, key] of [[1, "h1m"], [3, "h3m"], [6, "h6m"]] as const) {
    const target = addMonthsISO(entry.date, months);
    if (target > todayIso) continue; // horizon not reached -> leave EMPTY (NULL)
    const fwd = await stockCloseOnOrAfter(query, input.stockId, target);
    if (!fwd) continue; // no price at/after the horizon yet
    const ret = fwd.close / entry.close - 1;
    let benchRet: number | null = null;
    if (benchCodes.length && benchEntry) {
      const benchFwd = await indexCloseOnOrAfter(query, benchCodes, fwd.date);
      if (benchFwd) benchRet = benchFwd / benchEntry - 1;
    }
    base[key] = {
      price_date: fwd.date, price: fwd.close,
      stock_return: ret, benchmark_return: benchRet,
      alpha: benchRet == null ? null : ret - benchRet,
      hit: classifyHit(input.stance, ret),
    };
  }
  return base;
}
