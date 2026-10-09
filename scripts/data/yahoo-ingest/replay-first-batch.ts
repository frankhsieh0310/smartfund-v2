// First production batch replay — runs the SAME lib functions the cloud endpoints call, against the
// production DB via node-postgres (Prisma $queryRawUnsafe is broken on this Windows box; ORM/lib
// logic is unaffected). Bounded + idempotent. Cloud path is /api/cron/yahoo-etf and /api/cron/yahoo-fund.
//
//   tsx scripts/data/yahoo-ingest/replay-first-batch.ts --etf 500
//   tsx scripts/data/yahoo-ingest/replay-first-batch.ts --fund 500
//
// Every write is COALESCE/ON CONFLICT idempotent; fund rows are tagged source='YAHOO_US_MF_V1'
// (fully reversible). Stale provider data never overwrites a newer DB value.

import { readFileSync } from "node:fs";
import pg from "pg";
import { enrichEtfProduct } from "../../../lib/yahoo/etfEnrich";
import { ingestEtfHistory } from "../../../lib/yahoo/etfHistory";
import { enrichFundFromYahoo, ingestUsFundShareClass, discoverUsFunds } from "../../../lib/yahoo/fundIngest";
import { sleep, type RateStats } from "../../../lib/yahoo/productSession";

const url = readFileSync(new URL("../../../.env", import.meta.url), "utf8").match(/DATABASE_URL="([^"]+)"/)![1];
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 4 });
const query = async (sql: string, params: unknown[] = []): Promise<any[]> => (await pool.query(sql, params as any[])).rows;

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,15}$/;
const REQUIRED_ETFS = ["SPY", "QQQ", "BND", "VXUS", "GLD", "HYG", "EWJ", "VOO", "VTI", "SCHD", "AGG", "LQD", "VNQ", "XLK", "IEMG"];

async function runEtf(n: number) {
  const stats: RateStats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  const req = (await query(
    `SELECT id::text, code, data_source FROM etfs WHERE upper(code) = ANY($1) AND is_active = true`, [REQUIRED_ETFS],
  ));
  const rest = (await query(
    `SELECT id::text, code, data_source FROM etfs
      WHERE is_active = true AND data_source ~ '^[A-Za-z0-9.^=-]{1,15}$'
        AND upper(code) <> ALL($1)
      ORDER BY id LIMIT $2`, [REQUIRED_ETFS, Math.max(0, n - req.length)],
  ));
  const rows = [...req, ...rest];
  let hist = 0, histRows = 0, enr = 0, hold = 0, perf = 0, dist = 0, fail = 0, noSym = 0;
  const t0 = Date.now();
  for (const e of rows) {
    const sym = String(e.data_source ?? "").trim();
    if (!SYMBOL_RE.test(sym)) { noSym++; continue; }
    try {
      const h = await ingestEtfHistory(query, { etfId: e.id, symbol: sym });
      if (h.ok) { hist++; histRows += h.rowsWritten; dist += h.distributionEvents; } else fail++;
      const p = await enrichEtfProduct(query, { etfId: e.id, symbol: sym });
      if (p.ok) { enr++; hold += p.holdingsWritten; perf += p.performanceWritten; } else fail++;
    } catch (err) { fail++; console.error(e.code, String(err).slice(0, 120)); }
    if ((hist + enr) % 25 === 0) process.stdout.write(`  …${hist}/${rows.length} hist, ${enr} enrich, ${histRows} rows, ${fail} fail\n`);
    await sleep(700);
  }
  console.log(JSON.stringify({
    ETF_FIRST_BATCH_ATTEMPTED: rows.length, ETF_HISTORY_OK: hist, ETF_ENRICH_OK: enr,
    ETF_HISTORY_ROWS_WRITTEN: histRows, ETF_HOLDINGS_WRITTEN: hold, ETF_PERF_WRITTEN: perf,
    ETF_DISTRIBUTION_EVENTS: dist, ETF_FAILED: fail, NO_SYMBOL: noSym, runtime_s: ((Date.now() - t0) / 1000) | 0, stats,
  }, null, 2));
}

async function runFund(n: number) {
  const stats: RateStats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  const disc = await discoverUsFunds({ perCategory: Math.ceil(n / 11) + 10, minRating: 1, stats });
  const symbols = disc.symbols.slice(0, n);
  console.log(`discovered ${disc.symbols.length} US MF symbols across ${Object.keys(disc.perCategoryTotals).length} categories; ingesting ${symbols.length}`);
  console.log("per_category_totals:", JSON.stringify(disc.perCategoryTotals));
  const mastersHoldings = new Set<string>();
  let ok = 0, fail = 0, scIns = 0, scUpd = 0, mCreated = 0, mLinked = 0, navRows = 0, dist = 0, holdRows = 0;
  let msO = 0, msR = 0, msC = 0, msRank = 0;
  const t0 = Date.now();
  for (const sym of symbols) {
    try {
      const rec = await enrichFundFromYahoo(sym);
      if (!rec) { fail++; continue; }
      const r = await ingestUsFundShareClass(query, rec, mastersHoldings);
      if (r.ok) {
        ok++;
        if (r.shareClassInserted) scIns++;
        if (r.shareClassUpdated) scUpd++;
        if (r.masterCreated) mCreated++;
        if (r.masterLinked) mLinked++;
        navRows += r.navRowsWritten; dist += r.distributionRows; holdRows += r.holdingsWritten;
        if (r.morningstar.overall != null) msO++;
        if (r.morningstar.risk != null) msR++;
        if (r.morningstar.category) msC++;
        if (r.morningstar.rank != null) msRank++;
      } else { fail++; if (r.error) console.error(sym, r.error.slice(0, 140)); }
    } catch (err) { fail++; console.error(sym, String(err).slice(0, 140)); }
    if ((ok + fail) % 25 === 0) process.stdout.write(`  …${ok + fail}/${symbols.length}  SC+${scIns}/~${scUpd}  master+${mCreated}/link${mLinked}  nav${navRows}\n`);
    await sleep(900);
  }
  console.log(JSON.stringify({
    FUND_SHARE_CLASS_FIRST_BATCH_ATTEMPTED: symbols.length,
    FUND_SHARE_CLASS_INSERTED: scIns, FUND_SHARE_CLASS_UPDATED: scUpd, FUND_INGEST_FAILED: fail,
    FUND_MASTER_CREATED: mCreated, FUND_MASTER_LINKED_CLASSES: mLinked + mCreated,
    FUND_HISTORY_ROWS_WRITTEN: navRows, FUND_DISTRIBUTION_ROWS: dist, FUND_MASTER_HOLDINGS_WRITTEN: holdRows,
    MORNINGSTAR_RATING_POPULATED: msO, MORNINGSTAR_RISK_POPULATED: msR,
    MORNINGSTAR_CATEGORY_POPULATED: msC, MORNINGSTAR_RANK_POPULATED: msRank,
    runtime_s: ((Date.now() - t0) / 1000) | 0, stats,
  }, null, 2));
}

(async () => {
  if (arg("etf")) await runEtf(Number(arg("etf")));
  if (arg("fund")) await runFund(Number(arg("fund")));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
