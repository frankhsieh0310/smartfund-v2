// Pure helpers for the yahoo-index history write path (no DB / network access — unit-testable).
//
// Batch upsert: one INSERT ... ON CONFLICT statement per chunk of candles instead of one Prisma upsert
// (= one round trip) per candle. Semantics are identical to the per-candle upsert it replaces:
//   - same conflict target (index_id, interval, timestamp, source) — the table's primary key
//   - create sets the same constant columns the old create block set
//   - conflict updates ONLY open/high/low/close/volume (same as the old `update` block)
//   - ingested_at / source_type / verification_status / license_status keep their DB defaults

export const CANDLE_INSERT_CHUNK = 250; // 4 shared + 6/row params -> 1,504 params max, far below PG's 65,535

export type HistoryCandle = { timestamp: Date; open: number; high: number; low: number; close: number; volume: number | null };
export type CandleWriteContext = { indexId: string; timezone: string; currency: string | null; symbol: string };

// Numbers are sent as their JS string form (shortest round-trip repr) — exactly the digits Prisma's Decimal
// would have sent for the same number — and cast to numeric server-side, so stored values do not change.
const num = (n: number) => String(n);
// timestamp(3) WITHOUT time zone stores the UTC wall clock (what Prisma writes); send it without a zone suffix.
const utcWallClock = (d: Date) => d.toISOString().slice(0, -1);

/** Last candle wins per timestamp — what sequential upserts would end up with; also avoids
 *  "ON CONFLICT DO UPDATE command cannot affect row a second time" inside one statement. */
export function dedupeByTimestamp(candles: HistoryCandle[]): HistoryCandle[] {
  const byTs = new Map<number, HistoryCandle>();
  for (const c of candles) byTs.set(c.timestamp.getTime(), c);
  return [...byTs.values()];
}

export function buildCandleUpsertStatements(ctx: CandleWriteContext, candles: HistoryCandle[], chunkSize = CANDLE_INSERT_CHUNK): Array<{ sql: string; params: unknown[] }> {
  const rows = dedupeByTimestamp(candles);
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const sourceUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ctx.symbol}`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params: unknown[] = [ctx.indexId, ctx.timezone, ctx.currency, sourceUrl];
    const values = chunk.map((c) => {
      const base = params.length; // 4 shared params, then 6 per row
      params.push(utcWallClock(c.timestamp), num(c.open), num(c.high), num(c.low), num(c.close), c.volume != null ? num(c.volume) : null);
      return `($1::text,'1d',$${base + 1}::timestamp,$${base + 2}::numeric,$${base + 3}::numeric,$${base + 4}::numeric,$${base + 5}::numeric,$${base + 6}::numeric,$2::text,'REGULAR','YAHOO_CHART','SOURCE_REPORTED','PASS','SUPPLEMENTAL','UNVERIFIED','SUPPLEMENTAL_UNVERIFIED',$3::text,$4::text)`;
    });
    statements.push({
      sql:
        `INSERT INTO global_index_candles (index_id, "interval", "timestamp", open, high, low, close, volume, timezone, session, source, completeness, quality_status, source_type, verification_status, license_status, currency, source_url) VALUES ${values.join(",")} ` +
        `ON CONFLICT (index_id, "interval", "timestamp", source) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume`,
      params,
    });
  }
  return statements;
}

/** True when there is enough runtime left to safely START another index (Yahoo call is capped at 20s, plus the write). */
export function hasBudgetForIndex(now: number, deadlineAt: number | undefined, minRemainingMs: number): boolean {
  return deadlineAt === undefined || deadlineAt - now >= minRemainingMs;
}
