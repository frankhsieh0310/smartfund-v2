import { Client } from "pg";
async function main() {
  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL, statement_timeout: 10000 });
  await c.connect();
  const src = await c.query(`SELECT slug, source_name, last_success_at::text, last_published_at::text, status FROM consensus_sources WHERE slug ILIKE '%wallstreet%' OR slug ILIKE '%wscn%' OR source_name ILIKE '%華爾街%'`);
  console.log("wallstreetcn source:", JSON.stringify(src.rows));
  const ev = await c.query(`SELECT MAX(created_at)::text latest_created, MAX(published_at)::text latest_published, MAX(event_at)::text latest_event_at FROM consensus_events`);
  console.log("consensus_events max:", JSON.stringify(ev.rows));
  const feed = await c.query(`SELECT MAX(created_at)::text latest_created, MAX(published_at)::text latest_published FROM consensus_feed_items WHERE source ILIKE '%wallstreet%' OR source ILIKE '%wscn%'`);
  console.log("consensus_feed_items (wallstreetcn) max:", JSON.stringify(feed.rows));
  const feedAll = await c.query(`SELECT MAX(created_at)::text latest_created FROM consensus_feed_items`);
  console.log("consensus_feed_items (all) max:", JSON.stringify(feedAll.rows));
  await c.end();
}
main().catch(e=>{console.error("ERR",e.message);process.exit(1);});
