import { Client } from "pg";

const codes = ["0050", "0056", "00878", "00919", "006208"];

async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL, statement_timeout: 15000 });
  await c.connect();
  const query = async (sql, params) => (await c.query(sql, params)).rows;

  for (const etfCode of codes) {
    const etfRows = await query(
      `SELECT id FROM etfs WHERE code = $1 AND currency = 'TWD' AND exchange IN ('TWSE','TPEx','TPEX') LIMIT 1`,
      [etfCode],
    );
    if (!etfRows.length) { console.log(etfCode, "SKIPPED_NO_ETF_MAPPING"); continue; }
    const etfId = etfRows[0].id;

    const snaps = await query(
      `SELECT id, data_date::text AS data_date FROM etf_official_daily_snapshots WHERE etf_code = $1 ORDER BY data_date DESC LIMIT 1`,
      [etfCode],
    );
    if (!snaps.length) { console.log(etfCode, "SKIPPED_NO_SNAPSHOT"); continue; }
    const { id: snapshotId, data_date: dataDate } = snaps[0];

    const positions = await query(
      `SELECT security_code, security_name, position_type, position_amount, position_unit, weight, rank
         FROM etf_official_daily_positions WHERE snapshot_id = $1 ORDER BY weight DESC`,
      [snapshotId],
    );
    if (!positions.length) { console.log(etfCode, "SKIPPED_EMPTY_POSITIONS", "dataDate", dataDate); continue; }

    const codesList = [...new Set(positions.map((p) => String(p.security_code)))];
    const securities = codesList.length
      ? await query(`SELECT id, ticker FROM securities WHERE ticker = ANY($1::text[])`, [codesList])
      : [];
    const byTicker = new Map(securities.map((s) => [String(s.ticker), s.id]));
    const mapped = positions.filter((p) => byTicker.has(String(p.security_code))).length;

    // Layer 3 comparison: what current-holdings.ts's own query currently returns as "latest" for
    // this ETF (production, read-only) vs what the official snapshot/positions say right now.
    const currentHoldings = await query(
      `WITH latest AS (SELECT etf_id, max(as_of_date) as_of_date FROM holdings WHERE etf_id=$1 GROUP BY etf_id)
       SELECT h.as_of_date::text, count(*)::int n, max(h.weight)::float top_weight
         FROM holdings h JOIN latest l ON l.etf_id=h.etf_id AND l.as_of_date=h.as_of_date WHERE h.etf_id=$1 GROUP BY h.as_of_date`,
      [etfId],
    );

    const top3 = positions.slice(0, 3).map((p) => `${p.security_code}:${p.security_name}@${Number(p.weight).toFixed(2)}%`).join(", ");
    console.log(JSON.stringify({
      etfCode, etfId, officialDataDate: dataDate,
      officialPositions: positions.length, mappedToSecurity: mapped,
      officialTop3: top3,
      currentHoldingsLatest: currentHoldings[0] ?? "NONE",
    }));
  }
  await c.end();
}
main().catch((e) => { console.error("ERR", e.message); process.exit(1); });
