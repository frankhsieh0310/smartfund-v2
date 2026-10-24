// 選股反查：商品期貨技術面篩選（2026-10-24 使用者核准定案，修App的「原物料技術選股反查」）。
// 根因：App端(src/advancedLookup/api.ts的runCommodityTechnicalScreener)原本打的是
// /api/screener/technical?scope=commodity——那支route從來沒有讀過scope參數（確認過git歷史，
// 從一開始就是股票專用），回傳的欄位(ticker/company_name)也跟App期待的商品欄位
// (yahooSymbol/directTwEtfCommodityKey/hasDirectTwEtf)對不上，點了等於完全沒反應。這支是獨立新
// route（不是硬塞進股票那支，資料模型不一樣：market_data沒有股票的history table結構，且商品只有
// 6檔，不需要股票那種LATERAL-join-全市場的bounded查詢）。
//
// 商品沒有像stock_technical那樣的每日預先算好指標表，直接對market_data（既有OHLCV）即時算
// （reuse lib/cron/stockTechnicalDaily.ts的computeTechnicalSeries——純函式，跟市場無關）：6檔
// 商品，即時算一次的成本可以忽略，不需要另外建cron。
//
// 已知限制（揭露，不在這次修復範圍內）：market_data商品價格停在2026-08-18（約2個月前），是
// lib/cron/commodityUpdate.ts這條既有pipeline本身的新鮮度問題，不是這支screener的bug——商品技術
// 面計算本身在既有資料上是正確的，等那條pipeline修好資料就會自動跟著新。
import { prisma } from "@/lib/prisma";
import { computeTechnicalSeries, type PricePoint } from "@/lib/cron/stockTechnicalDaily";
import { etfsForCommodity, type CommodityKey as EtfMappingCommodityKey } from "@/lib/data-platform/commodityEtfMapping";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

const COMMODITIES: Array<{ yahooSymbol: string; name: string; mappingKey: EtfMappingCommodityKey | null }> = [
  { yahooSymbol: "GC=F", name: "黃金期貨", mappingKey: "GOLD" },
  { yahooSymbol: "SI=F", name: "白銀期貨", mappingKey: "SILVER" },
  { yahooSymbol: "CL=F", name: "WTI原油期貨", mappingKey: "WTI_CRUDE" },
  { yahooSymbol: "BZ=F", name: "布蘭特原油期貨", mappingKey: "BRENT_CRUDE" },
  { yahooSymbol: "HG=F", name: "銅期貨", mappingKey: null },
  { yahooSymbol: "ZS=F", name: "黃豆期貨", mappingKey: null },
];

type Condition =
  | { field: "rsi14"; op: "lt" | "gt"; value: number }
  | { field: "macd_histogram"; op: "lt" | "gt"; value: number }
  | { field: "price_vs_ma20"; op: "above" | "below" };

function parseConditions(q: URLSearchParams): Condition[] {
  const conditions: Condition[] = [];
  const rsiBelow = q.get("rsi_below"), rsiAbove = q.get("rsi_above");
  if (rsiBelow !== null && Number.isFinite(Number(rsiBelow))) conditions.push({ field: "rsi14", op: "lt", value: Number(rsiBelow) });
  if (rsiAbove !== null && Number.isFinite(Number(rsiAbove))) conditions.push({ field: "rsi14", op: "gt", value: Number(rsiAbove) });
  const macdBelow = q.get("macd_histogram_below"), macdAbove = q.get("macd_histogram_above");
  if (macdBelow !== null && Number.isFinite(Number(macdBelow))) conditions.push({ field: "macd_histogram", op: "lt", value: Number(macdBelow) });
  if (macdAbove !== null && Number.isFinite(Number(macdAbove))) conditions.push({ field: "macd_histogram", op: "gt", value: Number(macdAbove) });
  const priceVsMa20 = q.get("price_vs_ma20");
  if (priceVsMa20 === "above" || priceVsMa20 === "below") conditions.push({ field: "price_vs_ma20", op: priceVsMa20 });
  return conditions;
}

function matches(conditions: Condition[], row: { rsi14: number | null; macdHistogram: number | null; ma20: number | null; latestPrice: number | null }): boolean {
  return conditions.every((c) => {
    if (c.field === "rsi14") return row.rsi14 !== null && (c.op === "lt" ? row.rsi14 < c.value : row.rsi14 > c.value);
    if (c.field === "macd_histogram") return row.macdHistogram !== null && (c.op === "lt" ? row.macdHistogram < c.value : row.macdHistogram > c.value);
    return row.ma20 !== null && row.latestPrice !== null && (c.op === "above" ? row.latestPrice > row.ma20 : row.latestPrice < row.ma20);
  });
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const conditions = parseConditions(q);
  if (conditions.length === 0) {
    return Response.json({ ok: false, error: "NO_CONDITIONS", hint: "rsi_below|rsi_above|macd_histogram_below|macd_histogram_above=<number>, price_vs_ma20=above|below" }, { status: 400, headers });
  }

  const results = await Promise.all(COMMODITIES.map(async (c) => {
    const history = await prisma.$queryRawUnsafe<{ date: Date; close: string; high: string | null; low: string | null }[]>(
      `SELECT date, close::text, high::text, low::text FROM market_data WHERE symbol = $1 AND type = 'COMMODITY' ORDER BY date ASC`,
      c.yahooSymbol,
    );
    if (!history.length) return null;
    const prices: PricePoint[] = history.map((h) => ({ date: h.date, close: Number(h.close), high: h.high !== null ? Number(h.high) : null, low: h.low !== null ? Number(h.low) : null }));
    const series = computeTechnicalSeries(prices);
    const latest = series.at(-1);
    if (!latest) return null;
    const latestPrice = Number(history.at(-1)!.close);
    const row = { rsi14: latest.rsi14, macdHistogram: latest.macdHistogram, ma20: latest.ma20, latestPrice };
    if (!matches(conditions, row)) return null;
    const hasDirectTwEtf = c.mappingKey !== null && etfsForCommodity(c.mappingKey).length > 0;
    return {
      assetType: "COMMODITY" as const,
      yahooSymbol: c.yahooSymbol,
      name: c.name,
      asOfDate: latest.date,
      rsi14: latest.rsi14,
      macdHistogram: latest.macdHistogram,
      latestPrice,
      directTwEtfCommodityKey: hasDirectTwEtf ? c.mappingKey : null,
      hasDirectTwEtf,
    };
  }));

  const matched = results.filter((r): r is NonNullable<typeof r> => r !== null);
  return Response.json({ ok: true, conditions, total: matched.length, generated_at: new Date().toISOString(), results: matched }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
