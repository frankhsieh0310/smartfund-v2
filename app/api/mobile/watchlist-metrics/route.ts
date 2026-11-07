// 自選清單排序/篩選 (2026-11-07 第33輪指令第2點): 自選清單裡的 ETF/基金項目要能跟其他頁面一樣
// 依類型篩選、依績效/規模/配息率排序。自選清單本身是裝置端儲存、沒有後端 watchlist API（見
// src/watchlist/service.ts 的註解），所以這支 route 只負責「給一批 etfs.id/funds.id，批次回傳
// 分類與最新績效」，分類規則直接沿用 classifyEtfBucketJs/classifyFundBucketJs（跟排行中心、
// 反查頁同一套，不是另外發明一套簡化規則）。
import { prisma } from "@/lib/prisma";
import { classifyEtfBucketJs, classifyFundBucketJs } from "@/lib/data-platform/assetCategoryBucketJs";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

type MetricRow = { asset_id: string; code: string; name: string; category: string | null; aum: string | null; dividend_yield: string | null; return_1m: string | null; return_3m: string | null; return_6m: string | null; return_ytd: string | null; return_1y: string | null; return_3y: string | null; return_5y: string | null; perf_date: string | null };
const toNum = (v: string | null) => (v === null ? null : Number(v));

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const etfIds = (q.get("etfIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  const fundIds = (q.get("fundIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);

  const result: Record<string, { category: string; aum: number | null; dividendYield: number | null; return_1m: number | null; return_3m: number | null; return_6m: number | null; return_ytd: number | null; return_1y: number | null; return_3y: number | null; return_5y: number | null; metricAsOfDate: string | null }> = {};

  if (etfIds.length) {
    const rows = await prisma.$queryRawUnsafe<MetricRow[]>(
      `WITH latest_perf AS (SELECT DISTINCT ON (etf_id) etf_id, date, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y FROM etf_performances WHERE etf_id = ANY($1::text[]) ORDER BY etf_id, date DESC)
       SELECT e.id asset_id, e.code, e.name, e.category, e.aum::text aum, e.dividend_yield::text dividend_yield,
         lp.return_1m::text return_1m, lp.return_3m::text return_3m, lp.return_6m::text return_6m, lp.return_ytd::text return_ytd,
         lp.return_1y::text return_1y, lp.return_3y::text return_3y, lp.return_5y::text return_5y, lp.date::text perf_date
       FROM etfs e LEFT JOIN latest_perf lp ON lp.etf_id = e.id WHERE e.id = ANY($1::text[])`,
      etfIds,
    );
    for (const r of rows) {
      result[r.asset_id] = {
        category: classifyEtfBucketJs(r.code, r.name, r.category),
        aum: toNum(r.aum), dividendYield: toNum(r.dividend_yield),
        return_1m: toNum(r.return_1m), return_3m: toNum(r.return_3m), return_6m: toNum(r.return_6m),
        return_ytd: toNum(r.return_ytd), return_1y: toNum(r.return_1y), return_3y: toNum(r.return_3y), return_5y: toNum(r.return_5y),
        metricAsOfDate: r.perf_date,
      };
    }
  }
  if (fundIds.length) {
    const rows = await prisma.$queryRawUnsafe<MetricRow[]>(
      `WITH latest_perf AS (SELECT DISTINCT ON (fund_id) fund_id, date, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y FROM fund_performances WHERE fund_id = ANY($1::text[]) ORDER BY fund_id, date DESC)
       SELECT f.id asset_id, f.code, f.name, f.category, f.aum::text aum, coalesce(f.dividend_yield_a, f.dividend_yield_m)::text dividend_yield,
         lp.return_1m::text return_1m, lp.return_3m::text return_3m, lp.return_6m::text return_6m, lp.return_ytd::text return_ytd,
         lp.return_1y::text return_1y, lp.return_3y::text return_3y, lp.return_5y::text return_5y, lp.date::text perf_date
       FROM funds f LEFT JOIN latest_perf lp ON lp.fund_id = f.id WHERE f.id = ANY($1::text[])`,
      fundIds,
    );
    for (const r of rows) {
      result[r.asset_id] = {
        category: classifyFundBucketJs(r.category),
        aum: toNum(r.aum), dividendYield: toNum(r.dividend_yield),
        return_1m: toNum(r.return_1m), return_3m: toNum(r.return_3m), return_6m: toNum(r.return_6m),
        return_ytd: toNum(r.return_ytd), return_1y: toNum(r.return_1y), return_3y: toNum(r.return_3y), return_5y: toNum(r.return_5y),
        metricAsOfDate: r.perf_date,
      };
    }
  }

  return Response.json({ ok: true, metrics: result }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
