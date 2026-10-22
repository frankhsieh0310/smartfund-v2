import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL, statement_timeout: 10000 });
  await c.connect();
  try {
    const t = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'consensus%'`);
    console.log("tables:", JSON.stringify(t.rows));
  } catch(e:any){ console.log("ERR1", e.message); }
  await c.end();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
