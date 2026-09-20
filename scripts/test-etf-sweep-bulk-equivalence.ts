// Integration check (network + production DB, ALWAYS rolled back): the chunked bulk writer used by the ETF full sweep must
// leave exactly the same rows as the per-row writers (ingestEtfHistory + enrichEtfProduct), and must use far fewer statements.
// Run: npx tsx --env-file=.env scripts/test-etf-sweep-bulk-equivalence.ts
import { PrismaClient } from "@prisma/client";
import { ingestEtfHistory } from "../lib/yahoo/etfHistory";
import { enrichEtfProduct } from "../lib/yahoo/etfEnrich";
import { fetchSweepPayload, loadChunkState, writeSweepChunk } from "../lib/yahoo/etfSweepBatch";
import { TW_UNIVERSE_SQL, yahooSymbolFor } from "../lib/yahoo/twEtfDistribution";

const prisma = new PrismaClient();
type Item = { etfId: string; symbol: string; enrichSymbol: string; group: string };
let failures = 0;
const check = (cond: unknown, msg: string) => { if (!cond) { failures++; console.log("FAIL:", msg); } else console.log("ok:", msg); };

// ---- deterministic Yahoo responses for the equivalence run (URL without crumb -> body) ----
const realFetch = globalThis.fetch;
const cache = new Map<string, { status: number; text: string }>();
function installCache() {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url);
    if (!url.includes("/v8/finance/chart/") && !url.includes("/v10/finance/quoteSummary/")) return realFetch(input, init); // auth/cookie/crumb calls stay real
    const key = url.replace(/([?&])crumb=[^&]*/, "$1crumb=X").replace(/([?&])period2=[^&]*/, "$1period2=X"); // period2 is "now": ignore it or every call is a cache miss
    let hit = cache.get(key);
    if (!hit) { const r = await realFetch(input, init); hit = { status: r.status, text: await r.text() }; cache.set(key, hit); }
    return new Response(hit.text, { status: hit.status, headers: { "content-type": "application/json" } });
  }) as any;
}
const removeCache = () => { globalThis.fetch = realFetch; };

async function pick(): Promise<Item[]> {
  const base = `e.is_active AND e.data_source ~ '^[A-Za-z0-9.^=-]{1,15}$'`;
  const sel = async (group: string, where: string, n: number) =>
    (await prisma.$queryRawUnsafe<any[]>(`SELECT e.id::text id, e.code, e.data_source, e.exchange FROM etfs e WHERE ${base} AND ${where} ORDER BY md5(e.id::text || '${group}') LIMIT ${n}`)).map((r) => ({
      etfId: r.id, symbol: r.data_source, enrichSymbol: group === "TW" ? yahooSymbolFor(r) : r.data_source, group,
    }));
  return [
    ...(await sel("TW", TW_UNIVERSE_SQL, 10)),
    ...(await sel("US", `e.region = 'US' AND e.exchange IN ('NYSEArca','NasdaqGM','CboeUS')`, 10)),
    ...(await sel("MIXED", `NOT ${TW_UNIVERSE_SQL} AND (e.region IS NULL OR e.region NOT IN ('US'))`, 10)),
  ];
}

type Q = (sql: string, params: any[]) => Promise<any[]>;
async function dump(q: Q, ids: string[], since: string) {
  const one = async (label: string, sql: string) => [label, JSON.stringify(await q(sql, [ids, since]))] as const;
  const stableTs = "CASE WHEN abs(extract(epoch FROM (retrieved_at - $2::timestamptz))) < 900 THEN 'ok' ELSE 'BAD' END";
  return Object.fromEntries(await Promise.all([
    one("history", `SELECT etf_id, date::text d, open::float8 o, high::float8 h, low::float8 l, close::float8 c, adjusted_close::float8 a, price::float8 p, volume::float8 v, source, (source_url IS NOT NULL) has_url FROM etf_history WHERE etf_id = ANY($1::text[]) AND known_at >= $2::timestamptz - interval '15 minutes' ORDER BY etf_id, date`),
    one("etfs", `SELECT id, name_en, category, currency, inception_date::text inc, latest_nav::float8 nav, aum::float8 aum, expense_ratio::float8 er, dividend_yield::float8 dy, beta::float8 beta, data_provider, data_source, latest_price::float8 lp, volume::float8 vol, return_1m::float8 r1m, return_3m::float8 r3m, return_6m::float8 r6m, return_ytd::float8 rytd, return_1y::float8 r1y, return_3y::float8 r3y, return_5y::float8 r5y FROM etfs WHERE id = ANY($1::text[]) ORDER BY id`),
    one("performances", `SELECT etf_id, date::text d, return_1m::float8 a, return_3m::float8 b, return_6m::float8 c, return_ytd::float8 e, return_1y::float8 f, return_3y::float8 g, return_5y::float8 h FROM etf_performances WHERE etf_id = ANY($1::text[]) AND created_at >= $2::timestamptz - interval '15 minutes' OR (etf_id = ANY($1::text[]) AND date = CURRENT_DATE) ORDER BY etf_id, date`),
    one("snapshots", `SELECT etf_id, source_record_id, checksum, source_row_count, parsed_row_count, canonical_row_count, source_type, verification_status, license_status, completeness_status, quality_status, parser_version, quality_metrics - 'retrievedAt' qm, archive_lineage al, ${stableTs} ts FROM etf_holding_snapshots WHERE etf_id = ANY($1::text[]) AND source = 'YAHOO_QUOTE_SUMMARY' AND retrieved_at >= $2::timestamptz - interval '15 minutes' ORDER BY etf_id, source_record_id`),
    one("holdings", `SELECT h.etf_id, s.source_record_id, h.source_row_id, h.holding_name, h.ticker, h.weight::float8 w, h.raw_row, h.holding_type, h.verification_status, h.quality_status FROM etf_holdings h JOIN etf_holding_snapshots s ON s.id = h.snapshot_id WHERE h.etf_id = ANY($1::text[]) AND s.source = 'YAHOO_QUOTE_SUMMARY' AND s.retrieved_at >= $2::timestamptz - interval '15 minutes' ORDER BY h.etf_id, h.source_row_id`),
    one("sectors", `SELECT etf_id, observation_date::text d, sector_name, weight::float8 w, source, (source_url IS NOT NULL) has_url, ${stableTs} ts FROM etf_sector_allocations WHERE etf_id = ANY($1::text[]) AND retrieved_at >= $2::timestamptz - interval '15 minutes' ORDER BY etf_id, sector_name`),
    one("credit", `SELECT etf_id, observation_date::text d, credit_rating, weight::float8 w, source, (source_url IS NOT NULL) has_url, ${stableTs} ts FROM etf_credit_rating_allocations WHERE etf_id = ANY($1::text[]) AND retrieved_at >= $2::timestamptz - interval '15 minutes' ORDER BY etf_id, credit_rating`),
    one("events", `SELECT etf_id, ex_date::text d, amount::float8 a, currency, source, source_record_id FROM etf_distribution_events WHERE etf_id = ANY($1::text[]) AND source = 'YAHOO_CHART' ORDER BY etf_id, ex_date`),
  ]));
}

async function inRolledBackTx<T>(fn: (q: Q, counter: { n: number }) => Promise<T>): Promise<{ value: T; statements: number; ms: number; dumpAfter?: any }> {
  const counter = { n: 0 };
  let value!: T; let ms = 0;
  try {
    await prisma.$transaction(async (tx) => {
      const q: Q = (sql, params) => { counter.n++; return (tx as any).$queryRawUnsafe(sql, ...params); };
      const t0 = Date.now();
      value = await fn(q, counter);
      ms = Date.now() - t0;
      (value as any).__q = q;
      throw new Error("ROLLBACK_INTENDED");
    }, { timeout: 280_000, maxWait: 30_000 });
  } catch (e: any) { if (e.message !== "ROLLBACK_INTENDED") throw e; }
  return { value, statements: counter.n, ms };
}

async function oldPath(items: Item[], q: Q) {
  const stats: any = { calls: 0, rateLimited: 0, crumbRefresh: 0 };
  for (const it of items) {
    await ingestEtfHistory(q as any, { etfId: it.etfId, symbol: it.symbol });
    await enrichEtfProduct(q as any, { etfId: it.etfId, symbol: it.enrichSymbol }, stats);
  }
}
async function newPath(items: Item[], q: Q) {
  const stateOf = await loadChunkState(q as any, items.map((i) => i.etfId));
  const payloads: any[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: 5 }, async () => { for (;;) { const i = next++; if (i >= items.length) return; payloads[i] = await fetchSweepPayload(items[i], stateOf(items[i].etfId)); } }));
  await writeSweepChunk(q as any, payloads);
}

async function main() {
  const items = await pick();
  console.log("fixture:", items.map((i) => `${i.group}:${i.symbol}`).join(" "));
  const ids = items.map((i) => i.etfId);

  // ---------- 1) data equivalence on identical (cached) Yahoo responses ----------
  installCache();
  const since = new Date().toISOString();
  let dumpOld: any, dumpNew: any;
  await inRolledBackTx(async (q) => { await oldPath(items, q); dumpOld = await dump(q, ids, since); return {}; });
  await inRolledBackTx(async (q) => { await newPath(items, q); dumpNew = await dump(q, ids, since); return {}; });
  removeCache();
  // Numbers may differ by ONE unit of the column's last decimal place: Postgres rounds a bound JS double and a JSON decimal
  // differently on exact ties (see sc() in etfSweepBatch.ts). Everything else (keys, strings, JSON, row sets) must be identical.
  const tolFor = (k: string, table: string) => (table === "performances" ? 1.01e-4 : k === "aum" ? 0.0101 : ["w", "o", "h", "l", "c", "a", "p"].includes(k) ? 1.01e-8 : k === "v" || k === "vol" ? 0.5 : 1.01e-4);
  for (const key of Object.keys(dumpOld)) {
    const a: any[] = JSON.parse(dumpOld[key]), b: any[] = JSON.parse(dumpNew[key]);
    let exact = 0, rounding = 0, bad = a.length !== b.length ? 1 : 0;
    const badEx: string[] = [];
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      let rowRound = false, rowBad = false;
      for (const k of new Set([...Object.keys(a[i]), ...Object.keys(b[i])])) {
        const x = a[i][k], y = b[i][k];
        if (JSON.stringify(x) === JSON.stringify(y)) continue;
        if (typeof x === "number" && typeof y === "number" && Math.abs(x - y) <= tolFor(k, key)) rowRound = true;
        else { rowBad = true; if (badEx.length < 2) badEx.push(`${k}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`); }
      }
      if (rowBad) bad++; else if (rowRound) rounding++; else exact++;
    }
    check(bad === 0, `${key}: ${a.length} rows old vs ${b.length} new - identical ${exact}, last-digit rounding only ${rounding}, different ${bad}`);
    if (bad) console.log("  ", badEx.join(" | "));
  }
  const nonEmpty = (k: string) => JSON.parse(dumpNew[k]).length > 0;
  check(nonEmpty("history") && nonEmpty("holdings") && nonEmpty("sectors") && nonEmpty("snapshots") && nonEmpty("etfs"), "fixture exercises history, snapshots, holdings, sectors and etfs metadata");

  // ---------- 2) benchmark on live Yahoo (no cache): per-row vs chunked ----------
  for (const group of ["TW", "US", "MIXED"]) {
    const g = items.filter((i) => i.group === group);
    const o = await inRolledBackTx(async (q) => { await oldPath(g, q); return {}; });
    const n = await inRolledBackTx(async (q) => { await newPath(g, q); return {}; });
    const perMin = (ms: number) => Math.round((g.length / (ms / 60000)) * 10) / 10;
    console.log(`BENCH ${group} n=${g.length}: BEFORE statements=${o.statements} (${(o.statements / g.length).toFixed(1)}/ETF) elapsed=${(o.ms / 1000).toFixed(1)}s rate=${perMin(o.ms)} ETFs/min | AFTER statements=${n.statements + 2} (${((n.statements + 2) / g.length).toFixed(1)}/ETF incl. BEGIN/COMMIT) elapsed=${(n.ms / 1000).toFixed(1)}s rate=${perMin(n.ms)} ETFs/min`);
    check(n.statements + 2 < o.statements / 3, `${group}: bulk uses <1/3 of the statements`);
  }
  await prisma.$disconnect();
  if (failures) { console.log(`${failures} FAILED`); process.exit(1); }
  console.log("ALL PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
