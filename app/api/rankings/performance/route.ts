// Function 3 (基金 / ETF 排行中心) — unified real-data ranking API over the full canonical
// product universe. Every dimension maps to a column/source already populated in production;
// nothing is self-calculated. Dividend yield reuses the same materialized values as Function 6
// (lib/yahoo/distributionYield.ts's etfs.dividend_yield column for ETF, the offline
// lib/yahoo/fundYieldRanking.ts snapshot for Fund) — never a live re-fetch, never a self-computed
// trailing yield. Morningstar reuses funds.morningstar, synced by lib/yahoo/fundIngest.ts from
// Yahoo's own quoteSummary.morningStarOverallRating (a real Morningstar passthrough, not invented).
//
// 繁中前台硬規則: every result must carry a reliable Chinese display name (name matches the CJK
// range). A product without one stays in the backend universe (full-universe counts below still
// count it) but never surfaces in this ranking list — no AI translation, no English-name fallback
// into the main list. If a dimension has zero real data within the Chinese-eligible universe, the
// dimension is reported unsupported rather than shown empty or backed by fabricated numbers.
import { prisma } from "@/lib/prisma";
import { readFundYieldSnapshot, rankFundYields } from "@/lib/yahoo/fundYieldRanking";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const ZH = "[一-鿿]";

const ETF_PERIOD_COLUMN: Record<string, string> = {
  "1M": "return_1m", "3M": "return_3m", "6M": "return_6m", "1Y": "return_1y", "3Y": "return_3y", "5Y": "return_5y",
};
const FUND_PERIOD_COLUMN: Record<string, string> = { "1Y": "return_1y", "3Y": "return_3y", "5Y": "return_5y" };
// 1M/3M/6M/YTD have no flat funds.return_* column, but real values exist per-fund in
// fund_risk_metrics (latest as_of_date per fund) — a separate, smaller (702-fund) real dataset,
// not a fabricated fallback.
const FUND_RISK_METRIC_CODE: Record<string, string> = { "1M": "RETURN_1M", "3M": "RETURN_3M", "6M": "RETURN_6M", "YTD": "RETURN_YTD" };

const fmtPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const fmtStars = (v: number) => "★".repeat(v) + "☆".repeat(5 - v);
const fmtAum = (v: number, currency: string) => `${currency} ${Math.round(v).toLocaleString("zh-TW")}`;
const fmtVolume = (v: number) => `${Math.round(v).toLocaleString("zh-TW")} 股`;

function unsupported(assetType: string, rankingType: string, page: number, limit: number, reason: string) {
  return Response.json({ assetType, rankingType, supported: false, total: 0, page, limit, hasMore: false, results: [], reason }, { headers });
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const assetType = q.get("assetType") === "FUND" ? "FUND" : "ETF";
  const rankingType = (q.get("rankingType") ?? "PERFORMANCE").toUpperCase();
  const period = (q.get("period") ?? "1Y").toUpperCase();
  const sort = q.get("sort") === "asc" ? "ASC" : "DESC";
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? 50)));
  const page = Math.max(1, Number(q.get("page") ?? 1));
  const offset = (page - 1) * limit;

  if (assetType === "ETF") {
    if (rankingType === "PERFORMANCE") {
      const column = ETF_PERIOD_COLUMN[period];
      if (!column) return unsupported(assetType, rankingType, page, limit, "UNSUPPORTED_PERIOD");
      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string; code: string; name: string; value: string; latest_price: string | null; price_date: string | null; total: string;
      }>>(
        `SELECT id, code, name, ${column}::text AS value, latest_price::text, price_updated_at::text AS price_date,
                COUNT(*) OVER ()::text AS total
           FROM etfs WHERE is_active = true AND ${column} IS NOT NULL AND name ~ $3
          ORDER BY ${column} ${sort} LIMIT $1 OFFSET $2`,
        limit, offset, ZH,
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      return Response.json({
        assetType, rankingType, period, supported: true, total, page, limit, hasMore: offset + rows.length < total,
        results: rows.map((r) => ({
          id: r.id, code: r.code, name: r.name, metricValue: Number(r.value), metricDisplay: fmtPct(Number(r.value)),
          price: r.latest_price !== null ? Number(r.latest_price) : null, priceDate: r.price_date,
        })),
      }, { headers });
    }
    if (rankingType === "AUM") {
      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string; code: string; name: string; aum: string; currency: string; latest_price: string | null; price_date: string | null; total: string;
      }>>(
        `SELECT id, code, name, aum::text AS aum, currency, latest_price::text AS latest_price, price_updated_at::text AS price_date,
                COUNT(*) OVER ()::text AS total
           FROM etfs WHERE is_active = true AND aum IS NOT NULL AND name ~ $3
          ORDER BY etfs.aum ${sort} LIMIT $1 OFFSET $2`,
        limit, offset, ZH,
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      return Response.json({
        assetType, rankingType, supported: true, total, page, limit, hasMore: offset + rows.length < total,
        results: rows.map((r) => ({
          id: r.id, code: r.code, name: r.name, metricValue: Number(r.aum), metricDisplay: fmtAum(Number(r.aum), r.currency),
          price: r.latest_price !== null ? Number(r.latest_price) : null, priceDate: r.price_date,
        })),
      }, { headers });
    }
    if (rankingType === "VOLUME") {
      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string; code: string; name: string; volume: string; latest_price: string | null; price_date: string | null; total: string;
      }>>(
        `SELECT id, code, name, volume::text AS volume, latest_price::text AS latest_price, price_updated_at::text AS price_date,
                COUNT(*) OVER ()::text AS total
           FROM etfs WHERE is_active = true AND volume IS NOT NULL AND name ~ $3
          ORDER BY etfs.volume ${sort} LIMIT $1 OFFSET $2`,
        limit, offset, ZH,
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      return Response.json({
        assetType, rankingType, supported: true, total, page, limit, hasMore: offset + rows.length < total,
        results: rows.map((r) => ({
          id: r.id, code: r.code, name: r.name, metricValue: Number(r.volume), metricDisplay: fmtVolume(Number(r.volume)),
          price: r.latest_price !== null ? Number(r.latest_price) : null, priceDate: r.price_date,
        })),
      }, { headers });
    }
    if (rankingType === "DIVIDEND_YIELD") {
      // Same materialized column + filters as the frozen Function 6 (lib/yahoo/distributionYield.ts
      // getEtfYahooYieldRanking) — TWD, bare (non-suffixed) code only — just with real OFFSET pagination
      // added, which that limit-only helper doesn't support.
      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string; code: string; name: string; dividend_yield: string; latest_price: string | null; price_date: string | null; total: string;
      }>>(
        `SELECT id, code, name, dividend_yield::text AS dividend_yield, latest_price::text AS latest_price, price_updated_at::text AS price_date,
                COUNT(*) OVER ()::text AS total
           FROM etfs
          WHERE is_active = true AND currency = 'TWD' AND code !~ '\\.' AND dividend_yield IS NOT NULL AND name ~ $3
          ORDER BY etfs.dividend_yield ${sort} LIMIT $1 OFFSET $2`,
        limit, offset, ZH,
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      return Response.json({
        assetType, rankingType, supported: true, total, page, limit, hasMore: offset + rows.length < total,
        results: rows.map((r) => {
          const pct = Number(r.dividend_yield) * 100;
          return {
            id: r.id, code: r.code, name: r.name, metricValue: pct, metricDisplay: `${pct.toFixed(2)}%`,
            price: r.latest_price !== null ? Number(r.latest_price) : null, priceDate: r.price_date,
          };
        }),
      }, { headers });
    }
    if (rankingType === "BETA") {
      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string; code: string; name: string; beta: string; latest_price: string | null; price_date: string | null; total: string;
      }>>(
        `SELECT id, code, name, beta::text AS beta, latest_price::text AS latest_price, price_updated_at::text AS price_date,
                COUNT(*) OVER ()::text AS total
           FROM etfs WHERE is_active = true AND beta IS NOT NULL AND name ~ $3
          ORDER BY etfs.beta ${sort} LIMIT $1 OFFSET $2`,
        limit, offset, ZH,
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      return Response.json({
        assetType, rankingType, supported: true, total, page, limit, hasMore: offset + rows.length < total,
        results: rows.map((r) => ({
          id: r.id, code: r.code, name: r.name, metricValue: Number(r.beta), metricDisplay: Number(r.beta).toFixed(2),
          price: r.latest_price !== null ? Number(r.latest_price) : null, priceDate: r.price_date,
        })),
      }, { headers });
    }
    return unsupported(assetType, rankingType, page, limit, "NO_REAL_DATA");
  }

  // FUND
  if (rankingType === "PERFORMANCE") {
    const metricCode = FUND_RISK_METRIC_CODE[period];
    if (metricCode) {
      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string; code: string | null; name: string; value: string; nav: string | null; nav_date: string | null; total: string;
      }>>(
        `WITH latest_metric AS (
           SELECT DISTINCT ON (fund_id) fund_id, value FROM fund_risk_metrics
            WHERE metric_code = $4 ORDER BY fund_id, as_of_date DESC
         ), ranked AS (
           SELECT f.id, f.code, f.name, lm.value, f.latest_nav, f.latest_nav_date,
                  COALESCE(sc.master_fund_id, f.id) AS portfolio,
                  ROW_NUMBER() OVER (
                    PARTITION BY COALESCE(sc.master_fund_id, f.id)
                    ORDER BY (f.id = fm.representative_fund_id) DESC NULLS LAST, lm.value ${sort} NULLS LAST
                  ) AS rn
             FROM funds f
             JOIN latest_metric lm ON lm.fund_id = f.id
             LEFT JOIN fund_share_classes sc ON sc.fund_id = f.id
             LEFT JOIN fund_master fm ON fm.id = sc.master_fund_id
            WHERE f.is_active = true AND f.name ~ $3
         )
         SELECT id, code, name, value::text AS value, latest_nav::text AS nav, latest_nav_date::text AS nav_date,
                COUNT(*) OVER ()::text AS total
           FROM ranked WHERE rn = 1
          ORDER BY ranked.value ${sort} LIMIT $1 OFFSET $2`,
        limit, offset, ZH, metricCode,
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      return Response.json({
        assetType, rankingType, period, supported: true, total, page, limit, hasMore: offset + rows.length < total,
        results: rows.map((r) => ({
          id: r.id, code: r.code, name: r.name, metricValue: Number(r.value) * 100, metricDisplay: fmtPct(Number(r.value) * 100),
          price: r.nav !== null ? Number(r.nav) : null, priceDate: r.nav_date,
        })),
      }, { headers });
    }
    const column = FUND_PERIOD_COLUMN[period];
    if (!column) return unsupported(assetType, rankingType, page, limit, "UNSUPPORTED_PERIOD");
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string; code: string | null; name: string; value: string; nav: string | null; nav_date: string | null; total: string;
    }>>(
      `WITH ranked AS (
         SELECT f.id, f.code, f.name, f.${column} AS value, f.latest_nav, f.latest_nav_date,
                COALESCE(sc.master_fund_id, f.id) AS portfolio,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(sc.master_fund_id, f.id)
                  ORDER BY (f.id = fm.representative_fund_id) DESC NULLS LAST, f.${column} ${sort} NULLS LAST
                ) AS rn
           FROM funds f
           LEFT JOIN fund_share_classes sc ON sc.fund_id = f.id
           LEFT JOIN fund_master fm ON fm.id = sc.master_fund_id
          WHERE f.is_active = true AND f.${column} IS NOT NULL AND f.name ~ $3
       )
       SELECT id, code, name, value::text AS value, latest_nav::text AS nav, latest_nav_date::text AS nav_date,
              COUNT(*) OVER ()::text AS total
         FROM ranked WHERE rn = 1
        ORDER BY ranked.value ${sort} LIMIT $1 OFFSET $2`,
      limit, offset, ZH,
    );
    const total = rows.length ? Number(rows[0].total) : 0;
    return Response.json({
      assetType, rankingType, period, supported: true, total, page, limit, hasMore: offset + rows.length < total,
      results: rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, metricValue: Number(r.value), metricDisplay: fmtPct(Number(r.value)),
        price: r.nav !== null ? Number(r.nav) : null, priceDate: r.nav_date,
      })),
    }, { headers });
  }
  if (rankingType === "MORNINGSTAR") {
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string; code: string | null; name: string; morningstar: number; nav: string | null; nav_date: string | null; total: string;
    }>>(
      `WITH ranked AS (
         SELECT f.id, f.code, f.name, f.morningstar, f.latest_nav, f.latest_nav_date,
                COALESCE(sc.master_fund_id, f.id) AS portfolio,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(sc.master_fund_id, f.id)
                  ORDER BY (f.id = fm.representative_fund_id) DESC NULLS LAST, f.morningstar DESC NULLS LAST
                ) AS rn
           FROM funds f
           LEFT JOIN fund_share_classes sc ON sc.fund_id = f.id
           LEFT JOIN fund_master fm ON fm.id = sc.master_fund_id
          WHERE f.is_active = true AND f.morningstar BETWEEN 1 AND 5 AND f.name ~ $3
       )
       SELECT id, code, name, morningstar, latest_nav::text AS nav, latest_nav_date::text AS nav_date,
              COUNT(*) OVER ()::text AS total
         FROM ranked WHERE rn = 1
        ORDER BY ranked.morningstar ${sort} LIMIT $1 OFFSET $2`,
      limit, offset, ZH,
    );
    const total = rows.length ? Number(rows[0].total) : 0;
    return Response.json({
      assetType, rankingType, supported: true, total, page, limit, hasMore: offset + rows.length < total,
      results: rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, metricValue: r.morningstar, metricDisplay: fmtStars(r.morningstar),
        price: r.nav !== null ? Number(r.nav) : null, priceDate: r.nav_date,
      })),
    }, { headers });
  }
  if (rankingType === "DIVIDEND_YIELD") {
    // The offline Yahoo-direct fund-yield snapshot (Function 6's own source) currently maps only the
    // global-fund pool — it has zero overlap with the Chinese-named canonical Fund universe (verified:
    // 0 of 14,934 ranked rows have a Chinese name). Rather than surface an all-English list or silently
    // drop the zh gate, this dimension is honestly reported unsupported until the two pools are mapped.
    try {
      const snapshot = await readFundYieldSnapshot();
      const ranked = rankFundYields(snapshot.rows).filter((r) => new RegExp(ZH).test(r.name));
      if (ranked.length === 0) return unsupported(assetType, rankingType, page, limit, "NO_REAL_DATA_FOR_ZH_UNIVERSE");
      const slice = sort === "ASC" ? [...ranked].reverse() : ranked;
      const pageRows = slice.slice(offset, offset + limit);
      return Response.json({
        assetType, rankingType, supported: true, total: ranked.length, page, limit, hasMore: offset + pageRows.length < ranked.length,
        results: pageRows.map((r) => ({
          id: r.shareClassId, code: r.code, name: r.name, metricValue: r.yahooYield,
          metricDisplay: `${r.yahooYield!.toFixed(2)}%`, price: null, priceDate: null,
        })),
      }, { headers });
    } catch {
      return unsupported(assetType, rankingType, page, limit, "SNAPSHOT_UNAVAILABLE");
    }
  }
  if (rankingType === "AUM") return unsupported(assetType, rankingType, page, limit, "NO_REAL_DATA_FOR_ZH_UNIVERSE");
  return unsupported(assetType, rankingType, page, limit, "NO_REAL_DATA");
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
