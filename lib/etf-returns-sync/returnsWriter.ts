// Task X5 Part B: the ONLY place in this feature that writes to etf_performances — never called
// unless writeGate.isWriteEnabled() is true.
//
// Column ownership (user-approved, Task X5): this pipeline owns return_1m/3m/ytd/1y/3y/5y only, and
// writes them as a DIRECT OVERWRITE — including NULL — never COALESCE. COALESCE only protects
// against NULL overwriting a real value; it cannot protect against a literal 0 (Yahoo's own
// "no data" placeholder, see parseReturns.ts) silently sticking forever once written, which is
// exactly the bug this change fixes. Yahoo's own value (even when that value is "no data", i.e.
// null) is always the final word for these six columns now.
//
// return_1d and return_6m are deliberately NEVER included in this INSERT/UPDATE at all — Yahoo's
// trailingReturns has no 1-day or 6-month figure, and those two columns are now owned exclusively by
// app/api/cron/cloud-etf-price/route.ts (self-computed from price history). Touching them here,
// even to write NULL, would erase that pipeline's own values. return_1d is still parsed into
// TrailingReturns.r1d for type/test continuity but is never part of the write payload.
// price/nav/volatility/sharpe/beta/alpha/max_drawdown/dividend_yield/aum are untouched, as before —
// this feature has never written them and still doesn't.

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

/** One batched UPSERT per call. Task X5 Part B: return_1m/3m/ytd/1y/3y/5y are a DIRECT OVERWRITE
 * (no COALESCE) — Yahoo's own value, including null, always wins for these six columns. return_1d
 * and return_6m are never referenced at all (owned by cloud-etf-price). Error isolation unchanged
 * from Task X B.3: the whole batch INSERT is wrapped in one try/catch; if Postgres rejects it for any
 * reason this function didn't already sanitize away, every etfId in the batch is reported as
 * writeErrorCount and simply retried on a later invocation (no row for today's date -> the DB-truth
 * completion check in route.ts picks it back up), never thrown up to abort the whole invocation. */
export async function writeReturnsBatch(query: QueryFn, candidates: WriteCandidate[], nowIso: string): Promise<WriteBatchResult> {
  if (candidates.length === 0) return { written: 0, droppedFieldCount: 0, writeErrorCount: 0, writeErrorEtfIds: [] };

  let droppedFieldCount = 0;
  const payload = candidates.map((c) => {
    const { sanitized, droppedFields } = sanitizeReturns(c.returns);
    droppedFieldCount += droppedFields.length;
    return {
      etf_id: c.etfId, date: c.date,
      return_1m: sanitized.r1m, return_3m: sanitized.r3m,
      return_ytd: sanitized.rytd, return_1y: sanitized.r1y, return_3y: sanitized.r3y, return_5y: sanitized.r5y,
    };
  });

  try {
    const upserted = await query(
      `INSERT INTO etf_performances (id, etf_id, date, return_1m, return_3m, return_ytd, return_1y, return_3y, return_5y, created_at)
       SELECT gen_random_uuid()::text, x.etf_id, x.date::date, x.return_1m, x.return_3m, x.return_ytd, x.return_1y, x.return_3y, x.return_5y, $2::timestamptz
         FROM jsonb_to_recordset($1::jsonb) AS x(
           etf_id text, date text, return_1m numeric, return_3m numeric,
           return_ytd numeric, return_1y numeric, return_3y numeric, return_5y numeric
         )
       ON CONFLICT (etf_id, date) DO UPDATE SET
         return_1m = EXCLUDED.return_1m,
         return_3m = EXCLUDED.return_3m,
         return_ytd = EXCLUDED.return_ytd,
         return_1y = EXCLUDED.return_1y,
         return_3y = EXCLUDED.return_3y,
         return_5y = EXCLUDED.return_5y
       RETURNING 1`,
      [JSON.stringify(payload), nowIso],
    );
    // This INSERT ... ON CONFLICT DO UPDATE has no WHERE guard, so every row in the batch always
    // affects exactly one row -- upserted.length should equal candidates.length here, but reporting
    // the real count (not the batch size) keeps this writer consistent with the others and honest
    // if that ever stops being true (e.g. a future guard clause is added).
    return { written: upserted.length, droppedFieldCount, writeErrorCount: 0, writeErrorEtfIds: [] };
  } catch {
    return { written: 0, droppedFieldCount, writeErrorCount: candidates.length, writeErrorEtfIds: candidates.map((c) => c.etfId) };
  }
}

/** Entry point route.ts calls per batch. Mirrors market-close-sync's writeBatchIfEnabled shape. */
export async function writeBatchIfEnabled(query: QueryFn, candidates: WriteCandidate[], nowIso: string, writeEnabled: boolean): Promise<WriteBatchResult> {
  if (!writeEnabled) return { written: 0, droppedFieldCount: 0, writeErrorCount: 0, writeErrorEtfIds: [] };
  return writeReturnsBatch(query, candidates, nowIso);
}
