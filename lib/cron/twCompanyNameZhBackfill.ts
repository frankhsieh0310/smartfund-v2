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
//
// 2026-10-24（使用者核准補充）: 以Yahoo為主，另外用證交所(TWSE)/櫃買中心(TPEx)公開的上市櫃
// 公司基本資料「公司簡稱」欄位交叉核對——兩邊都用公司代號(ticker)對應，已用1101(台泥)/1240
// 現場驗證兩個API都回得到公司簡稱。不一致時列為異常、不寫入（照「資料新鮮度/來源」原則：
// 遇到不一致不准自己選一個當正確答案）；官方清單查不到這檔（可能是ETF／權證／其他非一般上市櫃
// 股票類型，官方這兩份開放資料本來就只收「公司」)，不算異常，純Yahoo值照寫。
import { prisma } from "@/lib/prisma";

const TWSE_COMPANY_BASIC_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap03_L";
const TPEX_COMPANY_BASIC_URL = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O";

export async function fetchOfficialTwShortNames(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const [twseRes, tpexRes] = await Promise.all([
    fetch(TWSE_COMPANY_BASIC_URL, { signal: AbortSignal.timeout(20_000) }).catch(() => null),
    fetch(TPEX_COMPANY_BASIC_URL, { signal: AbortSignal.timeout(20_000) }).catch(() => null),
  ]);
  if (twseRes?.ok) {
    const rows = (await twseRes.json()) as Array<{ 公司代號: string; 公司簡稱: string }>;
    for (const r of rows) if (r.公司代號 && r.公司簡稱) map.set(r.公司代號.trim(), r.公司簡稱.trim());
  }
  if (tpexRes?.ok) {
    const rows = (await tpexRes.json()) as Array<{ SecuritiesCompanyCode: string; CompanyAbbreviation: string }>;
    for (const r of rows) if (r.SecuritiesCompanyCode && r.CompanyAbbreviation) map.set(r.SecuritiesCompanyCode.trim(), r.CompanyAbbreviation.trim());
  }
  return map;
}

export type TwNameBackfillFailure = "RATE_LIMITED_401" | "RATE_LIMITED_403" | "RATE_LIMITED_429" | "NO_TITLE_MATCH" | "FETCH_ERROR" | "ANOMALY_NAME_MISMATCH";

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

export type BackfillOneResult = { ok: boolean; written: boolean; failureReason?: TwNameBackfillFailure; anomaly?: { yahoo: string; official: string } };

export async function backfillOneStockNameZh(stock: StaleTwNameStock, writeEnabled: boolean, officialNames: Map<string, string>): Promise<BackfillOneResult> {
  const fetched = await fetchYahooTwCompanyNameZh(stock.yahooSymbol);
  if (!fetched.ok) return { ok: false, written: false, failureReason: fetched.failureReason };
  const official = officialNames.get(stock.ticker);
  if (official && official !== fetched.name) {
    return { ok: false, written: false, failureReason: "ANOMALY_NAME_MISMATCH", anomaly: { yahoo: fetched.name, official } };
  }
  if (!writeEnabled) return { ok: true, written: false };
  // 只補NULL，SQL層再次確認，避免跟其他寫入路徑競爭、覆寫既有值。
  const rowCount = await prisma.$executeRawUnsafe(
    `UPDATE stocks SET company_name_zh = $1 WHERE id = $2 AND (company_name_zh IS NULL OR company_name_zh = '')`,
    fetched.name, stock.id,
  );
  return { ok: true, written: rowCount > 0 };
}
