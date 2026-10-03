// Syncs the latest OFFICIAL daily snapshot (etf_official_daily_snapshots /
// etf_official_daily_positions) into the generic `holdings` table that the app's
// /api/mobile/current-holdings?type=ETF actually reads. This is the only bridge between the two —
// without it, a successful 331-portfolio run never reaches the app.
//
// Scope is structurally limited to the 331 TW-listed ETFs this engine covers: the etf lookup below
// filters to currency='TWD' AND exchange IN ('TWSE','TPEx','TPEX'), the same filter every other TW-ETF
// read path in this codebase uses, and this function is only ever called with an etf_code that came
// out of etf_official_daily_snapshots (always a TW issuer code). It never touches fund_id rows (funds)
// or etf rows outside that filter (global ETFs), because it only ever writes rows keyed by a resolved
// etfId from that filtered query.
//
// Never deletes anything: a new as_of_date's rows are inserted alongside old ones. The app's "latest
// per product" query (current-holdings.ts) picks the newest as_of_date automatically, so the old date's
// rows age out of view on their own — original holdings are never cleared, including when this
// function is skipped (empty positions, no etf mapping, or already synced for that date).
//
// No value is invented: position_amount is copied into `shares` only when position_unit === 'SHARES'
// (equity, the only unit Holding.shares can represent without unit coercion); weight is copied as-is.
// Bonds/futures/cash positions (PAR_VALUE / CONTRACTS / CASH) are still inserted (name, weight, official
// amount+unit preserved only in the source system — Holding has no unit column, so those rows carry
// shares=null rather than a silently-wrong number) but never given a guessed `shares` figure.

export type QueryFn = (sql: string, params: unknown[]) => Promise<any[]>;

export type SyncResult =
  | { status: "SKIPPED_NO_ETF_MAPPING"; etfCode: string }
  | { status: "SKIPPED_NO_SNAPSHOT"; etfCode: string }
  | { status: "SKIPPED_EMPTY_POSITIONS"; etfCode: string; dataDate: string }
  | { status: "SKIPPED_ALREADY_SYNCED"; etfCode: string; dataDate: string; etfId: string }
  | {
      status: "SYNCED" | "DRY_RUN";
      etfCode: string;
      etfId: string;
      dataDate: string;
      positionsCount: number;
      mappedSecurityCount: number;
      insertedCount: number;
      rows: Array<{
        holdingName: string;
        holdingCode: string;
        ticker: string | null;
        securityId: string | null;
        weight: number;
        shares: number | null;
        positionUnit: string;
        rank: number | null;
      }>;
    };

/**
 * Syncs one ETF's latest official snapshot into `holdings`. Pass `snapshotId` right after a
 * successful upsertSnapshot() to sync exactly what was just written (the normal cron path); omit it
 * to sync whatever is currently latest for that etf_code (used for verification against existing data).
 * `dryRun: true` runs every lookup/mapping step and ROLLBACKs instead of COMMITting — read-only against
 * the real tables, nothing persisted.
 */
export async function syncOfficialSnapshotToHoldings(
  query: QueryFn,
  etfCode: string,
  opts: { snapshotId?: string; dryRun?: boolean; manageOwnTransaction?: boolean } = {},
): Promise<SyncResult> {
  const etfRows = await query(
    `SELECT id FROM etfs WHERE code = $1 AND currency = 'TWD' AND exchange IN ('TWSE','TPEx','TPEX') LIMIT 1`,
    [etfCode],
  );
  if (!etfRows.length) return { status: "SKIPPED_NO_ETF_MAPPING", etfCode };
  const etfId = etfRows[0].id as string;

  const snapshotRows = opts.snapshotId
    ? await query(`SELECT id, data_date::text AS data_date FROM etf_official_daily_snapshots WHERE id = $1::uuid`, [opts.snapshotId])
    : await query(
        `SELECT id, data_date::text AS data_date FROM etf_official_daily_snapshots WHERE etf_code = $1 ORDER BY data_date DESC LIMIT 1`,
        [etfCode],
      );
  if (!snapshotRows.length) return { status: "SKIPPED_NO_SNAPSHOT", etfCode };
  const { id: snapshotId, data_date: dataDate } = snapshotRows[0] as { id: string; data_date: string };

  const positions = await query(
    `SELECT security_code, security_name, position_type, position_amount, position_unit, weight, rank
       FROM etf_official_daily_positions WHERE snapshot_id = $1::uuid`,
    [snapshotId],
  );
  if (!positions.length) return { status: "SKIPPED_EMPTY_POSITIONS", etfCode, dataDate };

  const alreadySynced = await query(
    `SELECT 1 FROM holdings WHERE etf_id = $1 AND as_of_date = $2::date AND source = 'ETF_OFFICIAL_DAILY_SNAPSHOT' LIMIT 1`,
    [etfId, dataDate],
  );
  if (alreadySynced.length) return { status: "SKIPPED_ALREADY_SYNCED", etfCode, dataDate, etfId };

  // Canonical product/security mapping already used by every other TW-ETF read/write path in this
  // codebase (see lib/etf-holdings.js mapOfficialRows() in tw-data-updater, and current-holdings.ts).
  const codes = [...new Set(positions.map((p: any) => String(p.security_code)))];
  const securities = codes.length
    ? await query(`SELECT id, ticker FROM securities WHERE ticker = ANY($1::text[])`, [codes])
    : [];
  const byTicker = new Map(securities.map((s: any) => [String(s.ticker), s.id as string]));

  const rows = positions.map((p: any) => {
    const ticker = String(p.security_code);
    const securityId = byTicker.get(ticker) ?? null;
    const shares = p.position_unit === "SHARES" ? Number(p.position_amount) : null;
    return {
      holdingName: String(p.security_name),
      holdingCode: ticker,
      ticker: securityId ? ticker : null,
      securityId,
      weight: Number(p.weight),
      shares,
      positionUnit: String(p.position_unit),
      rank: p.rank == null ? null : Number(p.rank),
    };
  });

  if (opts.dryRun) {
    return {
      status: "DRY_RUN",
      etfCode,
      etfId,
      dataDate,
      positionsCount: positions.length,
      mappedSecurityCount: rows.filter((r) => r.securityId).length,
      insertedCount: rows.length,
      rows,
    };
  }

  // Default (every pre-existing caller): this function owns its own BEGIN/COMMIT/ROLLBACK, exactly as
  // before. opts.manageOwnTransaction === false means the caller is ALREADY running `query` inside its
  // own transaction (e.g. a bounded prisma.$transaction) — issuing a nested BEGIN/COMMIT here would
  // either no-op with a Postgres warning or, worse, prematurely end the caller's transaction, so those
  // statements are skipped and the caller owns atomicity + rollback-on-throw instead.
  const manageOwnTransaction = opts.manageOwnTransaction ?? true;
  if (manageOwnTransaction) await query("BEGIN", []);
  try {
    // Bulk, set-based write — same jsonb_to_recordset pattern storage.ts's upsertSnapshot already uses
    // for etf_official_daily_positions. Was previously one sequential `await query(INSERT...)` per row
    // (confirmed via live measurement: ~117-120ms/row, so a 504-position ETF alone took ~59s of pure
    // round trips) — now O(ceil(rows.length/200)) statements regardless of row count. No ON CONFLICT
    // clause: the `holdings` table has no unique constraint on (etf_id, as_of_date, holding_code) or on
    // source_record_id (only plain indexes), so a plain bulk INSERT reproduces the exact same semantics
    // the old per-row INSERT had — this function's own `alreadySynced` check above is what has always
    // prevented duplicate inserts for the same (etf_id, as_of_date), unchanged by this rewrite.
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      await query(
        `INSERT INTO holdings
           (id, asset_type, etf_id, as_of_date, rank, holding_name, holding_code, weight, security_id, ticker, shares, source, source_record_id, weight_method, country, created_at)
         SELECT gen_random_uuid(), 'ETF', $1::uuid, $2::date, x.rank, x.holding_name, x.holding_code, x.weight, x.security_id, x.ticker, x.shares, 'ETF_OFFICIAL_DAILY_SNAPSHOT', x.source_record_id, 'ISSUER_REPORTED', 'TW', now()
           FROM jsonb_to_recordset($3::jsonb) AS x(
             rank int, holding_name text, holding_code text, weight numeric, security_id uuid, ticker text, shares numeric, source_record_id text)`,
        [
          etfId,
          dataDate,
          JSON.stringify(chunk.map((r) => ({
            rank: r.rank, holding_name: r.holdingName, holding_code: r.holdingCode, weight: r.weight,
            security_id: r.securityId, ticker: r.ticker, shares: r.shares,
            source_record_id: `${etfCode}:${dataDate}:${r.holdingCode}`,
          }))),
        ],
      );
    }
    if (manageOwnTransaction) await query("COMMIT", []);
  } catch (error) {
    if (manageOwnTransaction) await query("ROLLBACK", []);
    throw error;
  }

  return {
    status: "SYNCED",
    etfCode,
    etfId,
    dataDate,
    positionsCount: positions.length,
    mappedSecurityCount: rows.filter((r) => r.securityId).length,
    insertedCount: rows.length,
    rows,
  };
}
