import { Client } from "pg";
const isZh = (s: string) => /[一-鿿]/.test(s);
async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL, statement_timeout: 10000 });
  await c.connect();
  const r = await c.query(`
    WITH latest AS (
      SELECT DISTINCT ON (fund_id, metric_code) fund_id, metric_code, value, as_of_date
        FROM fund_risk_metrics WHERE metric_code IN ('RETURN_1M','RETURN_3M','RETURN_6M','RETURN_YTD')
       ORDER BY fund_id, metric_code, as_of_date DESC
    )
    SELECT l.metric_code, COUNT(*)::int c, MIN(l.as_of_date)::text earliest, MAX(l.as_of_date)::text latest
    FROM latest l GROUP BY l.metric_code`);
  console.log(r.rows);
  const zh = await c.query(`
    WITH latest AS (
      SELECT DISTINCT ON (fund_id) fund_id, value, as_of_date
        FROM fund_risk_metrics WHERE metric_code = 'RETURN_1M'
       ORDER BY fund_id, as_of_date DESC
    )
    SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE f.name ~ '[一-鿿]')::int zh
    FROM latest l JOIN funds f ON f.id = l.fund_id WHERE f.is_active=true`);
  console.log("RETURN_1M zh coverage:", zh.rows[0]);
  await c.end();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
