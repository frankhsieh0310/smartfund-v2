// 使用者核准：DROP INDEX CONCURRENTLY fund_history_fund_id_date_idx。CONCURRENTLY不能在交易內
// 執行，Prisma的$executeRawUnsafe會被包進交易（連線池在交易模式），所以改用pg.Client直連
// （DIRECT_URL，非pooled），每個陳述句各自autocommit。密鑰只在程式內部傳遞，不印出、不寫入log。
import "@prisma/client"; // 觸發Prisma自己的env載入機制，把DATABASE_URL/DIRECT_URL放進process.env
import { Client } from "pg";

async function main() {
  const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;
  const client = new Client({ connectionString });
  await client.connect();

  const before = await client.query(
    `SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) AS size FROM pg_indexes WHERE tablename='fund_history' ORDER BY indexname`,
  );
  console.log("執行前索引清單:", JSON.stringify(before.rows, null, 2));
  const sizeBefore = await client.query(`SELECT pg_size_pretty(pg_total_relation_size('fund_history')) total`);
  console.log("執行前fund_history總大小:", JSON.stringify(sizeBefore.rows));

  console.log("開始 DROP INDEX CONCURRENTLY ...");
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS fund_history_fund_id_date_idx`);
  console.log("完成。");

  const after = await client.query(
    `SELECT indexname, pg_size_pretty(pg_relation_size(indexname::regclass)) AS size FROM pg_indexes WHERE tablename='fund_history' ORDER BY indexname`,
  );
  console.log("執行後索引清單:", JSON.stringify(after.rows, null, 2));
  const sizeAfter = await client.query(`SELECT pg_size_pretty(pg_total_relation_size('fund_history')) total`);
  console.log("執行後fund_history總大小:", JSON.stringify(sizeAfter.rows));

  await client.end();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
