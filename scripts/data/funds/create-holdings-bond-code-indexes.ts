// 2026-10-21（14點任務第10項，使用者核准執行的DDL）: holdings.cusip / holdings.isin 從來沒有
// 索引，債券反查（/api/screener/bond-holders）的CUSIP/ISIN精確比對每次都是Parallel Seq Scan
// 掃過全部434萬筆holdings——VERIFIED EXPLAIN ANALYZE單這段就要12.6秒，是「債券反查搜尋失效」
// 使用者實際感受到的主因。CREATE INDEX CONCURRENTLY不鎖表，對線上服務安全；WHERE xxx IS NOT
// NULL做部分索引，只索引真的有值的列（cusip/isin大多數列是NULL，股票/基金持股沒有這兩欄）。
//
// CONCURRENTLY 不能包在交易裡，所以這裡不是像其他遷移腳本那樣BEGIN/ROLLBACK的dry-run模式——
// 直接執行，執行前後各查一次索引是否存在來確認結果。
import { Client } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const before = await client.query(`SELECT indexname FROM pg_indexes WHERE tablename='holdings' AND indexname IN ('idx_holdings_cusip','idx_holdings_isin')`);
    console.log("BEFORE:", before.rows.map((r) => r.indexname));

    console.log("Creating idx_holdings_cusip ...");
    const t1 = Date.now();
    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_holdings_cusip ON holdings (cusip) WHERE cusip IS NOT NULL`);
    console.log(`idx_holdings_cusip done in ${Date.now() - t1}ms`);

    console.log("Creating idx_holdings_isin ...");
    const t2 = Date.now();
    await client.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_holdings_isin ON holdings (isin) WHERE isin IS NOT NULL`);
    console.log(`idx_holdings_isin done in ${Date.now() - t2}ms`);

    const after = await client.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='holdings' AND indexname IN ('idx_holdings_cusip','idx_holdings_isin')`);
    console.log("AFTER:", JSON.stringify(after.rows, null, 1));
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
