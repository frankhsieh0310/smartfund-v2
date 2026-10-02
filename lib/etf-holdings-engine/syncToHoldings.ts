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
  opts: { snapshotId?: string; dryRun?: boolean } = {},
): Promise<SyncResult> {
  const etfRows = await query(
    `SELECT id FROM etfs WHERE code = $1 AND currency = 'TWD' AND exchange IN ('TWSE','TPEx','TPEX') LIMIT 1`,
    [etfCode],
  );
  if (!etfRows.length) return { status: "SKIPPED_NO_ETF_MAPPING", etfCode };
  const etfId = etfRows[0].id as string;

  const snapshotRows = opts.snapshotId
    ? await query(`SELECT id, data_date::text AS data_date FROM etf_official_daily_snapshots WHERE id = $1`, [opts.snapshotId])
    : await query(
        `SELECT id, data_date::text AS data_date FROM etf_official_daily_snapshots WHERE etf_code = $1 ORDER BY data_date DESC LIMIT 1`,
        [etfCode],
      );
  if (!snapshotRows.length) return { status: "SKIPPED_NO_SNAPSHOT", etfCode };
  const { id: snapshotId, data_date: dataDate } = snapshotRows[0] as { id: string; data_date: string };

  const positions = await query(
    `SELECT security_code, security_name, position_type, position_amount, position_unit, weight, rank
       FROM etf_official_daily_positions WHERE snapshot_id = $1`,
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

  await query("BEGIN", []);
  try {
    for (const r of rows) {
      await query(
        `INSERT INTO holdings
           (id, asset_type, etf_id, as_of_date, rank, holding_name, holding_code, weight, security_id, ticker, shares, source, source_record_id, weight_method, country, created_at)
         VALUES (gen_random_uuid(), 'ETF', $1, $2::date, $3, $4, $5, $6, $7, $8, $9, 'ETF_OFFICIAL_DAILY_SNAPSHOT', $10, 'ISSUER_REPORTED', 'TW', now())`,
        [etfId, dataDate, r.rank, r.holdingName, r.holdingCode, r.weight, r.securityId, r.ticker, r.shares, `${etfCode}:${dataDate}:${r.holdingCode}`],
      );
    }
    await query("COMMIT", []);
  } catch (error) {
    await query("ROLLBACK", []);
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
