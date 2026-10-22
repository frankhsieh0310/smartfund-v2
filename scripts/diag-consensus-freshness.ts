import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL, statement_timeout: 10000 });
  await c.connect();
  const src = await c.query(`SELECT source_key, last_success_at::text, last_item_at::text FROM consensus_sources WHERE source_key ILIKE '%wallstreet%' OR source_key ILIKE '%wscn%'`);
  console.log("wallstreetcn source row:", JSON.stringify(src.rows));
  const ev = await c.query(`SELECT MAX(created_at)::text latest_created, MAX(event_date)::text latest_event_date FROM consensus_events`);
  console.log("consensus_events max:", JSON.stringify(ev.rows));
  const feed = await c.query(`SELECT MAX(created_at)::text latest_feed_created FROM consensus_feed_items`);
  console.log("consensus_feed_items max:", JSON.stringify(feed.rows));
  await c.end();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
