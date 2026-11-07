// 商品反查 (item 3) — given a commodity, returns the TW-listed ETFs that directly track it (see
// lib/data-platform/commodityEtfMapping.ts for the curated, name-derived mapping and its scope
// limits). Enriches each with live price/return data already in `etfs` — no self-computed figures.
import { prisma } from "@/lib/prisma";
import { COMMODITY_ETF_MAPPING, COMMODITY_KEYS, THEMATIC_COMMODITY_FUNDS, type CommodityKey } from "@/lib/data-platform/commodityEtfMapping";
import { classifyEtfBucketJs, classifyFundBucketJs } from "@/lib/data-platform/assetCategoryBucketJs";
import type { AssetCategoryBucket } from "@/lib/data-platform/categoryClassification";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

const CATEGORY_BUCKETS = ["ALL", "STOCK", "BOND", "MIXED", "COMMODITY", "LEVERAGE_INVERSE"] as const;
const PERFORMANCE_SORTS = ["return_1m", "return_3m", "return_6m", "return_ytd", "return_1y", "return_3y", "return_5y"] as const;
const SORT_KEYS = [...PERFORMANCE_SORTS, "aum", "dividend_yield"] as const;

type PerfRow = { code: string; category: string | null; aum: string | null; dividend_yield: string | null; return_1m: string | null; return_3m: string | null; return_6m: string | null; return_ytd: string | null; return_1y: string | null; return_3y: string | null; return_5y: string | null; perf_date: string | null };
const toNum = (v: string | null) => (v === null ? null : Number(v));

// WTI/Brent crude are both energy-sector exposures -- 能源主題基金 (equity/bond funds investing in
// the energy sector, not direct futures) are shown alongside them for that reason; GOLD only shows
// gold-themed funds; 原物料(BROAD_COMMODITY)-themed funds are shown for every commodity since they
// don't target one specific one.
const THEME_FOR_COMMODITY: Record<CommodityKey, Array<"GOLD" | "ENERGY" | "BROAD_COMMODITY">> = {
  GOLD: ["GOLD", "BROAD_COMMODITY"],
  SILVER: ["BROAD_COMMODITY"],
  WTI_CRUDE: ["ENERGY", "BROAD_COMMODITY"],
  BRENT_CRUDE: ["ENERGY", "BROAD_COMMODITY"],
};

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const commodity = q.get("commodity");
  if (!commodity) {
    return Response.json({ ok: true, availableCommodities: COMMODITY_KEYS }, { headers });
  }
  if (!COMMODITY_KEYS.includes(commodity as CommodityKey)) {
    return Response.json({ ok: false, error: "UNKNOWN_COMMODITY", availableCommodities: COMMODITY_KEYS }, { status: 400, headers });
  }
  const sortParam = q.get("sort") ?? "";
  const sortKey = SORT_KEYS.includes(sortParam as typeof SORT_KEYS[number]) ? (sortParam as typeof SORT_KEYS[number]) : null;
  const direction: "asc" | "desc" = q.get("direction") === "asc" ? "asc" : "desc";
  const categoryParam = q.get("category") ?? "ALL";
  const category = CATEGORY_BUCKETS.includes(categoryParam as typeof CATEGORY_BUCKETS[number]) ? (categoryParam as typeof CATEGORY_BUCKETS[number]) : "ALL";

  const entries = COMMODITY_ETF_MAPPING.filter((e) => e.commodity === commodity);
  const codes = entries.map((e) => e.code);
  const rows = await prisma.etf.findMany({
    where: { code: { in: codes } },
    select: { code: true, name: true, id: true, isActive: true, latestPrice: true, priceUpdatedAt: true },
  });
  const byCode = new Map(rows.map((r) => [r.code, r]));

  // 2026-11-07（第32輪指令第3點核實發現）: 這支route原本直接讀 prisma.etf 的 returnYtd/return1y
  // 兩個扁平欄位——跟 app/api/rankings/performance/route.ts 2026-11-06 記錄過的同一個「跟
  // etf_performances 最新一筆對不上」的過期欄位問題一樣，不准再用；改成跟 reverseIndex.ts 一樣的
  // latest-row-by-date 查法，順便把 1M/3M/6M/3Y/5Y/AUM/配息率都補進來，給排序用。
  const perfRows: PerfRow[] = codes.length ? await prisma.$queryRaw<PerfRow[]>`
    WITH latest_perf AS (
      SELECT DISTINCT ON (etf_id) etf_id, date, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y
      FROM etf_performances WHERE etf_id IN (SELECT id FROM etfs WHERE code = ANY(${codes})) ORDER BY etf_id, date DESC
    )
    SELECT e.code, e.category, e.aum::text aum, e.dividend_yield::text dividend_yield,
      lp.return_1m::text return_1m, lp.return_3m::text return_3m, lp.return_6m::text return_6m, lp.return_ytd::text return_ytd,
      lp.return_1y::text return_1y, lp.return_3y::text return_3y, lp.return_5y::text return_5y, lp.date::text perf_date
    FROM etfs e LEFT JOIN latest_perf lp ON lp.etf_id = e.id WHERE e.code = ANY(${codes})
  ` : [];
  const perfByCode = new Map(perfRows.map((r) => [r.code, r]));

  type CommodityResult = ReturnType<typeof buildResult>;
  function buildResult(e: typeof entries[number]) {
    const row = byCode.get(e.code);
    const perf = perfByCode.get(e.code);
    const bucket: AssetCategoryBucket = classifyEtfBucketJs(e.code, e.name, perf?.category ?? null);
    const metric = sortKey ? (sortKey === "aum" ? toNum(perf?.aum ?? null) : sortKey === "dividend_yield" ? toNum(perf?.dividend_yield ?? null) : toNum((perf as PerfRow | undefined)?.[sortKey] ?? null)) : null;
    const metricAsOfDate = sortKey && PERFORMANCE_SORTS.includes(sortKey as typeof PERFORMANCE_SORTS[number]) ? (perf?.perf_date ?? null) : null;
    return {
      code: e.code,
      name: e.name,
      direction: e.direction,
      leverage: e.leverage,
      id: row?.id ?? null,
      isActive: row?.isActive ?? null,
      latestPrice: row?.latestPrice ? Number(row.latestPrice) : null,
      priceDate: row?.priceUpdatedAt ?? null,
      returnYtdPct: toNum(perf?.return_ytd ?? null),
      return1YPct: toNum(perf?.return_1y ?? null),
      category: bucket,
      metric,
      metricAsOfDate,
    };
  }
  let results: CommodityResult[] = entries.map(buildResult);
  if (category !== "ALL") results = results.filter((r) => r.category === category);
  if (sortKey) {
    // 資料不足的排最後，不當 0（2026-11-07 第32輪指令第5點）。
    results = [...results].sort((a, b) => {
      if (a.metric === null && b.metric === null) return a.code.localeCompare(b.code);
      if (a.metric === null) return 1;
      if (b.metric === null) return -1;
      return direction === "asc" ? a.metric - b.metric : b.metric - a.metric;
    });
  }

  const themes = THEME_FOR_COMMODITY[commodity as CommodityKey];
  const thematicEntries = THEMATIC_COMMODITY_FUNDS.filter((f) => themes.includes(f.theme));
  const thematicFundCodes = thematicEntries.map((f) => f.code);
  const thematicFundRows = thematicFundCodes.length
    ? await prisma.fund.findMany({ where: { code: { in: thematicFundCodes } }, select: { code: true, name: true, id: true, isActive: true, latestNav: true, latestNavDate: true, category: true } })
    : [];
  const thematicByCode = new Map(thematicFundRows.map((r) => [r.code, r]));
  let thematicFunds = thematicEntries.map((e) => {
    const row = thematicByCode.get(e.code);
    const bucket: AssetCategoryBucket = classifyFundBucketJs(row?.category ?? null);
    return {
      code: e.code, name: e.name, theme: e.theme,
      id: row?.id ?? null, isActive: row?.isActive ?? null,
      latestNav: row?.latestNav ? Number(row.latestNav) : null, navDate: row?.latestNavDate ?? null,
      exposureNote: "間接曝險（投資該產業股票/債券的主題型基金，非直接持有商品期貨）",
      category: bucket,
      metric: null as number | null, // 沒有績效資料可用於排序（主題基金這支route目前沒有join fund_performances）
    };
  });
  if (category !== "ALL") thematicFunds = thematicFunds.filter((f) => f.category === category);

  return Response.json({
    ok: true, commodity, total: results.length, generated_at: new Date().toISOString(),
    results,
    thematicFunds,
    metricUnavailableCount: sortKey ? results.filter((r) => r.metric === null).length : 0,
    scopeNote: "複委託可買的海外商品ETF（如SPDR Gold Shares等）不在本資料庫中（沒有「可複委託交易」的清單或旗標），本端點無法涵蓋，不是遺漏。",
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
