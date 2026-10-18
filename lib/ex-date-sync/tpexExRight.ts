// Official source: TPEx's own OpenAPI "上櫃股票除權除息預告表" (ex-rights/ex-dividend
// pre-announcement table for TPEx-listed securities), VERIFIED live (2026-10-18) via TPEx's own
// published OpenAPI swagger spec (https://www.tpex.org.tw/openapi/swagger.json ->
// /tpex_exright_prepost). Covers TPEx-listed stocks AND ETFs together (confirmed live: 55/66 rows on
// a sample day were ETF-pattern codes like 00734B/00842B). Dates are copied verbatim, never
// calculated.
export type TpexExRightRow = {
  code: string;
  name: string;
  exDate: Date;
  kind: "除息" | "除權" | "其他";
  cashDividend: number | null;
};

const TPEX_EXRIGHT_URL = "https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost";

/** "1151016" (ROC year 115 = AD 2026) -> Date(2026-10-16). Same convention as
 * lib/cron/newListingDetection.ts's parseRocDate -- duplicated here rather than imported, matching
 * this project's established pattern of each ingestion module owning its own parse (see
 * lib/sitca-nav-sync/sitcaFetch.ts's own header comment on why). */
export function parseTpexRocDate(raw: string | undefined): Date | null {
  const s = (raw ?? "").trim();
  if (!/^\d{6,7}$/.test(s)) return null;
  const mm = s.slice(-4, -2);
  const dd = s.slice(-2);
  const rocYear = Number(s.slice(0, s.length - 4));
  if (!Number.isFinite(rocYear) || rocYear <= 0) return null;
  const d = new Date(Date.UTC(rocYear + 1911, Number(mm) - 1, Number(dd)));
  return Number.isNaN(d.getTime()) ? null : d;
}

type TpexApiRow = {
  ExRrightsExDividendDate: string;
  SecuritiesCompanyCode: string;
  CompanyName: string;
  ExRrightsExDividend: string;
  CashDividend: string;
};

function parseKind(raw: string): TpexExRightRow["kind"] {
  if (raw === "除息") return "除息";
  if (raw === "除權") return "除權";
  return "其他";
}

export async function fetchTpexExRightRows(): Promise<TpexExRightRow[]> {
  // 2026-10-18: tightened from 30s to 15s, same reasoning as twseExRight.ts's fetch.
  const res = await fetch(TPEX_EXRIGHT_URL, { headers: { "User-Agent": "Mozilla/5.0 (SmartMatch data pipeline)" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    const err = new Error(`TPEX_EXRIGHT_RATE_LIMITED_${res.status}`);
    (err as any).rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`TPEX_EXRIGHT_HTTP_${res.status}`);
  const body = (await res.json()) as TpexApiRow[];
  if (!Array.isArray(body)) throw new Error("TPEX_EXRIGHT_SHAPE_UNEXPECTED");

  const rows: TpexExRightRow[] = [];
  for (const row of body) {
    const code = (row.SecuritiesCompanyCode ?? "").trim();
    const exDate = parseTpexRocDate(row.ExRrightsExDividendDate);
    if (!code || !exDate) continue;
    const cash = Number(row.CashDividend);
    rows.push({ code, name: (row.CompanyName ?? "").trim(), exDate, kind: parseKind(row.ExRrightsExDividend), cashDividend: Number.isFinite(cash) && cash > 0 ? cash : null });
  }
  return rows;
}
