// Yahoo ETF price history — v8 chart (no crumb) -> etf_history upsert (etf_id,date) + etfs latest.
// Incremental: if history exists, fetch since last_date - 5 trading-day overlap; else full inception.
// COALESCE upsert = stale/duplicate rows never overwrite a good value; unique (etf_id,date).
// SQL mirrors scripts/data/etf-yahoo/run-etf-yahoo-full-universe.ts.

import { fetchChartFull } from "./productSession";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type EtfHistoryResult = {
  etfId: string; symbol: string; ok: boolean;
  rowsWritten: number; distributionEvents: number; latestDate: string | null; firstDate: string | null; error?: string;
};

export async function ingestEtfHistory(
  query: QueryFn,
  input: { etfId: string; symbol: string },
): Promise<EtfHistoryResult> {
  const out: EtfHistoryResult = { etfId: input.etfId, symbol: input.symbol, ok: false, rowsWritten: 0, distributionEvents: 0, latestDate: null, firstDate: null };
  const last = await query(`SELECT max(date)::text d, count(*)::int n FROM etf_history WHERE etf_id = $1`, [input.etfId]);
  const lastDate: string | null = last[0]?.d ?? null;
  const hasHistory = Number(last[0]?.n ?? 0) > 0;
  const period1 = hasHistory && lastDate ? Math.floor((Date.parse(lastDate) - 5 * 86_400_000) / 1000) : 0;

  const chart = await fetchChartFull(input.symbol, { period1 });
  if (!chart) { out.error = "NO_CHART"; return out; }
  const valid = chart.candles.filter(
    (c) => [c.open, c.high, c.low, c.close].every((v) => Number.isFinite(v as number)) && (c.high as number) >= (c.low as number) && (c.close as number) > 0,
  );
  if (!valid.length) { out.error = "NO_VALID_CANDLES"; return out; }
  out.firstDate = valid[0].date;
  out.latestDate = valid[valid.length - 1].date;

  const sourceUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(input.symbol)}?period1=${period1}&interval=1d&events=div%2Csplit`;
  const retrievedAt = new Date().toISOString();
  for (let i = 0; i < valid.length; i += 500) {
    const chunk = valid.slice(i, i + 500).map((c) => ({
      date: c.date, open: c.open, high: c.high, low: c.low, close: c.close,
      adjusted_close: Number.isFinite(c.adjClose as number) ? c.adjClose : null, volume: c.volume,
    }));
    const r = await query(
      `INSERT INTO etf_history (id, etf_id, date, price, volume, open, high, low, close, adjusted_close, source, source_url, known_at)
       SELECT gen_random_uuid()::text, $1, x.date::date, x.close, x.volume, x.open, x.high, x.low, x.close, x.adjusted_close, 'YAHOO', $2, $3::timestamptz
       FROM jsonb_to_recordset($4::jsonb) AS x(date text, open numeric, high numeric, low numeric, close numeric, adjusted_close numeric, volume numeric)
       ON CONFLICT (etf_id, date) DO UPDATE SET
         open = COALESCE(etf_history.open, EXCLUDED.open), high = COALESCE(etf_history.high, EXCLUDED.high),
         low = COALESCE(etf_history.low, EXCLUDED.low), close = COALESCE(etf_history.close, EXCLUDED.close),
         adjusted_close = COALESCE(etf_history.adjusted_close, EXCLUDED.adjusted_close),
         price = COALESCE(etf_history.price, EXCLUDED.price), volume = COALESCE(etf_history.volume, EXCLUDED.volume),
         source = COALESCE(etf_history.source, EXCLUDED.source), source_url = COALESCE(etf_history.source_url, EXCLUDED.source_url),
         known_at = GREATEST(etf_history.known_at, EXCLUDED.known_at)
       RETURNING 1`,
      [input.etfId, sourceUrl, retrievedAt, JSON.stringify(chunk)],
    );
    out.rowsWritten += r.length;
  }
  const lastC = valid[valid.length - 1];
  await query(
    `UPDATE etfs SET data_provider = 'yahoo-finance', data_source = $2, latest_price = COALESCE($3, latest_price),
       volume = COALESCE($4, volume), price_updated_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [input.etfId, input.symbol, lastC.close, lastC.volume],
  );

  // Distribution events -> etf_distribution_events (reused table; existing rows there are
  // 'ISHARES_OFFICIAL_PRODUCT_DISTRIBUTIONS' for a handful of ETFs — this adds a 'YAHOO_CHART' source
  // for every ETF the sweep touches, additive only, never overwriting the higher-quality official rows
  // (different `source` values coexist under the same UNIQUE(etf_id,share_class_id,ex_date,source,
  // source_record_id) key). Wrapped separately so a write hiccup here can't erase the price-history
  // credit above (same write-isolation lesson as the enrich-reliability fix).
  try {
    if (chart.dividends.length) {
      for (const d of chart.dividends) {
        if (!(d.amount > 0) || !d.date) continue;
        await query(
          `INSERT INTO etf_distribution_events
             (id, etf_id, share_class_id, ex_date, effective_date, amount, currency, source, source_record_id, verification_status, imported_at, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, 'PRIMARY', $2::date, $2::date, $3, $4, 'YAHOO_CHART', $5, 'SOURCE_PARSED', NOW(), NOW(), NOW())
           ON CONFLICT (etf_id, share_class_id, ex_date, source, source_record_id) DO NOTHING`,
          [input.etfId, d.date, d.amount, chart.currency ?? "USD", `YAHOO:${input.symbol}:${d.date}`],
        );
      }
    }
  } catch { /* distribution write is best-effort; price history above already succeeded */ }

  out.distributionEvents = chart.dividends.length;
  out.ok = true;
  return out;
}
