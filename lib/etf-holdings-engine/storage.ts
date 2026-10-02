// Shared storage for canonical Taiwan ETF daily holdings snapshots — one schema, every issuer, every
// asset type (active or passive). (etf_code, data_date) is the identity: a same-day rerun upserts in
// place (no duplicate snapshot), a new trading day always inserts a new row (history is never overwritten).
import type { CanonicalSnapshot } from "./types.ts";

export const DATA_DISCLAIMER =
  "新增／刪除／加碼／減碼依官方每日公開持股數量變化判定；持股異動為每日公開投資組合快照比較，不等同基金實際成交紀錄。被動式ETF之投資組合變化反映追蹤指數成分調整或申贖，非經理人主動操作決策。";

export type QueryFn = (sql: string, params: unknown[]) => Promise<any[]>;

export async function upsertSnapshot(query: QueryFn, snapshot: CanonicalSnapshot): Promise<{ snapshotId: string; wasNew: boolean }> {
  const existing = await query(
    `SELECT id FROM etf_official_daily_snapshots WHERE etf_code = $1 AND data_date = $2::date`,
    [snapshot.etfCode, snapshot.dataDate],
  );
  const wasNew = existing.length === 0;

  const rows = await query(
    `INSERT INTO etf_official_daily_snapshots
       (etf_code, issuer, asset_type, data_date, announcement_date, fund_nav, outstanding_units, source, retrieved_at)
     VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9)
     ON CONFLICT (etf_code, data_date) DO UPDATE SET
       issuer = EXCLUDED.issuer, asset_type = EXCLUDED.asset_type, announcement_date = EXCLUDED.announcement_date,
       fund_nav = EXCLUDED.fund_nav, outstanding_units = EXCLUDED.outstanding_units,
       source = EXCLUDED.source, retrieved_at = EXCLUDED.retrieved_at
     RETURNING id`,
    [snapshot.etfCode, snapshot.issuer, snapshot.assetType, snapshot.dataDate, snapshot.announcementDate, snapshot.fundNav, snapshot.outstandingUnits, snapshot.source, snapshot.retrievedAt],
  );
  const snapshotId = rows[0].id as string;

  // rank computed here (by weight desc) since it's a property of the whole snapshot, not a single position
  const ranked = [...snapshot.positions].sort((a, b) => b.weight - a.weight);
  const rankByCode = new Map(ranked.map((p, i) => [p.securityCode, i + 1]));

  for (let i = 0; i < snapshot.positions.length; i += 200) {
    const chunk = snapshot.positions.slice(i, i + 200);
    await query(
      `INSERT INTO etf_official_daily_positions
         (snapshot_id, security_code, security_name, position_type, position_amount, position_unit, weight, rank, canonical_security_id, source)
       SELECT $1, x.code, x.name, x.position_type, x.position_amount, x.position_unit, x.weight, x.rank, x.canonical_security_id, $2
         FROM jsonb_to_recordset($3::jsonb) AS x(
           code text, name text, position_type text, position_amount numeric, position_unit text,
           weight numeric, rank int, canonical_security_id text)
       ON CONFLICT (snapshot_id, security_code) DO UPDATE SET
         security_name = EXCLUDED.security_name, position_type = EXCLUDED.position_type,
         position_amount = EXCLUDED.position_amount, position_unit = EXCLUDED.position_unit,
         weight = EXCLUDED.weight, rank = EXCLUDED.rank, canonical_security_id = EXCLUDED.canonical_security_id`,
      [
        snapshotId,
        snapshot.source,
        JSON.stringify(chunk.map((p) => ({
          code: p.securityCode, name: p.securityName, position_type: p.positionType,
          position_amount: p.positionAmount, position_unit: p.positionUnit, weight: p.weight,
          rank: rankByCode.get(p.securityCode) ?? null,
          canonical_security_id: p.canonicalSecurityId,
        }))),
      ],
    );
  }

  return { snapshotId, wasNew };
}

export type FrontendAction = "ADDED" | "REMOVED" | "INCREASED" | "DECREASED" | "UNCHANGED";
export type FrontendHoldingChange = {
  code: string;
  name: string;
  positionType: string;
  positionUnit: string;
  action: FrontendAction;
  /** Equity-only convenience field: changeAmount / 1000 ("張"). Null for non-SHARES positions — bonds
   * keep their official par-value unit, never coerced into 張. */
  changeLots: number | null;
  changeAmount: number;
  previousAmount: number | null;
  currentAmount: number | null;
  previousWeight: number | null;
  currentWeight: number | null;
};

/** Loads the two most recent stored snapshots for an ETF and builds the front-end-ready diff model.
 * "張" (lots, amount/1000) is surfaced only for SHARES positions; PAR_VALUE and CONTRACTS positions
 * keep their official unit as-is. Weight is shown as an absolute value-to-value change, never "pp". */
export async function loadFrontendDiff(query: QueryFn, etfCode: string): Promise<{
  etfCode: string; etfName: string | null; dateFrom: string; dateTo: string;
  addedCount: number; removedCount: number; increasedCount: number; decreasedCount: number; unchangedCount: number;
  changes: FrontendHoldingChange[];
  fundNavFrom: number; fundNavTo: number; outstandingUnitsFrom: number; outstandingUnitsTo: number; outstandingUnitsChangePct: number;
  disclaimer: string;
}> {
  const snaps = await query(
    `SELECT id, data_date::text AS data_date, fund_nav, outstanding_units
       FROM etf_official_daily_snapshots WHERE etf_code = $1 ORDER BY data_date DESC LIMIT 2`,
    [etfCode],
  );
  if (snaps.length < 2) throw new Error(`NOT_ENOUGH_SNAPSHOTS_${etfCode}`);
  const [to, from] = snaps;

  const [toPositions, fromPositions] = await Promise.all([
    query(`SELECT security_code, security_name, position_type, position_amount, position_unit, weight FROM etf_official_daily_positions WHERE snapshot_id = $1`, [to.id]),
    query(`SELECT security_code, security_name, position_type, position_amount, position_unit, weight FROM etf_official_daily_positions WHERE snapshot_id = $1`, [from.id]),
  ]);
  const T = new Map(toPositions.map((p) => [p.security_code, p]));
  const F = new Map(fromPositions.map((p) => [p.security_code, p]));
  const codes = new Set([...T.keys(), ...F.keys()]);

  const lotsOrNull = (amount: number | null, unit: string | null) => (amount != null && unit === "SHARES" ? amount / 1000 : null);

  const changes: FrontendHoldingChange[] = [];
  for (const code of codes) {
    const t = T.get(code), f = F.get(code);
    const toAmt = t ? Number(t.position_amount) : null;
    const fromAmt = f ? Number(f.position_amount) : null;
    const unit = (t ?? f).position_unit;
    const type = (t ?? f).position_type;
    if (!f && t) {
      changes.push({
        code, name: t.security_name, positionType: type, positionUnit: unit, action: "ADDED",
        changeLots: lotsOrNull(toAmt, unit), changeAmount: toAmt!, previousAmount: null, currentAmount: toAmt,
        previousWeight: null, currentWeight: Number(t.weight),
      });
    } else if (f && !t) {
      changes.push({
        code, name: f.security_name, positionType: type, positionUnit: unit, action: "REMOVED",
        changeLots: lotsOrNull(-fromAmt!, unit), changeAmount: -fromAmt!, previousAmount: fromAmt, currentAmount: null,
        previousWeight: Number(f.weight), currentWeight: null,
      });
    } else if (f && t) {
      const delta = Number(t.position_amount) - Number(f.position_amount);
      const action: FrontendAction = delta > 0 ? "INCREASED" : delta < 0 ? "DECREASED" : "UNCHANGED";
      changes.push({
        code, name: t.security_name, positionType: type, positionUnit: unit, action,
        changeLots: lotsOrNull(delta, unit), changeAmount: delta,
        previousAmount: fromAmt, currentAmount: toAmt,
        previousWeight: Number(f.weight), currentWeight: Number(t.weight),
      });
    }
  }

  const byAbsChangeDesc = (a: FrontendHoldingChange, b: FrontendHoldingChange) => Math.abs(b.changeAmount) - Math.abs(a.changeAmount);
  const added = changes.filter((c) => c.action === "ADDED").sort(byAbsChangeDesc);
  const removed = changes.filter((c) => c.action === "REMOVED").sort(byAbsChangeDesc);
  const increased = changes.filter((c) => c.action === "INCREASED").sort((a, b) => b.changeAmount - a.changeAmount);
  const decreased = changes.filter((c) => c.action === "DECREASED").sort((a, b) => a.changeAmount - b.changeAmount);
  const unchanged = changes.filter((c) => c.action === "UNCHANGED");

  return {
    etfCode,
    etfName: null,
    dateFrom: from.data_date,
    dateTo: to.data_date,
    addedCount: added.length, removedCount: removed.length, increasedCount: increased.length,
    decreasedCount: decreased.length, unchangedCount: unchanged.length,
    changes: [...added, ...removed, ...increased, ...decreased, ...unchanged],
    fundNavFrom: Number(from.fund_nav), fundNavTo: Number(to.fund_nav),
    outstandingUnitsFrom: Number(from.outstanding_units), outstandingUnitsTo: Number(to.outstanding_units),
    outstandingUnitsChangePct: Number(from.outstanding_units)
      ? (Number(to.outstanding_units) - Number(from.outstanding_units)) / Number(from.outstanding_units)
      : 0,
    disclaimer: DATA_DISCLAIMER,
  };
}
