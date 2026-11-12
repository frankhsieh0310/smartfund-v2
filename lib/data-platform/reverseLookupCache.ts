// 2026-11-12（使用者核准定案，反查效能）: 反查單一股票（最常見的情境——currentReverseHoldings
// 自己的註解就寫「只選1檔...退化成純weight排序」）在熱門股（例如輝達，599檔ETF+269檔基金持有）
// 第一次查詢時會撞到Postgres冷頁快取，EXPLAIN ANALYZE實測過etf_performances那段DISTINCT ON
// 掃描光是讀556個未快取分頁就要1.3秒，是整支查詢（量到2.3~3.6秒）裡最大的一塊。跟技術選股的
// screener_preset_cache（lib/screener/presetCache.ts）同一套做法：只快取「單一股票、預設排序/
// 篩選」這一種最常見的查詢形狀（market=''、type=ALL、sort=weight_desc、category=ALL、
// page=1、limit=50），其他排序/篩選組合不快取、照舊即時查詢——跟screener_preset_cache一樣，
// 快取未命中永遠退回原本的即時查詢路徑，不會因為快取本身的問題擋住反查功能。
//
// 防清空保護（使用者核准定案）：新計算出來的筆數比舊快取筆數少一半以上就不覆蓋，保留舊資料、
// 回報異常——避免reverse_current_positions暫時資料不全（例如排程正在中途更新）時，刷新快取
// 反而把一份完整的舊結果換成一份不完整的新結果。
//
// 需要使用者先手動執行一次schema變更（這支模組本身不會、也不該自己對production跑DDL）：
//   CREATE TABLE IF NOT EXISTS reverse_single_ticker_cache (
//     ticker TEXT PRIMARY KEY,
//     computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
//     row_count INT NOT NULL,
//     result JSONB NOT NULL
//   );
import { prisma } from "@/lib/prisma";
import { currentReverseHoldings } from "@/lib/data-platform/reverseIndex";
import type { Query } from "@/lib/data-platform/reverseHoldings";

const CACHE_FRESHNESS_MS = 24 * 60 * 60 * 1000; // 跟screener_preset_cache同一個新鮮度窗口
const ANOMALY_SHRINK_RATIO = 0.5; // 新筆數 < 舊筆數 * 此比例 → 視為異常，不覆蓋

function isDefaultShape(input: { market?: string; type?: string; sort?: string; category?: string; page?: number; limit?: number; direction?: string }): boolean {
  return (!input.market || input.market === "") && (input.type ?? "ALL") === "ALL" && (input.sort ?? "weight_desc") === "weight_desc" && (input.category ?? "ALL") === "ALL" && (input.page ?? 1) === 1 && (input.limit ?? 50) === 50 && !input.direction;
}

const dbQuery: Query = async <T>(sql: string, ...values: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...values);

// 2026-11-12 使用者回報核實（台積電/輝達反查仍要20秒/14秒）: 快取表的鍵是
// reverse_current_securities.ticker（帶交易所字尾，例如"2330.TW"），但使用者實際輸入/App
// 傳進來的是裸代號（"2330"、"NVDA"）——跟currentReverseHoldings()自己查詢時「s.ticker=輸入
// OR s.bare=輸入」的解析邏輯不一樣，快取查詢完全沒做這層轉換，裸代號永遠對不到帶字尾的快取
// 鍵，等於快取形同沒接上。這裡先用同一個優先序（完整ticker命中優先於bare命中，命中剛好1筆
// 才採用，跟currentReverseHoldings的dense_rank/invalid判斷同一套規則，避免裸代號在多國都有
// 掛牌時誤配到錯的那一個）把輸入解析成canonical ticker，再拿canonical ticker去查快取表。
// market跟即時查詢的input.market同一個語意（country篩選，空字串=不篩選）——同一個裸代號在不同
// 國家掛牌（例如"2330"同時是台積電TW跟某日股.T）時，即時查詢靠這個參數排除掉非目標國家的那個，
// 快取查詢不帶這個參數會把本來能解析的請求誤判成「有2筆、無法判斷」而永遠cache miss，所以這裡
// 一定要跟呼叫端拿到的market一起傳進來，跟currentReverseHoldings()的篩選邏輯保持一致。
async function resolveCanonicalTicker(rawTicker: string, market: string): Promise<string | null> {
  const requested = rawTicker.trim().toUpperCase();
  if (!requested) return null;
  const rows = await prisma.$queryRawUnsafe<Array<{ ticker: string }>>(
    `SELECT ticker FROM reverse_current_securities
      WHERE (ticker = $1 OR bare = $1) AND ($2 = '' OR country = $2)
      ORDER BY (ticker = $1) DESC
      LIMIT 2`,
    requested, market,
  );
  if (rows.length === 0) return null;
  // 完全命中ticker優先；否則只有剛好1筆bare命中才算（多筆代表跨國同代號且market沒有篩掉，
  // 交給即時查詢走UNRESOLVED_OR_AMBIGUOUS_SECURITY既有的錯誤處理，快取這裡不猜）。
  if (rows[0].ticker === requested) return rows[0].ticker;
  return rows.length === 1 ? rows[0].ticker : null;
}

export async function getCachedReverseLookup(ticker: string, input: { market?: string; type?: string; sort?: string; category?: string; page?: number; limit?: number; direction?: string }): Promise<unknown | null> {
  if (!isDefaultShape(input)) return null;
  try {
    const canonicalTicker = await resolveCanonicalTicker(ticker, input.market ?? "");
    if (!canonicalTicker) return null;
    const rows = await prisma.$queryRawUnsafe<Array<{ computed_at: Date; result: unknown }>>(
      `SELECT computed_at, result FROM reverse_single_ticker_cache WHERE ticker = $1`,
      canonicalTicker,
    );
    const row = rows[0];
    if (!row) return null;
    if (Date.now() - row.computed_at.getTime() > CACHE_FRESHNESS_MS) return null;
    return row.result;
  } catch {
    // 快取表讀取失敗（例如還沒部署這張表）一律視為cache miss，照舊即時查詢，絕不讓快取本身的
    // 問題擋住反查功能。
    return null;
  }
}

export type RefreshBatchResult = {
  processed: number; updated: number; anomalySkipped: Array<{ ticker: string; oldCount: number; newCount: number }>; failed: Array<{ ticker: string; error: string }>; lastTicker: string | null; done: boolean;
};

/** 由既有排程（跟screener_preset_cache一樣的best-effort附加步驟）呼叫，批次刷新「有實際反查資料」
 * 的股票（reverse_current_positions裡出現過的stock_id），用checkpoint游標跨invocation接續。
 * 任何一步失敗只記錄、不往外丟，絕不影響呼叫端排程本來的主要工作。 */
// 2026-11-12 使用者回報核實：原本按ticker字母序爬，500筆/天的批量要爬很久才會輪到"NVDA"這種
// 字母開頭、數字字尾代號排序又靠後的熱門股——使用者明確要求「預先算好熱門股票」。改成依
// reverse_current_positions目前的持有筆數（越多ETF/基金持有=越熱門，跟"台股/美股前200大"同一
// 個直覺，且不需要另外維護一份人氣清單）由多到少排，游標改存「holder_count:ticker」組合字串，
// 保持對外參數仍是單一字串（呼叫端checkpoint格式不用改）。
function encodeCursor(holderCount: number, ticker: string): string {
  return `${holderCount}:${ticker}`;
}
function decodeCursor(cursor: string | null): { holderCount: number; ticker: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf(":");
  if (i < 0) return null; // 舊格式（純ticker）游標：當作從頭開始重爬一輪，安全退回，不報錯
  const holderCount = Number(cursor.slice(0, i));
  if (!Number.isFinite(holderCount)) return null;
  return { holderCount, ticker: cursor.slice(i + 1) };
}

export async function refreshReverseLookupCacheBatch(afterTicker: string | null, limit: number, timeBudgetMs: number): Promise<RefreshBatchResult> {
  const started = Date.now();
  const result: RefreshBatchResult = { processed: 0, updated: 0, anomalySkipped: [], failed: [], lastTicker: afterTicker, done: false };
  const cursor = decodeCursor(afterTicker);
  const securities = await prisma.$queryRawUnsafe<Array<{ ticker: string; holder_count: number }>>(
    `SELECT s.ticker, count(p.*)::int AS holder_count
       FROM reverse_current_securities s
       JOIN reverse_current_positions p ON p.stock_id = s.id
      GROUP BY s.ticker
     HAVING ($1::int IS NULL OR count(p.*) < $1 OR (count(p.*) = $1 AND s.ticker > $2))
      ORDER BY holder_count DESC, s.ticker ASC LIMIT $3`,
    cursor?.holderCount ?? null, cursor?.ticker ?? "", limit,
  );
  if (!securities.length) { result.done = true; return result; }

  for (const s of securities) {
    if (Date.now() - started > timeBudgetMs) break;
    result.processed++;
    result.lastTicker = encodeCursor(s.holder_count, s.ticker);
    try {
      const computed = await currentReverseHoldings(dbQuery, { tickers: [s.ticker], page: 1, limit: 50 });
      const newCount = computed.total;
      const existing = await prisma.$queryRawUnsafe<Array<{ row_count: number }>>(`SELECT row_count FROM reverse_single_ticker_cache WHERE ticker = $1`, s.ticker);
      const oldCount = existing[0]?.row_count ?? null;
      if (oldCount != null && oldCount > 0 && newCount < oldCount * ANOMALY_SHRINK_RATIO) {
        result.anomalySkipped.push({ ticker: s.ticker, oldCount, newCount });
        continue; // 防清空保護：保留舊資料，不覆蓋
      }
      await prisma.$executeRawUnsafe(
        `INSERT INTO reverse_single_ticker_cache (ticker, computed_at, row_count, result)
         VALUES ($1, now(), $2, $3::jsonb)
         ON CONFLICT (ticker) DO UPDATE SET computed_at = now(), row_count = EXCLUDED.row_count, result = EXCLUDED.result`,
        s.ticker, newCount, JSON.stringify(computed),
      );
      result.updated++;
    } catch (e) {
      // 查無反查資料（REVERSE_INDEX_NOT_READY/UNRESOLVED等）或其他錯誤——跳過這檔，不中止整批。
      result.failed.push({ ticker: s.ticker, error: (e as Error).message });
    }
  }
  result.done = securities.length < limit;
  return result;
}
