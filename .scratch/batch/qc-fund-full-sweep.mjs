import pg from "pg";
import { readFileSync } from "node:fs";
const url = readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)[1];
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const sample = (await c.query(`
  SELECT f.id::text, f.name, f.morningstar, f.morningstar_risk, f.morningstar_category, f.return_1y,
         sc.id::text sc_id, sc.master_fund_id, sc.share_class_code, sc.source sc_source
    FROM funds f
    JOIN fund_share_classes sc ON sc.fund_id = f.id AND sc.source = 'YAHOO_US_MF_V1'
   WHERE f.last_nav_source = 'YAHOO_QUOTE_SUMMARY'
   ORDER BY sc.updated_at DESC
   LIMIT 50`)).rows;

let idOk = 0, masterOk = 0, msValid = 0, riskValid = 0, catOk = 0, perfOk = 0, histOk = 0;
const issues = [];
const masterMembers = {};
function stem(n) {
  return (n || "").replace(/\s+/g, " ").replace(/\s+(?:Class\s+)?(?:A|B|C|D|F|F-?\d|I{1,3}|R-?\d?|R\d?E|K6?|Adm(?:iral)?|Inv(?:estor)?|Instl?(?:\s*(?:Pl(?:us)?|Sel(?:ect)?|Prm|Premier))?|Institutional|Inst(?:\s*(?:Pl(?:us)?|Sel(?:ect)?))?|529-?[A-F0-9-]+|Select|Retail|Svc|Service|Advisor|Adv)\b.*$/i, "")
    .replace(/[^A-Za-z0-9 &/.-]/g, "").trim().toLowerCase();
}
for (const f of sample) {
  if (f.share_class_code) idOk++;
  if (f.master_fund_id) { masterOk++; (masterMembers[f.master_fund_id] ??= []).push(f.name); }
  if (f.morningstar == null || (f.morningstar >= 1 && f.morningstar <= 5)) msValid++; else issues.push(`${f.share_class_code}: morningstar ${f.morningstar}`);
  if (f.morningstar_risk == null || (f.morningstar_risk >= 1 && f.morningstar_risk <= 5)) riskValid++; else issues.push(`${f.share_class_code}: risk ${f.morningstar_risk}`);
  if (f.morningstar_category) catOk++;
  if (f.return_1y != null) perfOk++;
  const h = (await c.query(`SELECT count(*)::int n, (SELECT count(*) FROM (SELECT date FROM fund_history WHERE fund_id=$1 GROUP BY date HAVING count(*)>1) d)::int dups FROM fund_history WHERE fund_id=$1`, [f.id])).rows[0];
  if (h.n > 5) histOk++;
  if (h.dups > 0) issues.push(`${f.share_class_code}: ${h.dups} dup history dates`);
}
let wrongMerge = 0;
for (const [mid, names] of Object.entries(masterMembers)) {
  if (new Set(names.map(stem)).size > 1) { wrongMerge++; issues.push(`master ${mid.slice(0,8)}: mixed ${JSON.stringify([...new Set(names.map(stem))])}`); }
}
const dupMasterHold = (await c.query(`SELECT fund_id, rank, count(*)::int n FROM holdings WHERE source='YAHOO_QUOTE_SUMMARY' AND as_of_date=current_date GROUP BY fund_id, rank HAVING count(*)>1 LIMIT 10`)).rows;

console.log(JSON.stringify({
  SAMPLE: sample.length, SHARE_CLASS_ID_OK: idOk, MASTER_MAPPING_OK: masterOk,
  MORNINGSTAR_VALID: msValid, RISK_VALID: riskValid, CATEGORY_PRESENT: catOk, PERF_PRESENT: perfOk,
  HISTORY_OK: histOk, WRONG_MASTER_MERGES: wrongMerge, DUP_MASTER_HOLDINGS: dupMasterHold.length,
  DISTINCT_MASTERS: Object.keys(masterMembers).length, ISSUES: issues.slice(0, 20),
}, null, 2));
await c.end();
