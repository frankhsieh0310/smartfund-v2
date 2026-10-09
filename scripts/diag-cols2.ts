import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL, statement_timeout: 10000 });
  await c.connect();
  for (const t of ["consensus_sources","consensus_events","consensus_feed_items"]) {
    const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [t]);
    console.log(t, JSON.stringify(r.rows.map((x:any)=>x.column_name)));
  }
  await c.end();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
