// Task X6 Part B: the per-etf resolveWriteDate + writeEtfsRankingColumns sequence (3 sequential DB
// round-trips per etf) was live-measured to cost ~2.5s/etf in production, cutting throughput from
// ~460 etfs/run down to ~53 and causing the SKIP_NO_PERF backfill's unbounded version of this same
// pattern to blow a 300s Vercel function timeout entirely. Every function here takes a batch of
// etfIds/entries and does the work in ONE query regardless of batch size, instead of one query per
// item — moved to its own module (not app/api/cron/etf-returns-sync/route.ts) so it's unit-testable
// without pulling in Next.js/Prisma imports, same pattern as parseReturns.ts and completion.ts.
import type { TrailingReturns } from "./types";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

/** Task X5 Part B (date alignment): resolves, for each etfId, the most recent etf_performances.date
 * within `cutoffIso`..now (so a fresh write merges onto cloud-etf-price's existing row instead of
 * orphaning its return_1d/return_6m at a newer date) — one GROUP BY query for the whole batch. An
 * etfId absent from the result has no recent row; the caller falls back to `today`. */
export async function resolveWriteDatesBatch(query: QueryFn, etfIds: string[], cutoffIso: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (etfIds.length === 0) return map;
  const rows = await query(
    `SELECT etf_id, max(date)::text AS d FROM etf_performances WHERE etf_id = ANY($1::text[]) AND date >= $2::date GROUP BY etf_id`,
    [etfIds, cutoffIso],
  );
  for (const r of rows) map.set(r.etf_id, r.d);
  return map;
}

/** Task X6 Part C.2: etfs.return_6m is synced from whatever etf_performances' own latest row for
 * that etf currently holds (computed by cloud-etf-price, the column's sole owner) — never
 * self-computed here. One DISTINCT ON query for the whole batch. An etfId absent from the result (no
 * etf_performances row at all yet) should be treated as null by the caller. */
export async function fetchLatestReturn6mBatch(query: QueryFn, etfIds: string[]): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (etfIds.length === 0) return map;
  const rows = await query(
    `SELECT DISTINCT ON (etf_id) etf_id, return_6m::text AS r6m FROM etf_performances WHERE etf_id = ANY($1::text[]) ORDER BY etf_id, date DESC`,
    [etfIds],
  );
  for (const r of rows) map.set(r.etf_id, r.r6m === null ? null : Number(r.r6m));
  return map;
}

export type LongPeriodReturns = { rytd: number | null; r1y: number | null; r3y: number | null; r5y: number | null };

/** 2026-11-09（模擬器實測第2項，使用者核准定案）: 00674R/00635U/00708L 這次回報的黃金商品反查
 * 績效錯亂（如00674R近1年顯示+367%、今年以來全部顯示—%），查到是Yahoo奇摩performance頁某次
 * 擷取回傳了跟前一天差異極端的髒資料（不是我們自己的sign/parse邏輯錯——重新即時比對奇摩頁面，
 * 跟前幾天正常值的方向、量級一致），寫入時沒有任何防呆就直接覆蓋掉了原本正確的數字。這支函式
 * 批次撈每個etf最近一筆的ytd/1y/3y/5y，讓route.ts在寫入前能跟新抓到的值比對，擋掉這類異常跳動
 * 的髒資料（isImplausibleReturnJump）。 */
export async function fetchLatestLongPeriodReturnsBatch(query: QueryFn, etfIds: string[]): Promise<Map<string, LongPeriodReturns>> {
  const map = new Map<string, LongPeriodReturns>();
  if (etfIds.length === 0) return map;
  const rows = await query(
    `SELECT DISTINCT ON (etf_id) etf_id,
       return_ytd::text AS rytd, return_1y::text AS r1y, return_3y::text AS r3y, return_5y::text AS r5y
     FROM etf_performances WHERE etf_id = ANY($1::text[]) ORDER BY etf_id, date DESC`,
    [etfIds],
  );
  for (const r of rows) {
    map.set(r.etf_id, {
      rytd: r.rytd === null ? null : Number(r.rytd),
      r1y: r.r1y === null ? null : Number(r.r1y),
      r3y: r.r3y === null ? null : Number(r.r3y),
      r5y: r.r5y === null ? null : Number(r.r5y),
    });
  }
  return map;
}

// 單日合理波動遠不可能達到的絕對落差（百分點）——1年/3年/5年期報酬率一天之內變動超過這個數字，
// 幾乎一定是上游資料異常（如Yahoo奇摩那一次性的髒擷取），不是真正的市場變化（2026-11-09事故：
// 00674R近1年從-6.35%一天內跳到+367.03%，落差373個百分點；00708L近3年從37.37%跳到174.09%，
// 落差137個百分點）。
export const MAX_PLAUSIBLE_RETURN_JUMP_PP = 100;

/** 純函式（可單元測試）：prev為null（還沒有歷史資料可比對）一律放行，避免擋住第一次寫入。
 * 2026-11-09事故本身也包含「昨天有值、今天整批全部變成null」這種退化（今年以來全部顯示—%）——
 * prev有值但next變成null一樣視為異常，不能只檢查兩個都有值時的落差。 */
export function isImplausibleReturnJump(prev: number | null, next: number | null): boolean {
  if (prev === null) return false;
  if (next === null) return true;
  return Math.abs(next - prev) > MAX_PLAUSIBLE_RETURN_JUMP_PP;
}

/** 整組 TrailingReturns 一起檢查 ytd/1y/3y/5y 四個長週期欄位，任何一個跳太多就整筆視為異常。 */
export function longPeriodReturnsLookImplausible(prev: LongPeriodReturns | undefined, next: { rytd: number | null; r1y: number | null; r3y: number | null; r5y: number | null }): boolean {
  if (!prev) return false;
  return (
    isImplausibleReturnJump(prev.rytd, next.rytd) ||
    isImplausibleReturnJump(prev.r1y, next.r1y) ||
    isImplausibleReturnJump(prev.r3y, next.r3y) ||
    isImplausibleReturnJump(prev.r5y, next.r5y)
  );
}

export type EtfsRankingEntry = { etfId: string; returns: TrailingReturns; return6mSync: number | null };

/** Task X6 Part C.1 (user-approved): a DIRECT overwrite (including null) of the six Yahoo-sourced
 * `etfs` columns — not COALESCE. COALESCE can never clear an old placeholder-0 a prior pipeline
 * already wrote (VERIFIED live: 3,840-8,541 exact-zero rows across these columns), the same
 * Yahoo-0-placeholder bug this whole task started from, just on a second table. return_6m is passed
 * in pre-resolved (via fetchLatestReturn6mBatch) rather than taken from `returns`, since Yahoo's
 * trailingReturns has no 6-month figure at all. One UPDATE...FROM jsonb_to_recordset for the whole
 * batch, same shape as returnsWriter.ts's writeReturnsBatch. */
export async function writeEtfsRankingColumnsBatch(query: QueryFn, entries: EtfsRankingEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const payload = entries.map((e) => ({
    etf_id: e.etfId, return_1m: e.returns.r1m, return_3m: e.returns.r3m, return_6m: e.return6mSync,
    return_ytd: e.returns.rytd, return_1y: e.returns.r1y, return_3y: e.returns.r3y, return_5y: e.returns.r5y,
  }));
  try {
    await query(
      `UPDATE etfs AS e SET
         return_1m = x.return_1m, return_3m = x.return_3m, return_6m = x.return_6m,
         return_ytd = x.return_ytd, return_1y = x.return_1y, return_3y = x.return_3y, return_5y = x.return_5y,
         updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         etf_id text, return_1m numeric, return_3m numeric, return_6m numeric,
         return_ytd numeric, return_1y numeric, return_3y numeric, return_5y numeric
       )
       WHERE e.id = x.etf_id`,
      [JSON.stringify(payload)],
    );
  } catch { /* ranking-column refresh is best-effort; never block the main return_* sweep */ }
}
