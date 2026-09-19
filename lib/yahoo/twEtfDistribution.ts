// Taiwan ETF distribution pipeline helpers (no DB access except through the passed `query`).
//
//  * The Taiwan universe is derived from etfs metadata — never a hard-coded symbol list.
//  * Yahoo symbols are derived from metadata (data_source when already suffixed, otherwise code + .TW/.TWO).
//  * Future ex-dates come from the two OFFICIAL exchange announcement tables (one HTTP call each, all
//    listed securities at once): TWSE 除權除息預告表 and TPEx 除權息預告. Nothing is projected or estimated.

export type Query = (sql: string, params: unknown[]) => Promise<any[]>;

/** SQL predicate (alias `e`) selecting Taiwan-listed ETFs from production metadata. */
export const TW_UNIVERSE_SQL = `(e.region = 'TW' OR e.exchange IN ('TWSE','TPEx','Taiwan','TaipeiExchange') OR e.data_source ~ '\\.TWO?$')`;

export type EtfRef = { id: string; code: string; data_source: string | null; exchange: string | null };

export function yahooSymbolFor(e: Pick<EtfRef, "code" | "data_source" | "exchange">): string {
  if (e.data_source && /\.TWO?$/i.test(e.data_source)) return e.data_source.toUpperCase();
  return `${e.code}${e.exchange && /tpex|otc|gretai/i.test(e.exchange) ? ".TWO" : ".TW"}`;
}

// ---------------- official announcement tables ----------------

export type ExDateNotice = { source: "TWSE_EX_DIVIDEND_NOTICE" | "TPEX_EX_DIVIDEND_NOTICE"; code: string; exDate: string; cashDividend: number };

/** ROC date → ISO. Accepts "115年09月21日", "115/09/21", "1150921". Returns null when malformed. */
export function rocToIso(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const m = s.match(/^(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})\D*$/) ?? s.match(/^(\d{3})(\d{2})(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]) + 1911, mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const cash = (v: unknown): number | null => {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null; // "待公告實際收益分配金額" / 0 => amount not announced => not stored
};

/** TWSE TWT48U: data rows are [exDate, code, name, type(權/息/權息), …, cashDividend, …]. Only announced cash amounts are kept. */
export function parseTwseNotice(json: any): ExDateNotice[] {
  const out: ExDateNotice[] = [];
  for (const r of json?.data ?? []) {
    const exDate = rocToIso(r?.[0]);
    const amount = cash(r?.[7]);
    const type = String(r?.[3] ?? "");
    if (!exDate || amount == null || !/息/.test(type) || !r?.[1]) continue;
    out.push({ source: "TWSE_EX_DIVIDEND_NOTICE", code: String(r[1]).trim(), exDate, cashDividend: amount });
  }
  return out;
}

/** TPEx prepost_result: tables[0].data rows are [exDate, code, name, type(除權/除息/權息), …, cashDividend, …]. */
export function parseTpexNotice(json: any): ExDateNotice[] {
  const out: ExDateNotice[] = [];
  for (const r of json?.tables?.[0]?.data ?? []) {
    const exDate = rocToIso(r?.[0]);
    const amount = cash(r?.[7]);
    const type = String(r?.[3] ?? "");
    if (!exDate || amount == null || !/息/.test(type) || !r?.[1]) continue;
    out.push({ source: "TPEX_EX_DIVIDEND_NOTICE", code: String(r[1]).trim(), exDate, cashDividend: amount });
  }
  return out;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export async function fetchNoticeTable(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
export const TWSE_NOTICE_URL = "https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json";
export const TPEX_NOTICE_URL = "https://www.tpex.org.tw/web/stock/exright/preAnnounce/prepost_result.php?l=zh-tw&o=json";

// ---------------- bulk writes ----------------

export type EventRow = { etfId: string; exDate: string; amount: number; currency: string; source: string; sourceRecordId: string };

/** One statement per chunk (unnest). Insert new; update amount only when the source revised it. Returns counts. */
export async function bulkUpsertEvents(query: Query, rows: EventRow[], chunk = 1500): Promise<{ inserted: number; updated: number }> {
  let inserted = 0, updated = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const res = await query(
      `INSERT INTO etf_distribution_events
         (id, etf_id, share_class_id, ex_date, effective_date, amount, currency, source, source_record_id, verification_status, imported_at, created_at, updated_at)
       SELECT gen_random_uuid(), t.etf_id, 'PRIMARY', t.ex_date::date, t.ex_date::date, t.amount::numeric, t.currency, t.source, t.rid, 'SOURCE_PARSED', NOW(), NOW(), NOW()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS t(etf_id, ex_date, amount, currency, source, rid)
       ON CONFLICT (etf_id, share_class_id, ex_date, source, source_record_id)
       DO UPDATE SET amount = EXCLUDED.amount, updated_at = NOW()
         WHERE ABS(etf_distribution_events.amount - EXCLUDED.amount) > 0.00001
       RETURNING (xmax = 0) AS inserted`,
      [part.map((r) => r.etfId), part.map((r) => r.exDate), part.map((r) => String(r.amount)), part.map((r) => r.currency), part.map((r) => r.source), part.map((r) => r.sourceRecordId)],
    );
    for (const r of res) (r.inserted ? inserted++ : updated++);
  }
  return { inserted, updated };
}

/**
 * Upcoming ex-dates from the two official tables → etf_distribution_events (only ETFs in the DB Taiwan universe).
 * Rows that dropped out of the current table while still in the future (date revised/cancelled) are removed —
 * limited to these two notice sources, and only when the table itself was fetched successfully.
 */
export async function syncTwUpcomingExDates(query: Query) {
  const [twse, tpex] = await Promise.all([fetchNoticeTable(TWSE_NOTICE_URL), fetchNoticeTable(TPEX_NOTICE_URL)]);
  const universe = await query(`SELECT e.id::text id, e.code FROM etfs e WHERE e.is_active = true AND ${TW_UNIVERSE_SQL}`, []);
  const idByCode = new Map<string, string>(universe.map((u) => [String(u.code), String(u.id)]));
  const result = { twse_fetched: twse != null, tpex_fetched: tpex != null, notices_total: 0, notices_in_universe: 0, inserted: 0, updated: 0, removed_stale: 0 };
  const fetched: Array<[ExDateNotice["source"], ExDateNotice[] | null]> = [
    ["TWSE_EX_DIVIDEND_NOTICE", twse ? parseTwseNotice(twse) : null],
    ["TPEX_EX_DIVIDEND_NOTICE", tpex ? parseTpexNotice(tpex) : null],
  ];
  const rows: EventRow[] = [];
  for (const [source, notices] of fetched) {
    if (!notices) continue;
    result.notices_total += notices.length;
    const keep: string[] = [];
    for (const n of notices) {
      const etfId = idByCode.get(n.code);
      if (!etfId) continue;
      result.notices_in_universe++;
      const rid = `${source}:${n.code}:${n.exDate}`;
      keep.push(rid);
      rows.push({ etfId, exDate: n.exDate, amount: n.cashDividend, currency: "TWD", source, sourceRecordId: rid });
    }
    const del = await query(
      `DELETE FROM etf_distribution_events WHERE source = $1 AND ex_date >= CURRENT_DATE AND NOT (source_record_id = ANY($2::text[])) RETURNING 1`,
      [source, keep],
    );
    result.removed_stale += del.length;
  }
  const w = await bulkUpsertEvents(query, rows);
  result.inserted = w.inserted;
  result.updated = w.updated;
  return result;
}

/** Unified TW progress (single pipeline, DB-derived; no per-symbol state). */
export async function twProgress(query: Query) {
  const r = (
    await query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE e.distribution_checked_at IS NOT NULL)::int AS checked,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM etf_distribution_events d WHERE d.etf_id = e.id::text AND d.source = 'YAHOO_CHART'))::int AS with_history,
              count(*) FILTER (WHERE e.distribution_checked_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM etf_distribution_events d WHERE d.etf_id = e.id::text))::int AS empty,
              count(*) FILTER (WHERE e.distribution_checked_at IS NULL)::int AS pending
         FROM etfs e WHERE e.is_active = true AND ${TW_UNIVERSE_SQL}`,
      [],
    )
  )[0];
  return { TW_ETF_TOTAL: r.total, TW_ETF_CHECKED: r.checked, TW_ETF_WITH_HISTORY: r.with_history, TW_ETF_EMPTY: r.empty, TW_ETF_PENDING: r.pending };
}

/** Taiwan ETF sector coverage (aggregate only). COVERED = a snapshot whose sector weights sum to > 0. */
export async function twSectorProgress(query: Query) {
  const r = (
    await query(
      `WITH tw AS (SELECT e.id::text AS id FROM etfs e WHERE e.is_active = true AND ${TW_UNIVERSE_SQL}),
            cov AS (SELECT a.etf_id, max(a.retrieved_at) AS last FROM etf_sector_allocations a JOIN tw ON tw.id = a.etf_id GROUP BY a.etf_id HAVING sum(a.weight) > 0)
       SELECT (SELECT count(*)::int FROM tw) AS total, (SELECT count(*)::int FROM cov) AS covered, (SELECT max(last) FROM cov) AS last_sweep`,
      [],
    )
  )[0];
  return { TW_ETF_SECTOR_TOTAL: r.total, TW_ETF_SECTOR_COVERED: r.covered, TW_ETF_SECTOR_UNCOVERED: r.total - r.covered, TW_ETF_SECTOR_LAST_SWEEP: r.last_sweep };
}
