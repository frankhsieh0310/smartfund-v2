// 2026-10-21（14點任務第4項，接續 commodityService.ts 的同一個發現）: App加密貨幣反查/詳情頁
// 讀取的 market_master/market_data（type='CRYPTO'）跟商品走同一條舊管線，同樣在2026-08-18停止
// 更新（VERIFIED，見 commodityService.ts 開頭說明）。現行的「Yahoo 全幣種加密貨幣雲端管線」
// （lib/cron/cryptoUpdate.ts）每天都在正常跑，把報價寫進 crypto_market_snapshots、K線寫進
// crypto_candles（market_id 格式固定為 "yahoo-{symbol}-usd"，VERIFIED：BTC/ADA/SOL/XRP/USDT
// 皆符合）——只是從來沒有任何讀取路徑接上它。這裡補上這條讀取路徑，只讀不寫，不動 cron 本身
// 一行程式碼。跟商品不同，crypto 沒有固定的「核心清單」常數可重用，所以用 market_id 是否真的
// 查得到資料來判斷是否走這條路徑，查不到就讓呼叫端 fallback 回舊的 market_data。
// 已知限制：crypto_candles 的補history是用checkpoint慢慢追趕8千多個市場，BTC目前落後約一個月
// （VERIFIED 2026-10-21：最新K線到09-13），但仍遠比凍結在08-18的market_data新，且持續在追趕中，
// 所以歷史走勢一律標 PARTIAL_CURRENT；報價（priceOrNav）用的是另一條每天多次更新的snapshot，
// 標 FULL。
import { prisma } from "../../prisma.ts";

function normalizeCryptoBase(idOrSymbol: string): string {
  return idOrSymbol.trim().toUpperCase().replace(/-USD$/, "");
}

function yahooMarketId(base: string): string {
  return `yahoo-${base.toLowerCase()}-usd`;
}

export async function getCryptoDetail(idOrSymbol: string) {
  const base = normalizeCryptoBase(idOrSymbol);
  const marketId = yahooMarketId(base);
  const [snapshot, asset] = await Promise.all([
    prisma.$queryRawUnsafe<{ observed_at: Date; price: string; change_24h: string | null; change_percent_24h: string | null; source: string }[]>(
      `SELECT observed_at, price, change_24h, change_percent_24h, source FROM crypto_market_snapshots WHERE market_id = $1 ORDER BY observed_at DESC LIMIT 1`,
      marketId,
    ),
    prisma.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM crypto_assets WHERE id = $1`, base.toLowerCase()),
  ]);
  const current = snapshot[0];
  if (!current) return null;
  const name = asset[0]?.name ?? base;
  const price = Number(current.price);
  return {
    identity: { assetType: "CRYPTO" as const, id: marketId, symbol: `${base}-USD`, name, displayName: name, currency: "USD", market: "Yahoo Finance", country: null },
    metrics: {
      priceOrNav: price,
      change: current.change_24h != null ? Number(current.change_24h) : null,
      changePercent: current.change_percent_24h != null ? Number(current.change_percent_24h) : null,
      currency: "USD",
      asOfDate: current.observed_at.toISOString(),
    },
    liteMetrics: [],
    source: current.source,
    asOfDate: current.observed_at.toISOString(),
  };
}

export async function getCryptoHistory(idOrSymbol: string, from: Date | null) {
  const base = normalizeCryptoBase(idOrSymbol);
  const marketId = yahooMarketId(base);
  const rows = await prisma.$queryRawUnsafe<{ open_time: Date; close: string; source: string }[]>(
    `SELECT open_time, close, source FROM crypto_candles WHERE market_id = $1 ${from ? "AND open_time >= $2::date" : ""} ORDER BY open_time ASC LIMIT 5000`,
    ...(from ? [marketId, from.toISOString().slice(0, 10)] : [marketId]),
  );
  if (!rows.length) return null;
  return {
    points: rows.map((row) => ({ date: row.open_time.toISOString(), value: Number(row.close) })),
    latestDate: rows.at(-1)?.open_time ?? null,
    source: rows.at(-1)?.source ?? "YAHOO_CHART",
  };
}
