// 官方快照（holdings.source='ETF_OFFICIAL_DAILY_SNAPSHOT'）的台股 ETF 反查與 ETF 持股數。
// 唯讀：只發 SELECT，全部參數化（SQL 為常數，使用者輸入只走 $n 參數）。
// - 每檔 ETF 取 max(as_of_date) 那份快照；同一檔同一天只有一份。
// - 用 holding_code = 純代碼 對應股票（官方快照列的 security_id 與 stocks 的連結對不上，不可用）。
// - holding_code 符合 STOCK_CODE_PATTERN 視為股票，其餘（FUTURE:/CASH:/OTHER: 等）為非股票部位。
// - 表頭被誤寫成資料的列（HEADER_ROW_CODES）一律排除，不計入任何數字。

export const OFFICIAL_SOURCE = "ETF_OFFICIAL_DAILY_SNAPSHOT";
export const STOCK_CODE_PATTERN = "^[0-9]{4,6}[A-Z]?$";
export const HEADER_ROW_CODES = ["股票代碼", "期貨代碼"];
const STOCK_CODE_RE = new RegExp(STOCK_CODE_PATTERN);
const UNKNOWN_PROVIDERS = new Set(["", "未知（待補）"]);
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** 參數化查詢執行器：route 用 prisma.$queryRawUnsafe，驗證腳本用 pg（READ ONLY 交易）。 */
export type SqlRunner = <T>(sql: string, values: unknown[]) => Promise<T[]>;

export class TwOfficialError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "TwOfficialError";
  }
}

export type HoldingsCount = { stockCount: number; totalPositions: number; nonStockCount: number };

export type OfficialEtfReverseItem = {
  etfCode: string;
  etfName: string;
  provider: string | null;
  weight: number | null;
  asOfDate: string;
  dateIsFuture: boolean;
  holdingsCount: HoldingsCount;
};

export type OfficialEtfReverseResult = {
  ticker: string;
  bareCode: string;
  totalEtfs: number;
  latestAsOfDate: string | null;
  source: typeof OFFICIAL_SOURCE;
  items: OfficialEtfReverseItem[];
  page: number;
  limit: number;
  hasMore: boolean;
};

export type OfficialEtfHoldingsCountResult = {
  code: string;
  name: string;
  asOfDate: string;
  dateIsFuture: boolean;
  stockCount: number;
  totalPositions: number;
  nonStock: Array<{ holdingCode: string | null; name: string | null; weight: number | null }>;
};

const taipeiToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const normalizeProvider = (value: string | null) => (value == null || UNKNOWN_PROVIDERS.has(value.trim()) ? null : value);

const toNumber = (value: unknown) => (value == null || !Number.isFinite(Number(value)) ? null : Number(value));

/** "2330"、"2330.TW"、"8069.TWO" → "2330"／"8069"；格式不對丟 400。 */
export function toBareCode(input: string | null | undefined, kind: "ticker" | "code"): string {
  const bare = String(input ?? "").trim().toUpperCase().replace(/\.(TW|TWO)$/, "");
  if (!STOCK_CODE_RE.test(bare)) {
    throw new TwOfficialError(400, kind === "ticker" ? "INVALID_TICKER" : "INVALID_CODE", `${kind} must be a Taiwan code such as 2330, 2330.TW or 8069.TWO`);
  }
  return bare;
}

function parsePositiveInt(value: string | number | null | undefined, name: string, fallback: number, max?: number): number {
  if (value == null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || (max != null && n > max)) {
    throw new TwOfficialError(400, "INVALID_PARAM", max != null ? `${name} must be an integer between 1 and ${max}` : `${name} must be a positive integer`);
  }
  return n;
}

const REVERSE_SQL = `
WITH latest AS (
  SELECT etf_id, max(as_of_date) AS as_of_date
  FROM holdings
  WHERE source = $2 AND etf_id IS NOT NULL
  GROUP BY etf_id
), snap AS (
  SELECT h.etf_id, h.as_of_date, h.holding_code, h.weight
  FROM holdings h
  JOIN latest l ON l.etf_id = h.etf_id AND l.as_of_date = h.as_of_date
  WHERE h.source = $2 AND (h.holding_code IS NULL OR NOT (h.holding_code = ANY($3::text[])))
), hit AS (
  SELECT etf_id, as_of_date, max(weight) AS weight
  FROM snap
  WHERE holding_code = $1
  GROUP BY etf_id, as_of_date
), counts AS (
  SELECT etf_id,
         count(*)::int AS total_positions,
         (count(*) FILTER (WHERE holding_code ~ $4))::int AS stock_count
  FROM snap
  WHERE etf_id IN (SELECT etf_id FROM hit)
  GROUP BY etf_id
)
SELECT e.code AS etf_code, e.name AS etf_name, e.provider,
       hit.weight::float8 AS weight, hit.as_of_date::text AS as_of_date,
       c.stock_count, c.total_positions
FROM hit
JOIN etfs e ON e.id = hit.etf_id
JOIN counts c ON c.etf_id = hit.etf_id
ORDER BY hit.weight DESC NULLS LAST, e.code`;

const STOCK_EXISTS_SQL = `
SELECT EXISTS (
  SELECT 1 FROM stocks
  WHERE upper(yahoo_symbol) = ANY($1::text[]) AND exchange IN ('TWSE','TPEx','TPEX')
) AS found`;

type ReverseRow = { etf_code: string; etf_name: string; provider: string | null; weight: number | null; as_of_date: string; stock_count: number; total_positions: number };

export async function getOfficialEtfReverse(
  run: SqlRunner,
  input: { ticker: string | null | undefined; page?: string | number | null; limit?: string | number | null },
): Promise<OfficialEtfReverseResult> {
  const bareCode = toBareCode(input.ticker, "ticker");
  const page = parsePositiveInt(input.page, "page", 1);
  const limit = parsePositiveInt(input.limit, "limit", DEFAULT_LIMIT, MAX_LIMIT);
  const rows = await run<ReverseRow>(REVERSE_SQL, [bareCode, OFFICIAL_SOURCE, HEADER_ROW_CODES, STOCK_CODE_PATTERN]);
  if (rows.length === 0) {
    // 沒有任何 ETF 持有時，區分「不存在的代碼」（404）與「存在但沒有 ETF 持有」（200 空結果）。
    const [exists] = await run<{ found: boolean }>(STOCK_EXISTS_SQL, [[`${bareCode}.TW`, `${bareCode}.TWO`]]);
    if (!exists?.found) throw new TwOfficialError(404, "TICKER_NOT_FOUND", `No Taiwan listed stock or official ETF holding found for ${bareCode}`);
  }
  const today = taipeiToday();
  const all = rows.map<OfficialEtfReverseItem>((r) => ({
    etfCode: r.etf_code,
    etfName: r.etf_name,
    provider: normalizeProvider(r.provider),
    weight: toNumber(r.weight),
    asOfDate: r.as_of_date,
    dateIsFuture: r.as_of_date > today,
    holdingsCount: { stockCount: r.stock_count, totalPositions: r.total_positions, nonStockCount: r.total_positions - r.stock_count },
  }));
  const offset = (page - 1) * limit;
  return {
    ticker: String(input.ticker).trim().toUpperCase(),
    bareCode,
    totalEtfs: all.length,
    // 只用不晚於今天（台北時間）的持股日期；未來日期的列仍保留在 items（dateIsFuture=true）。
    latestAsOfDate: all.reduce<string | null>((max, item) => (!item.dateIsFuture && (max == null || item.asOfDate > max) ? item.asOfDate : max), null),
    source: OFFICIAL_SOURCE,
    items: all.slice(offset, offset + limit),
    page,
    limit,
    hasMore: offset + limit < all.length,
  };
}

const HOLDINGS_SQL = `
WITH cand AS (
  SELECT id, code, name FROM etfs WHERE code = ANY($1::text[])
), latest AS (
  SELECT h.etf_id, max(h.as_of_date) AS as_of_date
  FROM holdings h
  WHERE h.source = $2 AND h.etf_id IN (SELECT id FROM cand)
  GROUP BY h.etf_id
  ORDER BY max(h.as_of_date) DESC, h.etf_id
  LIMIT 1
)
SELECT c.code, c.name, l.as_of_date::text AS as_of_date,
       h.holding_code, h.holding_name, h.weight::float8 AS weight
FROM latest l
JOIN cand c ON c.id = l.etf_id
JOIN holdings h ON h.etf_id = l.etf_id AND h.as_of_date = l.as_of_date AND h.source = $2
WHERE h.holding_code IS NULL OR NOT (h.holding_code = ANY($3::text[]))
ORDER BY h.weight DESC NULLS LAST, h.holding_code`;

type HoldingRow = { code: string; name: string; as_of_date: string; holding_code: string | null; holding_name: string | null; weight: number | null };

export async function getOfficialEtfHoldingsCount(
  run: SqlRunner,
  input: { code: string | null | undefined },
): Promise<OfficialEtfHoldingsCountResult> {
  const bare = toBareCode(input.code, "code");
  const rows = await run<HoldingRow>(HOLDINGS_SQL, [[bare, `${bare}.TW`, `${bare}.TWO`], OFFICIAL_SOURCE, HEADER_ROW_CODES]);
  if (rows.length === 0) throw new TwOfficialError(404, "ETF_NOT_FOUND", `No official holdings snapshot found for ETF ${bare}`);
  const stocks = rows.filter((r) => r.holding_code != null && STOCK_CODE_RE.test(r.holding_code));
  const nonStock = rows.filter((r) => !(r.holding_code != null && STOCK_CODE_RE.test(r.holding_code)));
  return {
    code: bare,
    name: rows[0].name,
    asOfDate: rows[0].as_of_date,
    dateIsFuture: rows[0].as_of_date > taipeiToday(),
    stockCount: stocks.length,
    totalPositions: rows.length,
    nonStock: nonStock.map((r) => ({ holdingCode: r.holding_code, name: r.holding_name, weight: toNumber(r.weight) })),
  };
}
