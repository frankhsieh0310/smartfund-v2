// Function 5 (配息目標試算) + Function 6 (配息率排行榜) — ONE shared data layer, Yahoo-direct
// distribution yield ONLY. Never trailing-12M/price, never trailing-12M/NAV, never frequency-based
// annualization, never an "estimated" fallback. If Yahoo has not published a direct yield for a
// product, that product simply has no yield here — never self-calculated, never guessed.
//
// ETF: canonical Yahoo summaryDetail.yield, written by the existing etfEnrich writer.
// Fund: summaryDetail.yield through the existing Yahoo session, keyed by exact share-class mapping.
// Fund pages are bounded (50 identities); callers must disclose that sorting covers loaded data.
import { prisma } from "@/lib/prisma";
import { fetchQuoteSummary } from "./productSession";

// A read-through cache only: no ingestion, NAV math, or production writes.
// Both consumers share the same value and in-flight request per Yahoo identity.
const directCache = new Map<string, { expires: number; value: Promise<number | null> }>();
export function getYahooDirectYield(symbol: string): Promise<number | null> {
  const cached = directCache.get(symbol);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = fetchQuoteSummary(symbol, ["summaryDetail"]).then(response => {
    if (!response) throw new Error("Yahoo yield 暫時無法取得");
    const field = response.result?.summaryDetail?.yield;
    const raw = field?.raw;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
    // Prefer Yahoo's own displayed precision; converting a provided ratio is not computing yield.
    const formatted = typeof field.fmt === "string" && /^\d+(\.\d+)?%$/.test(field.fmt) ? Number(field.fmt.slice(0,-1)) : null;
    return formatted ?? Number((raw * 100).toFixed(6));
  }).catch(error => { directCache.delete(symbol); throw error; });
  directCache.set(symbol, { expires: Date.now() + 300_000, value });
  return value;
}

export type YahooYieldRow = {
  code: string; name: string; yahooYieldPct: number | null;
  latestDividend: number | null; latestExDate: string | null;
};

export async function getEtfYahooYieldRanking(limit: number): Promise<YahooYieldRow[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    code: string; name: string; dividend_yield: string | null;
    latest_amount: string | null; latest_ex_date: string | null;
  }>>(
    `SELECT e.code, e.name, e.dividend_yield::text,
            latest.amount::text AS latest_amount, latest.ex_date::text AS latest_ex_date
       FROM etfs e
       LEFT JOIN LATERAL (
         SELECT amount, ex_date FROM etf_distribution_events WHERE etf_id = e.id ORDER BY ex_date DESC LIMIT 1
       ) latest ON true
      WHERE e.is_active = true AND e.currency = 'TWD' AND e.code !~ '\\.' AND e.dividend_yield IS NOT NULL
      ORDER BY e.dividend_yield DESC LIMIT $1`,
    limit,
  );
  return rows.map((r) => ({
    code: r.code, name: r.name,
    yahooYieldPct: r.dividend_yield !== null ? Number((Number(r.dividend_yield) * 100).toFixed(6)) : null,
    latestDividend: r.latest_amount !== null ? Number(r.latest_amount) : null,
    latestExDate: r.latest_ex_date,
  }));
}

export async function getEtfYahooYieldByCode(code: string): Promise<YahooYieldRow | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    code: string; name: string; dividend_yield: string | null;
    latest_amount: string | null; latest_ex_date: string | null;
  }>>(
    `SELECT e.code, e.name, e.dividend_yield::text,
            latest.amount::text AS latest_amount, latest.ex_date::text AS latest_ex_date
       FROM etfs e
       LEFT JOIN LATERAL (
         SELECT amount, ex_date FROM etf_distribution_events WHERE etf_id = e.id ORDER BY ex_date DESC LIMIT 1
       ) latest ON true
      WHERE e.code = $1 AND e.is_active = true LIMIT 1`,
    code,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    code: r.code, name: r.name,
    yahooYieldPct: r.dividend_yield !== null ? Number((Number(r.dividend_yield) * 100).toFixed(6)) : null,
    latestDividend: r.latest_amount !== null ? Number(r.latest_amount) : null,
    latestExDate: r.latest_ex_date,
  };
}

export async function getFundYahooYieldRanking(limit: number, offset = 0): Promise<YahooYieldRow[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ code: string; name: string }>>(
    `SELECT DISTINCT ON (m.provider_code) m.provider_code AS code, f.name
       FROM fund_provider_mappings m
       JOIN fund_share_classes s ON s.id = m.share_class_id
       JOIN funds f ON f.id = s.fund_id
      WHERE m.provider = 'YAHOO' AND m.provider_code <> ''
        AND s.status = 'ACTIVE' AND f.is_active = true
      ORDER BY code, name LIMIT $1 OFFSET $2`, Math.min(limit, 50), offset);
  const result: YahooYieldRow[] = [];
  for (let i = 0; i < rows.length; i += 5) {
    result.push(...await Promise.all(rows.slice(i, i + 5).map(async r => ({
      ...r, yahooYieldPct: await getYahooDirectYield(r.code).catch(() => null), latestDividend: null, latestExDate: null,
    }))));
  }
  return result.sort((a, b) => (b.yahooYieldPct ?? -Infinity) - (a.yahooYieldPct ?? -Infinity));
}

export async function getFundYahooYieldByCode(code: string): Promise<YahooYieldRow | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ code: string; name: string }>>(
    `SELECT m.provider_code AS code, f.name FROM fund_provider_mappings m
     JOIN fund_share_classes s ON s.id=m.share_class_id JOIN funds f ON f.id=s.fund_id
     WHERE m.provider='YAHOO' AND m.provider_code=$1 AND s.status='ACTIVE' AND f.is_active=true LIMIT 1`,
    code,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    code: r.code, name: r.name,
    yahooYieldPct: await getYahooDirectYield(r.code),
    latestDividend: null, latestExDate: null,
  };
}
