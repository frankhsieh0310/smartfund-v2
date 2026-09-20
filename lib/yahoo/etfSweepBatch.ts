// Chunked (bulk-write) processing for the EXISTING ETF full sweep — one pipeline, one checkpoint.
//
// Before: per ETF ~30 DB round trips (one INSERT per holding row, per sector row, per credit row, plus history/meta
// statements), strictly sequential. Now a chunk of ETFs is fetched with bounded concurrency (Yahoo only, no DB), turned
// into row plans in memory, and written with ONE statement per table for the whole chunk, inside one short transaction.
// Semantics (COALESCE rules, conflict targets, values) mirror lib/yahoo/etfHistory.ts + etfEnrich.ts exactly; the
// equivalence test (scripts/test-etf-sweep-bulk-equivalence.ts) runs both writers on identical Yahoo responses.

import { fetchChartFull, newRateStats, type RateStats } from "./productSession";
import { fetchDividendHistory, planDividendCatchUp } from "./distributionFetch";
import { bulkUpsertEvents, type EventRow } from "./twEtfDistribution";
import { buildEnrichPlan, fetchEtfEnrichCtx, type EnrichPlan } from "./etfEnrich";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;
export type SweepItem = { etfId: string; symbol: string; enrichSymbol: string };

type Candle = { date: string; open: number; high: number; low: number; close: number; adjusted_close: number | null; volume: number | null };
export type SweepPayload = {
  item: SweepItem;
  history: { ok: boolean; error?: string; candles: Candle[]; sourceUrl: string; latestClose: number | null; latestVolume: number | null; firstDate: string | null; latestDate: string | null };
  events: EventRow[];
  enrich: { coreOk: boolean; holdingsOk: boolean; plan: EnrichPlan | null; error?: string; failure?: string };
  stats: RateStats; // per-item, so concurrent fetches never overwrite each other's lastFailure
};

export type SweepItemResult = {
  etfId: string; symbol: string;
  historyOk: boolean; rowsWritten: number; distributionEvents: number;
  coreOk: boolean; holdingsOk: boolean; holdingsWritten: number; sectorAllocWritten: number; creditAllocWritten: number; performanceWritten: number;
  failure?: string; // enrich failure reason (for the repair queue)
};

const CHUNK_ROWS = 2000;

/**
 * Pre-round to the column scale exactly the way a bound JS number is rounded by Postgres (exact binary value, round-to-nearest).
 * A JSON/decimal-text round trip would round half-up on the decimal digits instead and differ in the last digit on ties
 * (8.30515 -> 8.3051 as a bound parameter, 8.3052 via jsonb text), which the equivalence test caught.
 */
const sc = (v: number | null | undefined, d: number): number | null => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

/** Fetch phase — Yahoo only. `state` comes from two bulk SELECTs for the whole chunk. */
export async function fetchSweepPayload(
  item: SweepItem,
  state: { lastDate: string | null; hasHistory: boolean; lastEvent: string | null },
): Promise<SweepPayload> {
  const stats: RateStats = newRateStats();
  const period1 = state.hasHistory && state.lastDate ? Math.floor((Date.parse(state.lastDate) - 5 * 86_400_000) / 1000) : 0;
  const sourceUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.symbol)}?period1=${period1}&interval=1d&events=div%2Csplit`;
  const payload: SweepPayload = {
    item,
    history: { ok: false, candles: [], sourceUrl, latestClose: null, latestVolume: null, firstDate: null, latestDate: null },
    events: [],
    enrich: { coreOk: false, holdingsOk: false, plan: null },
    stats,
  };

  const [chart, enrichCtx] = await Promise.all([
    fetchChartFull(item.symbol, { period1 }).catch(() => null),
    fetchEtfEnrichCtx(item.enrichSymbol, stats).catch(() => ({ coreOk: false, holdingsOk: false, ctx: null, error: "EXCEPTION" as string | undefined })),
  ]);

  if (!chart) payload.history.error = "NO_CHART";
  else {
    const valid = chart.candles.filter(
      (c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v as number)) && (c.high as number) >= (c.low as number) && (c.close as number) > 0,
    );
    if (!valid.length) payload.history.error = "NO_VALID_CANDLES";
    else {
      payload.history.ok = true;
      payload.history.candles = valid.map((c) => ({
        date: c.date, open: c.open as number, high: c.high as number, low: c.low as number, close: c.close as number,
        adjusted_close: Number.isFinite(c.adjClose as number) ? (c.adjClose as number) : null, volume: c.volume as number | null,
      }));
      payload.history.firstDate = valid[0].date;
      payload.history.latestDate = valid[valid.length - 1].date;
      payload.history.latestClose = valid[valid.length - 1].close as number;
      payload.history.latestVolume = (valid[valid.length - 1].volume as number | null) ?? null;

      // dividends: anchor = last STORED event (-45d overlap), extra light request only when the price window doesn't reach it
      const events = new Map<string, number>();
      for (const d of chart.dividends) if (d.amount > 0 && d.date) events.set(d.date, Math.round(d.amount * 1e6) / 1e6);
      const from = planDividendCatchUp(state.lastEvent, period1);
      if (from != null) {
        const extra = await fetchDividendHistory(item.symbol, { period1: from });
        if (extra.kind === "OK") for (const e of extra.events) events.set(e.exDate, e.amount);
      }
      payload.events = [...events].map(([exDate, amount]) => ({
        etfId: item.etfId, exDate, amount, currency: chart.currency ?? "USD", source: "YAHOO_CHART", sourceRecordId: `YAHOO:${item.symbol}:${exDate}`,
      }));
    }
  }

  payload.enrich.coreOk = enrichCtx.coreOk;
  payload.enrich.holdingsOk = enrichCtx.holdingsOk;
  payload.enrich.error = enrichCtx.error;
  if (!enrichCtx.coreOk) payload.enrich.failure = stats.lastFailure ?? "NO_QUOTE_SUMMARY_CORE";
  if (enrichCtx.ctx) payload.enrich.plan = buildEnrichPlan(item.etfId, item.enrichSymbol, enrichCtx.ctx);
  return payload;
}

/**
 * Bulk state for a chunk: last price date / history count and the dividend anchor per ETF (2 statements).
 * Anchor = last stored Yahoo event; if an ETF only has official-issuer events (e.g. iShares, which the old backfill skipped),
 * the last event of any source — so issuers' ETFs like AGG also get their newer Yahoo events.
 */
export async function loadChunkState(query: QueryFn, etfIds: string[]) {
  const [hist, ev] = await Promise.all([
    query(`SELECT etf_id, max(date)::text AS d, count(*)::int AS n FROM etf_history WHERE etf_id = ANY($1::text[]) GROUP BY etf_id`, [etfIds]),
    query(`SELECT etf_id, COALESCE(max(ex_date) FILTER (WHERE source = 'YAHOO_CHART'), max(ex_date))::text AS d FROM etf_distribution_events WHERE etf_id = ANY($1::text[]) GROUP BY etf_id`, [etfIds]),
  ]);
  const h = new Map(hist.map((r) => [String(r.etf_id), { lastDate: (r.d as string) ?? null, hasHistory: Number(r.n) > 0 }]));
  const e = new Map(ev.map((r) => [String(r.etf_id), (r.d as string) ?? null]));
  return (id: string) => ({ lastDate: h.get(id)?.lastDate ?? null, hasHistory: h.get(id)?.hasHistory ?? false, lastEvent: e.get(id) ?? null });
}

const sliceRows = <T,>(rows: T[], n = CHUNK_ROWS) => Array.from({ length: Math.ceil(rows.length / n) }, (_, i) => rows.slice(i * n, (i + 1) * n));

/** Write phase — one statement per table for the whole chunk. Run inside a transaction by the caller. */
export async function writeSweepChunk(query: QueryFn, payloads: SweepPayload[]): Promise<SweepItemResult[]> {
  const results = new Map<string, SweepItemResult>(
    payloads.map((p) => [p.item.etfId, {
      etfId: p.item.etfId, symbol: p.item.symbol, historyOk: p.history.ok, rowsWritten: 0, distributionEvents: p.events.length,
      coreOk: p.enrich.coreOk, holdingsOk: p.enrich.holdingsOk, holdingsWritten: 0, sectorAllocWritten: 0, creditAllocWritten: 0, performanceWritten: 0,
      failure: p.enrich.failure,
    }]),
  );
  const retrievedAt = new Date().toISOString();

  // ---- price history (+ latest price on etfs) ----
  const histRows = payloads.flatMap((p) => p.history.candles.map((c) => ({ etf_id: p.item.etfId, source_url: p.history.sourceUrl, date: c.date, open: sc(c.open, 8), high: sc(c.high, 8), low: sc(c.low, 8), close: sc(c.close, 8), price: sc(c.close, 4), adjusted_close: sc(c.adjusted_close, 8), volume: sc(c.volume, 0) })));
  for (const part of sliceRows(histRows)) {
    const r = await query(
      `INSERT INTO etf_history (id, etf_id, date, price, volume, open, high, low, close, adjusted_close, source, source_url, known_at)
       SELECT gen_random_uuid()::text, x.etf_id, x.date::date, x.price, x.volume, x.open, x.high, x.low, x.close, x.adjusted_close, 'YAHOO', x.source_url, $1::timestamptz
       FROM jsonb_to_recordset($2::jsonb) AS x(etf_id text, date text, open numeric, high numeric, low numeric, close numeric, price numeric, adjusted_close numeric, volume numeric, source_url text)
       ON CONFLICT (etf_id, date) DO UPDATE SET
         open = COALESCE(etf_history.open, EXCLUDED.open), high = COALESCE(etf_history.high, EXCLUDED.high),
         low = COALESCE(etf_history.low, EXCLUDED.low), close = COALESCE(etf_history.close, EXCLUDED.close),
         adjusted_close = COALESCE(etf_history.adjusted_close, EXCLUDED.adjusted_close),
         price = COALESCE(etf_history.price, EXCLUDED.price), volume = COALESCE(etf_history.volume, EXCLUDED.volume),
         source = COALESCE(etf_history.source, EXCLUDED.source), source_url = COALESCE(etf_history.source_url, EXCLUDED.source_url),
         known_at = GREATEST(etf_history.known_at, EXCLUDED.known_at)
       RETURNING etf_id`,
      [retrievedAt, JSON.stringify(part)],
    );
    for (const row of r) results.get(String(row.etf_id))!.rowsWritten++;
  }
  const okHist = payloads.filter((p) => p.history.ok);
  if (okHist.length) {
    await query(
      `UPDATE etfs e SET data_provider = 'yahoo-finance', data_source = t.sym, latest_price = COALESCE(t.close, e.latest_price),
         volume = COALESCE(t.vol, e.volume), price_updated_at = NOW(), updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS t(id text, sym text, close numeric, vol numeric) WHERE e.id = t.id`,
      [JSON.stringify(okHist.map((p) => ({ id: p.item.etfId, sym: p.item.symbol, close: sc(p.history.latestClose, 4), vol: sc(p.history.latestVolume, 0) })))],
    );
  }

  // ---- distribution events (dedupe/revision handled by the shared bulk writer) ----
  const eventRows = payloads.flatMap((p) => p.events);
  if (eventRows.length) await bulkUpsertEvents(query as any, eventRows);

  // ---- enrich: metadata, performance ----
  const plans = payloads.map((p) => p.enrich.plan).filter((x): x is EnrichPlan => !!x);
  const metaPlans = plans.filter((p) => p.metadataChanged > 0);
  if (metaPlans.length) {
    await query(
      `UPDATE etfs e SET
         name_en = COALESCE(t.name_en, e.name_en), category = COALESCE(t.category, e.category), currency = COALESCE(t.currency, e.currency),
         inception_date = COALESCE(to_timestamp(t.inception)::date, e.inception_date), latest_nav = COALESCE(t.nav, e.latest_nav),
         aum = COALESCE(t.aum, e.aum), expense_ratio = COALESCE(t.expense, e.expense_ratio), dividend_yield = COALESCE(t.yield, e.dividend_yield),
         beta = COALESCE(t.beta, e.beta), data_provider = 'yahoo-finance', updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS t(id text, name_en text, category text, currency text, inception double precision, nav numeric, aum numeric, expense numeric, yield numeric, beta numeric)
       WHERE e.id = t.id`,
      [JSON.stringify(metaPlans.map((p) => ({ id: p.etfId, name_en: p.meta?.nameEn ?? null, category: p.meta?.category ?? null, currency: p.meta?.currency ?? null, inception: p.meta?.inception ?? null, nav: sc(p.meta?.nav, 4), aum: sc(p.meta?.aum, 2), expense: sc(p.meta?.expense, 4), yield: sc(p.meta?.yield, 4), beta: sc(p.meta?.beta, 4) })))],
    );
  }
  const perfPlans = plans.filter((p) => p.performance);
  if (perfPlans.length) {
    const rows = JSON.stringify(perfPlans.map((p) => ({ etf_id: p.etfId, date: p.performance!.date, r1m: sc(p.performance!.r1m, 4), r3m: sc(p.performance!.r3m, 4), r6m: sc(p.performance!.r6m, 4), rytd: sc(p.performance!.rytd, 4), r1y: sc(p.performance!.r1y, 4), r3y: sc(p.performance!.r3y, 4), r5y: sc(p.performance!.r5y, 4) })));
    const spec = `AS x(etf_id text, date text, r1m numeric, r3m numeric, r6m numeric, rytd numeric, r1y numeric, r3y numeric, r5y numeric)`;
    await query(
      `INSERT INTO etf_performances (id, etf_id, date, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y, created_at)
       SELECT gen_random_uuid()::text, x.etf_id, x.date::date, x.r1m, x.r3m, x.r6m, x.rytd, x.r1y, x.r3y, x.r5y, NOW()
         FROM jsonb_to_recordset($1::jsonb) ${spec}
       ON CONFLICT (etf_id, date) DO UPDATE SET
         return_1m = COALESCE(EXCLUDED.return_1m, etf_performances.return_1m), return_3m = COALESCE(EXCLUDED.return_3m, etf_performances.return_3m),
         return_6m = COALESCE(EXCLUDED.return_6m, etf_performances.return_6m), return_ytd = COALESCE(EXCLUDED.return_ytd, etf_performances.return_ytd),
         return_1y = COALESCE(EXCLUDED.return_1y, etf_performances.return_1y), return_3y = COALESCE(EXCLUDED.return_3y, etf_performances.return_3y),
         return_5y = COALESCE(EXCLUDED.return_5y, etf_performances.return_5y)`,
      [rows],
    );
    await query(
      `UPDATE etfs e SET
         return_1m = COALESCE(x.r1m, e.return_1m), return_3m = COALESCE(x.r3m, e.return_3m), return_6m = COALESCE(x.r6m, e.return_6m),
         return_ytd = COALESCE(x.rytd, e.return_ytd), return_1y = COALESCE(x.r1y, e.return_1y), return_3y = COALESCE(x.r3y, e.return_3y),
         return_5y = COALESCE(x.r5y, e.return_5y), updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) ${spec} WHERE e.id = x.etf_id`,
      [rows],
    );
    for (const p of perfPlans) results.get(p.etfId)!.performanceWritten = 1;
  }

  // ---- holdings snapshots + rows ----
  const snapPlans = plans.filter((p) => p.snapshot);
  if (snapPlans.length) {
    const wanted = snapPlans.map((p) => ({ etf_id: p.etfId, rid: p.snapshot!.sourceRecordId }));
    const found = await query(
      `SELECT s.id::text AS id, s.etf_id, s.source_record_id FROM etf_holding_snapshots s
        JOIN unnest($1::text[], $2::text[]) AS w(etf_id, rid) ON w.etf_id = s.etf_id AND w.rid = s.source_record_id
       WHERE s.source = 'YAHOO_QUOTE_SUMMARY' AND s.effective_date IS NULL`,
      [wanted.map((w) => w.etf_id), wanted.map((w) => w.rid)],
    );
    const snapId = new Map<string, string>(found.map((r) => [`${r.etf_id}|${r.source_record_id}`, String(r.id)]));
    const missing = snapPlans.filter((p) => !snapId.has(`${p.etfId}|${p.snapshot!.sourceRecordId}`));
    if (missing.length) {
      const ins = await query(
        `INSERT INTO etf_holding_snapshots
           (id, etf_id, effective_date, report_date, source, source_type, source_url, source_record_id, retrieved_at,
            checksum, source_row_count, parsed_row_count, canonical_row_count, verification_status, license_status,
            completeness_status, quality_status, quality_metrics, parser_version, archive_lineage)
         SELECT gen_random_uuid(), x.etf_id, NULL, NULL, 'YAHOO_QUOTE_SUMMARY', 'PROVIDER_OBSERVATION', x.source_url, x.rid, x.retrieved_at::timestamptz,
                x.checksum, x.n, x.n, x.n, 'SOURCE_PARSED', 'TERMS_REVIEW_REQUIRED', 'TOP_HOLDINGS_ONLY', 'PARTIAL_DATE_UNKNOWN',
                x.quality::jsonb, 'yahoo-top-holdings-v2', x.lineage::jsonb
         FROM jsonb_to_recordset($1::jsonb) AS x(etf_id text, source_url text, rid text, retrieved_at text, checksum text, n int, quality text, lineage text)
         RETURNING id::text AS id, etf_id, source_record_id`,
        [JSON.stringify(missing.map((p) => ({ etf_id: p.etfId, source_url: p.snapshot!.srcUrl, rid: p.snapshot!.sourceRecordId, retrieved_at: p.snapshot!.retrievedAt, checksum: p.snapshot!.checksum, n: p.snapshot!.rowCount, quality: p.snapshot!.quality, lineage: p.snapshot!.lineage })))],
      );
      for (const r of ins) snapId.set(`${r.etf_id}|${r.source_record_id}`, String(r.id));
    }
    const holdRows = new Map<string, any>(); // later duplicate (same snapshot + row id) wins, like the sequential upserts
    for (const p of snapPlans) {
      const sid = snapId.get(`${p.etfId}|${p.snapshot!.sourceRecordId}`);
      if (!sid) continue;
      for (const h of p.holdings) holdRows.set(`${sid}|${h.rowId}`, { snapshot_id: sid, etf_id: p.etfId, holding_name: h.name, ticker: h.ticker, weight: sc(h.weight, 8), source_row_id: h.rowId, raw_row: h.raw });
    }
    for (const part of sliceRows([...holdRows.values()])) {
      await query(
        `INSERT INTO etf_holdings
           (id, snapshot_id, etf_id, effective_date, holding_type, holding_name, ticker, weight, source_row_id, verification_status, quality_status, raw_row)
         SELECT gen_random_uuid(), x.snapshot_id::uuid, x.etf_id, NULL, 'SECURITY', x.holding_name, x.ticker, x.weight, x.source_row_id, 'SOURCE_PARSED', 'PARTIAL_DATE_UNKNOWN', x.raw_row
         FROM jsonb_to_recordset($1::jsonb) AS x(snapshot_id text, etf_id text, holding_name text, ticker text, weight numeric, source_row_id text, raw_row jsonb)
         ON CONFLICT (snapshot_id, source_row_id) DO UPDATE SET
           holding_name = EXCLUDED.holding_name, ticker = EXCLUDED.ticker, weight = EXCLUDED.weight, raw_row = EXCLUDED.raw_row`,
        [JSON.stringify(part)],
      );
    }
    for (const p of snapPlans) results.get(p.etfId)!.holdingsWritten = p.holdings.length;
  }

  // ---- sector / credit allocations ----
  const alloc = async (table: "etf_sector_allocations" | "etf_credit_rating_allocations", col: "sector_name" | "credit_rating", pick: (p: EnrichPlan) => Array<{ name: string; weight: number }>, mark: (r: SweepItemResult, n: number) => void) => {
    const rows = new Map<string, any>();
    for (const p of plans) {
      const items = pick(p);
      if (!items.length) continue;
      for (const s of items) rows.set(`${p.etfId}|${p.observationDate}|${s.name}`, { etf_id: p.etfId, d: p.observationDate, name: s.name, weight: sc(s.weight, 8), source_url: p.srcUrl, retrieved_at: p.retrievedAt });
      mark(results.get(p.etfId)!, items.length);
    }
    for (const part of sliceRows([...rows.values()])) {
      await query(
        `INSERT INTO ${table} (id, etf_id, observation_date, ${col}, weight, source, source_url, retrieved_at, created_at, updated_at)
         SELECT gen_random_uuid(), x.etf_id, x.d::date, x.name, x.weight, 'YAHOO_QUOTE_SUMMARY', x.source_url, x.retrieved_at::timestamptz, NOW(), NOW()
         FROM jsonb_to_recordset($1::jsonb) AS x(etf_id text, d text, name text, weight numeric, source_url text, retrieved_at text)
         ON CONFLICT (etf_id, observation_date, source, ${col}) DO UPDATE SET
           weight = EXCLUDED.weight, source_url = EXCLUDED.source_url, retrieved_at = EXCLUDED.retrieved_at, updated_at = NOW()`,
        [JSON.stringify(part)],
      );
    }
  };
  await alloc("etf_sector_allocations", "sector_name", (p) => p.sectors, (r, n) => { r.sectorAllocWritten = n; });
  await alloc("etf_credit_rating_allocations", "credit_rating", (p) => p.ratings, (r, n) => { r.creditAllocWritten = n; });
  return [...results.values()];
}
