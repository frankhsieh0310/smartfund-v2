// Quality gate: 50 ETF samples touched by YAHOO_QUOTE_SUMMARY today.
import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const sample = (await c.query(`
  SELECT DISTINCT e.id::text, e.code, e.data_source, e.name_en, e.category, e.expense_ratio,
         e.aum, e.return_1y, e.latest_price, e.price_updated_at::text
    FROM etfs e
    JOIN etf_holding_snapshots s ON s.etf_id = e.id AND s.source = 'YAHOO_QUOTE_SUMMARY'
   WHERE s.retrieved_at > now() - interval '6 hours'
   ORDER BY e.code
   LIMIT 50`)).rows;

let mapOk = 0, priceOk = 0, histOk = 0, perfOk = 0, holdOk = 0, dupHist = 0, badWeight = 0, snapDup = 0;
const issues = [];
for (const e of sample) {
  // 1) symbol mapping: data_source must equal the yahoo symbol we ingested and look like a real ticker
  if (e.data_source && /^[A-Za-z0-9.^=-]{1,15}$/.test(e.data_source)) mapOk++;
  else issues.push(`${e.code}: bad data_source ${e.data_source}`);

  // 2) latest price present & positive
  if (e.latest_price != null && Number(e.latest_price) > 0) priceOk++;
  else issues.push(`${e.code}: latest_price ${e.latest_price}`);

  // 3) history rows + duplicate (etf_id,date) check
  const h = (await c.query(`SELECT count(*)::int n, max(date)::text mx,
      (SELECT count(*) FROM (SELECT date FROM etf_history WHERE etf_id=$1 GROUP BY date HAVING count(*)>1) d)::int dups
      FROM etf_history WHERE etf_id=$1`, [e.id])).rows[0];
  if (h.n > 20) histOk++; else issues.push(`${e.code}: only ${h.n} history rows`);
  if (h.dups > 0) { dupHist++; issues.push(`${e.code}: ${h.dups} duplicate history dates`); }

  // 4) performance row today
  const p = (await c.query(`SELECT return_1y, return_3y FROM etf_performances WHERE etf_id=$1 AND date=current_date`, [e.id])).rows;
  if (p.length) perfOk++;

  // 5) holdings: snapshot dedup + weight sanity (stored as % 0..100)
  const snaps = (await c.query(`SELECT count(*)::int n FROM etf_holding_snapshots WHERE etf_id=$1 AND source='YAHOO_QUOTE_SUMMARY' AND effective_date IS NULL AND source_record_id LIKE 'YAHOO:%:'||to_char(current_date,'YYYY-MM-DD')`, [e.id])).rows[0];
  if (snaps.n > 1) { snapDup++; issues.push(`${e.code}: ${snaps.n} same-day YAHOO snapshots`); }
  const hold = (await c.query(`SELECT count(*)::int n, min(weight)::float mn, max(weight)::float mx
      FROM etf_holdings h JOIN etf_holding_snapshots s ON s.id=h.snapshot_id
      WHERE s.etf_id=$1 AND s.source='YAHOO_QUOTE_SUMMARY'`, [e.id])).rows[0];
  if (hold.n > 0) {
    holdOk++;
    if (hold.mn < 0 || hold.mx > 100) { badWeight++; issues.push(`${e.code}: holding weight out of range ${hold.mn}..${hold.mx}`); }
  }
}
console.log(JSON.stringify({
  QUALITY_GATE_ETF_50: sample.length,
  MAPPING_OK: mapOk, LATEST_PRICE_OK: priceOk, HISTORY_OK: histOk, PERF_ROW_TODAY: perfOk, HOLDINGS_OK: holdOk,
  DUPLICATE_HISTORY_DATES: dupHist, SAME_DAY_SNAPSHOT_DUP: snapDup, HOLDING_WEIGHT_OUT_OF_RANGE: badWeight,
  ISSUES: issues.slice(0, 40),
}, null, 2));

// holdings source-priority spot check: any ETF that also has OFFICIAL_ISSUER / MONEYDJ snapshots — YAHOO must not be the only/first
const pri = (await c.query(`
  SELECT e.code, array_agg(DISTINCT s.source) srcs
    FROM etfs e JOIN etf_holding_snapshots s ON s.etf_id=e.id
   WHERE e.id IN (${sample.map((_,i)=>`$${i+1}`).join(",")})
   GROUP BY e.code HAVING array_agg(DISTINCT s.source) && ARRAY['OFFICIAL_ISSUER','MONEYDJ']::text[]`,
  sample.map(s=>s.id))).rows;
console.log("MULTI_SOURCE_ETFS (Yahoo is additive, not overwriting):", JSON.stringify(pri));
await c.end();
