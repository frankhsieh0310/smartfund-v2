// 2026-11-08（使用者核准，第38輪指令第二點）: 獨立的「台股收盤結算重查」排程——不動
// run-production-yahoo-daily.ts這支核心排程（那支一旦某天every active TW股票都湊到一筆
// 「格式正確」的資料就整天不會再跑，沒有「結算」概念，改它風險太高，這裡用新增一支獨立排程
// 繞開）。台北時間晚上九點以後，把當天全部台股的收盤價/成交量重新向雅虎抓一次，直接覆蓋當天
// 那筆資料（同一來源YAHOO的row才覆蓋；TWSE_OFFICIAL/TPEX_OFFICIAL的官方row一律不動）。分批＋
// 時間預算，每檔間隔跟其他排程一樣禮貌節流，凌晨01:00-05:30不跑。
import { prisma } from "@/lib/prisma";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { fetchYahooChart } from "@/lib/services/dataProviders/yahoo/yahooClient";

export const runtime = "nodejs";
export const maxDuration = 290;
export const dynamic = "force-dynamic";

const JOB = "TW_CLOSE_SETTLE_RECHECK";
const CHECKPOINT_KEY = "tw-close-settle-recheck:daily-cursor";
const REQUEST_DELAY_MS = 400;
const TIME_BUDGET_MS = 260_000;

function isWriteEnabled(): boolean {
  return process.env.TW_CLOSE_SETTLE_RECHECK_WRITE?.trim() === "on";
}
function todayTaipeiKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function taipeiDateKey(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function isWithinMaintenanceBlackout(now: Date): boolean {
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const minutesOfDay = utcH * 60 + utcM;
  return minutesOfDay >= 17 * 60 && minutesOfDay <= 21 * 60 + 30; // 01:00-05:30 台北 = UTC 17:00-21:30
}
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  if (isWithinMaintenanceBlackout(new Date())) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "MAINTENANCE_BLACKOUT_0100_0530_TAIPEI" });
  }

  const startedMs = Date.now();
  const writeEnabled = isWriteEnabled();
  const targetDate = todayTaipeiKey();

  const stocks = await prisma.stock.findMany({
    where: { isActive: true, country: "TW", exchange: { in: ["TWSE", "TPEx", "TPEX"] } },
    orderBy: { ticker: "asc" },
    select: { id: true, ticker: true, yahooSymbol: true },
  });

  const storedCheckpoint = await readCheckpoint(CHECKPOINT_KEY);
  const isFromToday = taipeiDateKey(storedCheckpoint?.updatedAt ?? null) === targetDate;
  const effectiveCheckpoint = isFromToday ? storedCheckpoint : null;
  const startIndex = effectiveCheckpoint?.lastSymbol ? stocks.findIndex((s) => s.ticker === effectiveCheckpoint.lastSymbol) + 1 : 0;

  const runKey = `${JOB}:${targetDate}:starting-at-${Math.max(startIndex, 0)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_CHART_API", runKey,
    universeCount: stocks.length, batchSize: stocks.length - Math.max(startIndex, 0), checkpointBefore: effectiveCheckpoint,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "double trigger", runKey });

  let processed = 0, written = 0, skippedOfficial = 0, noData = 0, failed = 0;
  let lastTicker: string | null = effectiveCheckpoint?.lastSymbol ?? null;
  let index = Math.max(startIndex, 0);
  const dateObj = new Date(`${targetDate}T00:00:00.000Z`);

  for (; index < stocks.length; index++) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) break;
    const stock = stocks[index];
    processed++;
    try {
      const existing = await prisma.stockHistory.findUnique({
        where: { stockId_date: { stockId: stock.id, date: dateObj } },
        select: { source: true },
      });
      if (existing && ["TWSE_OFFICIAL", "TPEX_OFFICIAL"].includes(existing.source ?? "")) {
        skippedOfficial++;
      } else {
        // fetchYahooChart（lib/services/dataProviders/yahoo/yahooClient.ts共用版本）是
        // (symbol, range, interval) 簽名，不是run-production-yahoo-daily.ts那支自己本地定義、
        // 用period1/period2日期窗的同名函式（兩支不是同一支、不能互換呼叫）——這裡用"1mo"範圍
        // 抓最近一個月的日K，從裡面挑出跟targetDate同一天（轉台北時區）的那根K棒。
        const chart = await fetchYahooChart(stock.yahooSymbol, "1mo", "1d");
        const candle = chart?.candles.find((c) => {
          const taipei = new Date(c.date.getTime() + 8 * 60 * 60 * 1000);
          return taipei.toISOString().slice(0, 10) === targetDate;
        });
        if (candle && candle.close != null && candle.volume != null) {
          if (writeEnabled) {
            await prisma.$executeRawUnsafe(
              `INSERT INTO stock_history (id, stock_id, date, open, high, low, close, volume, source, source_symbol, provider_method, created_at, updated_at, imported_at)
               VALUES (gen_random_uuid()::text, $1, $2::date, $3, $4, $5, $6, $7, 'YAHOO', $8, 'YAHOO_CHART_API_SETTLE_RECHECK', NOW(), NOW(), NOW())
               ON CONFLICT (stock_id, date) DO UPDATE SET
                 open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume,
                 source = EXCLUDED.source, source_symbol = EXCLUDED.source_symbol, provider_method = EXCLUDED.provider_method, updated_at = NOW()`,
              stock.id, targetDate, candle.open, candle.high, candle.low, candle.close, candle.volume, stock.yahooSymbol,
            );
            await prisma.stock.updateMany({ where: { id: stock.id, latestDate: dateObj }, data: { latestClose: candle.close } });
          }
          written++;
        } else {
          noData++;
        }
      }
      lastTicker = stock.ticker;
      await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
        lastSymbol: lastTicker,
        processed: (isFromToday ? effectiveCheckpoint?.processed ?? 0 : 0) + processed,
        succeeded: (isFromToday ? effectiveCheckpoint?.succeeded ?? 0 : 0) + written,
        failed: (isFromToday ? effectiveCheckpoint?.failed ?? 0 : 0) + failed,
      });
      await sleep(REQUEST_DELAY_MS);
    } catch (e) {
      failed++;
      lastTicker = stock.ticker;
      await sleep(REQUEST_DELAY_MS);
    }
  }

  const reachedEnd = index >= stocks.length;
  if (reachedEnd) {
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: null, processed, succeeded: written, failed, updatedAt: null });
  }

  await finishRun(runId, JOB, "YAHOO_CHART_API", startedMs, {
    status: reachedEnd ? "COMPLETED" : "PARTIAL",
    attempted: processed, completed: written, inserted: 0, updated: written, failed, retryableFailures: 0,
    checkpointAfter: { lastSymbol: reachedEnd ? null : lastTicker, processed, succeeded: written, failed, updatedAt: null },
  });

  return Response.json({ ok: true, job: JOB, targetDate, processed, written, skippedOfficial, noData, failed, writeEnabled, reachedEnd, universeCount: stocks.length, startIndex: Math.max(startIndex, 0) });
}
