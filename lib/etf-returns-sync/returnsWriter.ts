// Task X: the ONLY place in this feature that writes to etf_performances — never called unless
// writeGate.isWriteEnabled() is true. Mirrors the existing lib/yahoo/etfEnrich.ts upsert exactly
// (same table, same ON CONFLICT (etf_id, date) DO UPDATE ... COALESCE pattern, so this feature never
// clobbers a non-null value the Yahoo ETF enrichment pipeline already wrote for other columns like
// nav/price/volatility/sharpe/aum that this feature never touches) — deliberately NOT a new pipeline
// design, just the existing, already-proven-safe upsert shape, scoped to the return_* columns only.

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

// All etf_performances.return_* columns are NUMERIC(8,4) — VERIFIED live this session. Max
// representable absolute value is 9999.9999 (percent units, e.g. "15.63" for +15.63%). This is the
// exact class of value that crashed market-close-sync's OLD self-computed-return write path
// ("numeric field overflow") — Yahoo's own percentages are normally far inside this range, but a
// stale/delisted instrument with a corrupted trailingReturns payload is not impossible, so every
// field is range-checked before being included in a write; an out-of-range field is simply dropped
// (written as null) rather than failing the whole row.
const MAX_ABS_RETURN = 9999.9999;

export function inRange(value: number | null): boolean {
  return value !== null && Number.isFinite(value) && Math.abs(value) <= MAX_ABS_RETURN;
}

export type TrailingReturns = {
  r1d: number | null; r1m: number | null; r3m: number | null; r6m: number | null;
  rytd: number | null; r1y: number | null; r3y: number | null; r5y: number | null;
};

/** Drops any field outside NUMERIC(8,4) range (logged by the caller, not here — this function is
 * pure) rather than letting one bad field fail the whole row's write. */
export function sanitizeReturns(r: TrailingReturns): { sanitized: TrailingReturns; droppedFields: string[] } {
  const droppedFields: string[] = [];
  const check = (key: keyof TrailingReturns, value: number | null): number | null => {
    if (value === null) return null;
    if (!inRange(value)) { droppedFields.push(key); return null; }
    return value;
  };
  const sanitized: TrailingReturns = {
    r1d: check("r1d", r.r1d), r1m: check("r1m", r.r1m), r3m: check("r3m", r.r3m), r6m: check("r6m", r.r6m),
    rytd: check("rytd", r.rytd), r1y: check("r1y", r.r1y), r3y: check("r3y", r.r3y), r5y: check("r5y", r.r5y),
  };
  return { sanitized, droppedFields };
}

export type WriteCandidate = { etfId: string; date: string; returns: TrailingReturns };

export type WriteBatchResult = {
  written: number;
  droppedFieldCount: number; // total out-of-range fields dropped across the batch (rows still written, just missing that one field)
  writeErrorCount: number; // ETFs whose write threw and were skipped entirely — retried next run via the DB-truth completion check
  writeErrorEtfIds: string[];
};

/** One batched UPSERT per call, same ON CONFLICT (etf_id, date) DO UPDATE ... COALESCE shape as the
 * existing Yahoo ETF enrichment pipeline's writeEtfEnrichData — never introduces a second, divergent
 * way of writing this table. Task X item B.3: error isolation — the whole batch INSERT is wrapped in
 * one try/catch; if Postgres rejects it for any reason this function didn't already sanitize away,
 * every etfId in the batch is reported as writeErrorCount and simply retried on a later invocation
 * (no row for today's date -> the DB-truth completion check in route.ts picks it back up), never
 * thrown up to abort the whole invocation. */
export async function writeReturnsBatch(query: QueryFn, candidates: WriteCandidate[], nowIso: string): Promise<WriteBatchResult> {
  if (candidates.length === 0) return { written: 0, droppedFieldCount: 0, writeErrorCount: 0, writeErrorEtfIds: [] };

  let droppedFieldCount = 0;
  const payload = candidates.map((c) => {
    const { sanitized, droppedFields } = sanitizeReturns(c.returns);
    droppedFieldCount += droppedFields.length;
    return {
      etf_id: c.etfId, date: c.date,
      return_1d: sanitized.r1d, return_1m: sanitized.r1m, return_3m: sanitized.r3m, return_6m: sanitized.r6m,
      return_ytd: sanitized.rytd, return_1y: sanitized.r1y, return_3y: sanitized.r3y, return_5y: sanitized.r5y,
    };
  });

  try {
    await query(
      `INSERT INTO etf_performances (id, etf_id, date, return_1d, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y, created_at)
       SELECT gen_random_uuid()::text, x.etf_id, x.date::date, x.return_1d, x.return_1m, x.return_3m, x.return_6m, x.return_ytd, x.return_1y, x.return_3y, x.return_5y, $2::timestamptz
         FROM jsonb_to_recordset($1::jsonb) AS x(
           etf_id text, date text, return_1d numeric, return_1m numeric, return_3m numeric, return_6m numeric,
           return_ytd numeric, return_1y numeric, return_3y numeric, return_5y numeric
         )
       ON CONFLICT (etf_id, date) DO UPDATE SET
         return_1d = COALESCE(EXCLUDED.return_1d, etf_performances.return_1d),
         return_1m = COALESCE(EXCLUDED.return_1m, etf_performances.return_1m),
         return_3m = COALESCE(EXCLUDED.return_3m, etf_performances.return_3m),
         return_6m = COALESCE(EXCLUDED.return_6m, etf_performances.return_6m),
         return_ytd = COALESCE(EXCLUDED.return_ytd, etf_performances.return_ytd),
         return_1y = COALESCE(EXCLUDED.return_1y, etf_performances.return_1y),
         return_3y = COALESCE(EXCLUDED.return_3y, etf_performances.return_3y),
         return_5y = COALESCE(EXCLUDED.return_5y, etf_performances.return_5y)
       RETURNING 1`,
      [JSON.stringify(payload), nowIso],
    );
    return { written: candidates.length, droppedFieldCount, writeErrorCount: 0, writeErrorEtfIds: [] };
  } catch {
    return { written: 0, droppedFieldCount, writeErrorCount: candidates.length, writeErrorEtfIds: candidates.map((c) => c.etfId) };
  }
}

/** Entry point route.ts calls per batch. Mirrors market-close-sync's writeBatchIfEnabled shape. */
export async function writeBatchIfEnabled(query: QueryFn, candidates: WriteCandidate[], nowIso: string, writeEnabled: boolean): Promise<WriteBatchResult> {
  if (!writeEnabled) return { written: 0, droppedFieldCount: 0, writeErrorCount: 0, writeErrorEtfIds: [] };
  return writeReturnsBatch(query, candidates, nowIso);
}
