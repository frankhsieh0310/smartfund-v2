// Quality gate: 50 fund share classes ingested this run (source='YAHOO_US_MF_V1').
import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const sample = (await c.query(`
  SELECT f.id::text, f.name, f.company, f.region, f.morningstar, f.morningstar_risk, f.morningstar_category,
         f.morningstar_category_rank_3y, f.return_1y, f.return_3y, f.return_5y, f.expense_ratio, f.latest_nav,
         f.data_source, sc.id::text sc_id, sc.master_fund_id, sc.share_class_code, sc.source sc_source
    FROM funds f
    JOIN fund_share_classes sc ON sc.fund_id = f.id AND sc.source = 'YAHOO_US_MF_V1'
   WHERE f.last_nav_source = 'YAHOO_QUOTE_SUMMARY'
   ORDER BY sc.updated_at DESC
   LIMIT 50`)).rows;

let idOk = 0, masterOk = 0, msValid = 0, riskValid = 0, catOk = 0, perfOk = 0, histOk = 0, navOk = 0;
let wrongMerge = 0, dupHist = 0, mapOk = 0;
const issues = [];
const masterMembers = {};
for (const f of sample) {
  // share-class identity: code == data_source, unique fund row
  if (f.share_class_code === f.data_source) idOk++; else issues.push(`${f.data_source}: sc code ${f.share_class_code}`);

  // master mapping present
  if (f.master_fund_id) {
    masterOk++;
    (masterMembers[f.master_fund_id] ??= []).push(f.name);
  } else issues.push(`${f.data_source}: no master_fund_id`);

  // morningstar 1..5
  if (f.morningstar == null || (f.morningstar >= 1 && f.morningstar <= 5)) msValid++;
  else issues.push(`${f.data_source}: morningstar ${f.morningstar}`);
  if (f.morningstar_risk == null || (f.morningstar_risk >= 1 && f.morningstar_risk <= 5)) riskValid++;
  else issues.push(`${f.data_source}: risk ${f.morningstar_risk}`);
  if (f.morningstar_category) catOk++;

  if (f.return_1y != null || f.return_3y != null || f.return_5y != null) perfOk++;

  // provider mapping
  const pm = (await c.query(`SELECT provider_code, status FROM fund_provider_mappings WHERE fund_id=$1 AND provider='YAHOO'`, [f.id])).rows[0];
  if (pm && pm.provider_code === f.data_source) mapOk++;
  else issues.push(`${f.data_source}: provider mapping ${JSON.stringify(pm)}`);

  // history depth + duplicate (fund_id,date)
  const h = (await c.query(`SELECT count(*)::int n, max(date)::text mx,
      (SELECT count(*) FROM (SELECT date FROM fund_history WHERE fund_id=$1 GROUP BY date HAVING count(*)>1) d)::int dups,
      count(*) FILTER (WHERE nav IS NULL)::int nullnav
      FROM fund_history WHERE fund_id=$1`, [f.id])).rows[0];
  if (h.n > 20) histOk++; else issues.push(`${f.data_source}: only ${h.n} nav rows`);
  if (h.dups > 0) { dupHist++; issues.push(`${f.data_source}: ${h.dups} dup nav dates`); }
  if (h.nullnav === 0 && h.n > 0) navOk++;
}

// wrong-merge detection: any master whose members have >1 distinct normalized stem
function stem(n){return (n||"").replace(/\s+/g," ").replace(/\s+(?:Class\s+)?(?:A|B|C|D|F|F-?\d|I{1,3}|R-?\d?|R\d?E|K6?|Adm(?:iral)?|Inv(?:estor)?|Instl?(?:\s*(?:Pl(?:us)?|Sel(?:ect)?|Prm|Premier))?|Institutional|Inst(?:\s*(?:Pl(?:us)?|Sel(?:ect)?))?|529-?[A-F0-9-]+|Select|Retail|Svc|Service|Advisor|Adv)\b.*$/i,"").replace(/[^A-Za-z0-9 &/.-]/g,"").trim().toLowerCase();}
for (const [mid, names] of Object.entries(masterMembers)) {
  const stems = new Set(names.map(stem));
  if (stems.size > 1) { wrongMerge++; issues.push(`master ${mid.slice(0,8)}: mixed stems ${JSON.stringify([...stems])}`); }
}

// master holdings must not be duplicated per master
const dupMasterHold = (await c.query(`
  SELECT fund_id, count(*)::int n FROM holdings
   WHERE source='YAHOO_QUOTE_SUMMARY' AND as_of_date=current_date
   GROUP BY fund_id, rank HAVING count(*) > 1 LIMIT 10`)).rows;

console.log(JSON.stringify({
  QUALITY_GATE_FUND_50: sample.length,
  SHARE_CLASS_IDENTITY_OK: idOk, MASTER_MAPPING_OK: masterOk, PROVIDER_MAPPING_OK: mapOk,
  MORNINGSTAR_1_5_VALID: msValid, RISK_1_5_VALID: riskValid, CATEGORY_PRESENT: catOk,
  PERF_PRESENT: perfOk, HISTORY_OK: histOk, NAV_NO_NULLS: navOk,
  WRONG_MASTER_MERGES: wrongMerge, DUPLICATE_HISTORY_DATES: dupHist, DUP_MASTER_HOLDINGS: dupMasterHold.length,
  DISTINCT_MASTERS_IN_SAMPLE: Object.keys(masterMembers).length,
  ISSUES: issues.slice(0, 40),
}, null, 2));
await c.end();
