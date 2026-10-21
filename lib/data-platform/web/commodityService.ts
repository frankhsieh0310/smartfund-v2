// 2026-10-21（14點任務第3項）: App商品反查/詳情頁一直讀取舊的 market_master/market_data
// （type='COMMODITY'），但那條資料管線已經在2026-08-18停止更新（VERIFIED：crypto也是同一天
// 卡住，是同一個已停用的舊管線，不是這次改動造成的）。「Commodity Core Universe」這套新系統
// （lib/cron/commodityUpdate.ts + commodityTechnicalUpdate.ts）其實每天都在正常跑，把18個
// 商品期貨的即時價格寫進 futures_root_market_observations、技術指標寫進
// futures_technical_analytics——只是從來沒有任何網站/App的讀取路徑接上它。這裡補上這條讀取
// 路徑，只讀不寫，不動兩個cron本身一行程式碼。
import { prisma } from "../../prisma.ts";
import { CORE_COMMODITY_ROOTS } from "../../cron/commodityUpdate.ts";

function resolveRoot(idOrSymbol: string) {
  const needle = idOrSymbol.trim().toLowerCase();
  return CORE_COMMODITY_ROOTS.find((r) => r.rootId.toLowerCase() === needle || r.yahooSymbol.toLowerCase() === needle) ?? null;
}

export function isCoreCommodityRoot(idOrSymbol: string): boolean {
  return resolveRoot(idOrSymbol) !== null;
}

interface TechnicalMetrics {
  rsi14?: number;
  sma?: Record<string, number>;
  ema?: Record<string, number>;
  macd?: { macd: number; signal: number; histogram: number };
  bollinger?: { upper: number; middle: number; lower: number };
  kd?: { k: number; d: number };
}

export async function getCommodityDetail(idOrSymbol: string) {
  const root = resolveRoot(idOrSymbol);
  if (!root) return null;
  const [latest, latestTechnical] = await Promise.all([
    prisma.$queryRawUnsafe<{ observed_date: Date; close: string; open: string | null; high: string | null; low: string | null; source: string }[]>(
      `SELECT observed_date, close, open, high, low, source FROM futures_root_market_observations WHERE root_id = $1::uuid ORDER BY observed_date DESC LIMIT 2`,
      root.rootId,
    ),
    prisma.$queryRawUnsafe<{ metrics: TechnicalMetrics; observed_at: Date }[]>(
      `SELECT metrics, observed_at FROM futures_technical_analytics WHERE root_id = $1::uuid AND timeframe = '1d' ORDER BY observed_at DESC LIMIT 1`,
      root.rootId,
    ),
  ]);
  const current = latest[0] ?? null;
  const previous = latest[1] ?? null;
  const close = current ? Number(current.close) : null;
  const prevClose = previous ? Number(previous.close) : null;
  const technical = latestTechnical[0]?.metrics ?? null;
  return {
    identity: { assetType: "COMMODITY" as const, id: root.rootId, symbol: root.yahooSymbol, name: root.name, displayName: root.name, currency: "USD", market: "COMEX/CBOT/NYMEX/ICE", country: null },
    metrics: {
      priceOrNav: close,
      change: close != null && prevClose != null ? close - prevClose : null,
      changePercent: close != null && prevClose ? ((close / prevClose) - 1) * 100 : null,
      currency: "USD",
      asOfDate: current?.observed_date.toISOString() ?? null,
    },
    liteMetrics: [
      { key: "rsi14", label: "RSI 14", value: technical?.rsi14 != null ? Number(technical.rsi14.toFixed(2)) : null },
      { key: "sma20", label: "SMA 20", value: technical?.sma?.["20"] != null ? Number(technical.sma["20"].toFixed(2)) : null },
      { key: "ema12", label: "EMA 12", value: technical?.ema?.["12"] != null ? Number(technical.ema["12"].toFixed(2)) : null },
      { key: "macd", label: "MACD", value: technical?.macd?.macd != null ? Number(technical.macd.macd.toFixed(2)) : null },
      { key: "bollingerUpper", label: "布林通道上緣", value: technical?.bollinger?.upper != null ? Number(technical.bollinger.upper.toFixed(2)) : null },
      { key: "bollingerLower", label: "布林通道下緣", value: technical?.bollinger?.lower != null ? Number(technical.bollinger.lower.toFixed(2)) : null },
      { key: "kdK", label: "KD K值", value: technical?.kd?.k != null ? Number(technical.kd.k.toFixed(2)) : null },
    ],
    source: current?.source ?? "SMARTMATCH_COMMODITY_V1",
    asOfDate: current?.observed_date.toISOString() ?? null,
  };
}

export async function getCommodityHistory(idOrSymbol: string, from: Date | null) {
  const root = resolveRoot(idOrSymbol);
  if (!root) return null;
  const rows = await prisma.$queryRawUnsafe<{ observed_date: Date; close: string; source: string }[]>(
    `SELECT observed_date, close, source FROM futures_root_market_observations WHERE root_id = $1::uuid ${from ? "AND observed_date >= $2::date" : ""} ORDER BY observed_date ASC LIMIT 5000`,
    ...(from ? [root.rootId, from.toISOString().slice(0, 10)] : [root.rootId]),
  );
  return {
    points: rows.map((row) => ({ date: row.observed_date.toISOString(), value: Number(row.close) })),
    latestDate: rows.at(-1)?.observed_date ?? null,
    source: rows.at(-1)?.source ?? "SMARTMATCH_COMMODITY_V1",
  };
}
