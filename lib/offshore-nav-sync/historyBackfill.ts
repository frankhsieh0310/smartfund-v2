// One-time (per fund) historical NAV catch-up via the same Yahoo FundServices.fundsPriceHistory API
// navFetch.ts already uses for the daily top-up — confirmed live (2026-10-31) that a single request
// with a wide `timeslot` returns the fund's FULL available history in one call (no pagination needed):
// a fund with real history back to 2016 returned 2,535 points for one 10-year-wide request. So this
// module makes exactly one request per fund, asking for [max(inceptionDate, now-5y), now], and writes
// every (date, nav) point the source actually returns — never the execution date, always the
// source's own date array.
//
// Tracked via its own completed-fundIds checkpoint (never re-attempts a fund that already got its
// one-time catch-up; the daily nav-sync/TDCC-sync writers keep it current after that) — same
// production_scheduler_checkpoints table, no new table, same JSON-blob pattern as knownNoData.ts.
import { RateLimitedError } from "./navFetch";

export const BACKFILL_DONE_CHECKPOINT_KEY = "offshore-nav-sync:backfill-done-fund-ids";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type HistoryPoint = { date: string; nav: number };

export async function loadBackfillDone(query: QueryFn): Promise<Set<string>> {
  const rows = await query(`SELECT last_symbol FROM production_scheduler_checkpoints WHERE checkpoint_key = $1 LIMIT 1`, [BACKFILL_DONE_CHECKPOINT_KEY]);
  const raw = rows[0]?.last_symbol;
  if (!raw) return new Set();
  try {
    const parsed: string[] = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

export async function saveBackfillDone(query: QueryFn, done: Set<string>): Promise<void> {
  const payload = JSON.stringify([...done]);
  await query(
    `INSERT INTO production_scheduler_checkpoints (checkpoint_key, job_id, run_id, last_symbol, processed, succeeded, failed, started_at, updated_at, run_type)
     VALUES ($1, 'OFFSHORE_NAV_SYNC', gen_random_uuid()::text, $2, $3, 0, 0, now(), now(), 'CRON')
     ON CONFLICT (checkpoint_key) DO UPDATE SET last_symbol = EXCLUDED.last_symbol, processed = EXCLUDED.processed, updated_at = now()`,
    [BACKFILL_DONE_CHECKPOINT_KEY, payload, done.size],
  );
}

/** Fetches a fund's full NAV history over [fromDate, toDate] in one request. Returns every
 * (date, nav) point the source gives, sorted ascending by date — never synthesized, never
 * deduplicated against what we already have (the caller's upsert handles that). Throws
 * RateLimitedError on 401/403/429 so the caller can stop the whole backfill pass immediately. */
export async function fetchOffshoreNavHistoryRange(yahooFundId: string, fromDate: Date, toDate: Date): Promise<HistoryPoint[] | null> {
  const timeslot = `${fromDate.toISOString().slice(0, 19)}Z-${toDate.toISOString().slice(0, 19)}Z`;
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsPriceHistory;fundId=${encodeURIComponent(yahooFundId)};timeslot=${encodeURIComponent(timeslot)}?intl=tw&lang=zh-Hant-TW&region=TW&site=finance&device=desktop&returnMeta=true`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new RateLimitedError(res.status);
  if (!res.ok) throw new Error(`YAHOO_HTTP_${res.status}`);
  const json: any = await res.json();
  const closePricesRaw: unknown[] | undefined = json?.closePrices ?? json?.data?.closePrices;
  const dates: string[] | undefined = json?.dates ?? json?.data?.dates;
  if (!Array.isArray(closePricesRaw) || !Array.isArray(dates) || closePricesRaw.length === 0) return null;

  const points: HistoryPoint[] = [];
  for (let i = 0; i < dates.length; i++) {
    const nav = Number(closePricesRaw[i]);
    const dateRaw = dates[i];
    if (!Number.isFinite(nav) || nav <= 0 || !dateRaw) continue;
    const date = String(dateRaw).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    points.push({ date, nav });
  }
  points.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return points.length ? points : null;
}

export type QueryFnWrite = (sql: string, params: any[]) => Promise<any[]>;

/** Upserts every point into fund_history using the SOURCE's own date for each row — never the
 * ingestion clock. Does not touch funds.latest_nav/latest_nav_date: the daily nav-sync writers
 * already own that, and this one-time catch-up must never race or disagree with them. */
export async function writeBackfillHistory(query: QueryFnWrite, fundId: string, points: HistoryPoint[], nowIso: string): Promise<number> {
  if (points.length === 0) return 0;
  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < points.length; i += CHUNK) {
    const chunk = points.slice(i, i + CHUNK);
    const result = await query(
      `INSERT INTO fund_history (id, fund_id, date, nav, created_at)
       SELECT gen_random_uuid()::text, $1::text, x.date::date, x.nav, $3::timestamptz
       FROM jsonb_to_recordset($2::jsonb) AS x(date text, nav numeric)
       ON CONFLICT (fund_id, date) DO UPDATE SET nav = EXCLUDED.nav
       WHERE fund_history.nav IS DISTINCT FROM EXCLUDED.nav
       RETURNING 1`,
      [fundId, JSON.stringify(chunk), nowIso],
    );
    written += result.length;
  }
  return written;
}

export { RateLimitedError };
