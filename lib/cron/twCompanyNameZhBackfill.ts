// 選股反查：基金持股比對根因修復（2026-10-24，使用者核准定案）。查到61,545筆比對不上的
// 「核心母體基金持股」裡，絕大多數分類為EQUITY_CANDIDATE（46,697筆、1,745檔基金），抽樣
// 發現持股名稱都是台股中文簡稱（台積電/友達/台泥...），但stocks.company_name_zh在1,977檔
// active台股裡只有20檔有值（1%）——比對邏輯本身（已稽核過的ticker/security_id/名稱多重比對）
// 沒有問題，是中文名稱資料本身缺漏。這支cron只補「目前是NULL」的欄位，絕對不覆寫既有值，
// 所以已經比對上的2,128筆結果不會受影響。
//
// 資料來源：Yahoo奇摩股市(tw.stock.yahoo.com)報價頁<title>，格式固定為
// "中文簡稱(TICKER.TW/TWO) 走勢圖 - Yahoo股市"，已抽樣4檔(2330/4958/2409/1101)驗證格式一致，
// 用字風格跟基金揭露的持股名稱一致（簡稱，不是全名）。401/403/429直接回報，不重試繞過。
import { prisma } from "@/lib/prisma";

export type TwNameBackfillFailure = "RATE_LIMITED_401" | "RATE_LIMITED_403" | "RATE_LIMITED_429" | "NO_TITLE_MATCH" | "FETCH_ERROR";

export type StaleTwNameStock = { id: string; ticker: string; yahooSymbol: string };

export async function findStocksMissingNameZh(limit: number, afterTicker: string | null): Promise<StaleTwNameStock[]> {
  return prisma.$queryRawUnsafe<StaleTwNameStock[]>(
    `SELECT id, ticker, yahoo_symbol AS "yahooSymbol" FROM stocks
      WHERE is_active AND country = 'TW' AND (company_name_zh IS NULL OR company_name_zh = '') AND ticker > $2
      ORDER BY ticker ASC
      LIMIT $1`,
    limit, afterTicker ?? "",
  );
}

export type FetchNameResult = { ok: true; name: string } | { ok: false; failureReason: TwNameBackfillFailure };

export async function fetchYahooTwCompanyNameZh(yahooSymbol: string): Promise<FetchNameResult> {
  let res: Response;
  try {
    res = await fetch(`https://tw.stock.yahoo.com/quote/${encodeURIComponent(yahooSymbol)}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, failureReason: "FETCH_ERROR" };
  }
  if (res.status === 401) return { ok: false, failureReason: "RATE_LIMITED_401" };
  if (res.status === 403) return { ok: false, failureReason: "RATE_LIMITED_403" };
  if (res.status === 429) return { ok: false, failureReason: "RATE_LIMITED_429" };
  if (!res.ok) return { ok: false, failureReason: "FETCH_ERROR" };
  const html = await res.text();
  const m = html.match(/<title>([^<(]+)\([^<]*\)[^<]*<\/title>/);
  if (!m) return { ok: false, failureReason: "NO_TITLE_MATCH" };
  return { ok: true, name: m[1].trim() };
}

export type BackfillOneResult = { ok: boolean; written: boolean; failureReason?: TwNameBackfillFailure };

export async function backfillOneStockNameZh(stock: StaleTwNameStock, writeEnabled: boolean): Promise<BackfillOneResult> {
  const fetched = await fetchYahooTwCompanyNameZh(stock.yahooSymbol);
  if (!fetched.ok) return { ok: false, written: false, failureReason: fetched.failureReason };
  if (!writeEnabled) return { ok: true, written: false };
  // 只補NULL，SQL層再次確認，避免跟其他寫入路徑競爭、覆寫既有值。
  const rowCount = await prisma.$executeRawUnsafe(
    `UPDATE stocks SET company_name_zh = $1 WHERE id = $2 AND (company_name_zh IS NULL OR company_name_zh = '')`,
    fetched.name, stock.id,
  );
  return { ok: true, written: rowCount > 0 };
}
