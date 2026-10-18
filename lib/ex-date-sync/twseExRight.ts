// Official source: TWSE's own "除權除息預告表" (ex-rights/ex-dividend pre-announcement table),
// VERIFIED live (2026-10-18) by watching the network call this exact page makes:
// 市場公告 > 除權除息 > 預告表 (https://www.twse.com.tw/zh/announcement/ex-right/twt48u.html)
// -> https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json
// This single table covers TWSE-listed stocks AND ETFs together (confirmed live: 00401A/0056/00714
// etc. appear alongside ordinary stock codes like 1463/1711) -- announced future ex-dates, not
// historical ones, exactly what alertEvaluate.ts's DAYS_TO_EX_DATE metric needs. Dates are copied
// verbatim from this official source, never calculated/estimated.
export type TwseExRightRow = {
  code: string;
  name: string;
  exDate: Date;
  kind: "除息" | "除權" | "除權息" | "其他";
  cashDividend: number | null;
};

const TWSE_EXRIGHT_URL = "https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json";

/** "115年10月19日" -> Date(2026-10-19). Blank/unparsable -> null. */
export function parseTwseRocDate(raw: string | undefined): Date | null {
  const m = (raw ?? "").trim().match(/^(\d{2,3})年(\d{1,2})月(\d{1,2})日$/);
  if (!m) return null;
  const year = Number(m[1]) + 1911;
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseKind(raw: string | undefined): TwseExRightRow["kind"] {
  const s = (raw ?? "").trim();
  if (s === "息") return "除息";
  if (s === "權") return "除權";
  if (s === "權息") return "除權息";
  return "其他";
}

/** The 現金股利 cell is sometimes real HTML ("<p ...>待公告實際收益分配金額</p>") instead of a number
 * when the amount hasn't been announced yet -- that's an honest "amount TBD" state from the source
 * itself, not a parse failure, so it maps to null rather than 0. */
function parseCashDividend(raw: string | undefined): number | null {
  const s = (raw ?? "").trim();
  const n = Number(s);
  return Number.isFinite(n) && s !== "" ? n : null;
}

export async function fetchTwseExRightRows(): Promise<TwseExRightRow[]> {
  // 2026-10-18: tightened from 30s to 15s -- local curl from Taiwan answers in ~0.2s, but Vercel's
  // production region is overseas and TWSE may respond far slower (or hang) for an out-of-country
  // caller; a tighter timeout fails fast with a clear error instead of silently eating the route's
  // budget. See app/api/cron/ex-date-sync/route.ts's step timing log for which step actually ran
  // long in production.
  const res = await fetch(TWSE_EXRIGHT_URL, { headers: { "User-Agent": "Mozilla/5.0 (SmartMatch data pipeline)" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    const err = new Error(`TWSE_EXRIGHT_RATE_LIMITED_${res.status}`);
    (err as any).rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`TWSE_EXRIGHT_HTTP_${res.status}`);
  const body = (await res.json()) as { stat: string; fields: string[]; data: string[][] };
  if (body.stat !== "OK") throw new Error(`TWSE_EXRIGHT_STAT_${body.stat}`);
  const fields = body.fields;
  const iDate = fields.indexOf("除權除息日期");
  const iCode = fields.indexOf("股票代號");
  const iName = fields.indexOf("名稱");
  const iKind = fields.indexOf("除權息");
  const iCash = fields.indexOf("現金股利");
  if (iDate < 0 || iCode < 0 || iName < 0) throw new Error("TWSE_EXRIGHT_FIELDS_MISSING");

  const rows: TwseExRightRow[] = [];
  for (const row of body.data) {
    const code = (row[iCode] ?? "").trim();
    const exDate = parseTwseRocDate(row[iDate]);
    if (!code || !exDate) continue;
    rows.push({ code, name: (row[iName] ?? "").trim(), exDate, kind: parseKind(row[iKind]), cashDividend: parseCashDividend(row[iCash]) });
  }
  return rows;
}
