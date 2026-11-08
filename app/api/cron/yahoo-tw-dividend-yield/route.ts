// 台股 ETF 現金殖利率 — 專讀 Yahoo奇摩自己的股利頁（lib/yahoo/twDividendYieldPage.ts），不
// 用 Yahoo Finance 全球 quoteSummary（lib/yahoo/etfEnrich.ts 的 summaryDetail.yield 跟 Yahoo奇摩
// 算法不同，兩者對不上——這是 2026-11-08 使用者實測回報「配息率跟雅虎奇摩不一致」的修正）。
// 範圍只限 TW 掛牌（TWSE/TPEx）、幣別 TWD、代碼不含點的 ETF——跟既有 DIVIDEND_YIELD 排行
// （lib/yahoo/distributionYield.ts）用的篩選條件一致。
// 遇到 401/403/429 立刻停止整個批次並回報，不重試、不換 header/IP（CLAUDE.md 資料來源原則）。

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { fetchYahooTwCashDividendYield, YahooTwDividendRateLimitedError } from "@/lib/yahoo/twDividendYieldPage";
import { sleep } from "@/lib/yahoo/productSession";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "YAHOO_TW_DIVIDEND_YIELD";
const CP_KEY = "yahoo-tw-dividend-yield";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const batch = Math.min(100, Math.max(1, Number(url.searchParams.get("batch")) || 40));
  const pace = Math.min(4000, Math.max(200, Number(url.searchParams.get("pace")) || 800));
  const started = Date.now();
  const runKey = `${CP_KEY}:${new Date().toISOString().slice(0, 13)}`;

  const cpBefore = await readCheckpoint(CP_KEY);
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_TW", runKey, universeCount: 0, batchSize: batch, checkpointBefore: cpBefore,
  });
  if (skipped) return Response.json({ ok: true, task: "yahoo-tw-dividend-yield", skipped: true });

  const cursor = cpBefore?.lastSymbol ?? null;
  try {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT id::text, code,
              CASE WHEN exchange = 'TWSE' THEN code || '.TW' WHEN exchange = 'TPEx' THEN code || '.TWO' END AS symbol
         FROM etfs
        WHERE is_active = true AND currency = 'TWD' AND position('.' in code) = 0
          AND exchange IN ('TWSE', 'TPEx') AND ($1::text IS NULL OR id > $1)
        ORDER BY id LIMIT $2`,
      cursor, batch,
    )) as Array<{ id: string; code: string; symbol: string }>;

    let attempted = 0, updated = 0, noData = 0, failed = 0, lastId = cursor;
    let rateLimited: { httpStatus: number } | null = null;
    for (const e of rows) {
      lastId = e.id;
      attempted++;
      try {
        const result = await fetchYahooTwCashDividendYield(e.symbol);
        if (!result) { noData++; continue; }
        await prisma.$executeRawUnsafe(
          `UPDATE etfs SET dividend_yield = $2, updated_at = NOW() WHERE id = $1`,
          e.id, (result.yieldPct / 100).toFixed(6),
        );
        updated++;
      } catch (err) {
        if (err instanceof YahooTwDividendRateLimitedError) { rateLimited = { httpStatus: err.httpStatus }; break; }
        failed++;
      }
      await sleep(pace);
    }

    const wrapped = !rateLimited && rows.length < batch;
    const cpAfter = {
      lastSymbol: wrapped ? null : lastId, processed: (cpBefore?.processed ?? 0) + attempted,
      succeeded: (cpBefore?.succeeded ?? 0) + updated, failed,
    };
    await writeCheckpoint(JOB, CP_KEY, runId, cpAfter);
    const details = {
      attempted, updated, noData, failed, rateLimited, wrapped,
      cursor_before: cursor, cursor_after: cpAfter.lastSymbol, runtime_ms: Date.now() - started,
    };
    await finishRun(runId, JOB, "YAHOO_TW", started, {
      status: rateLimited ? "FAILED" : (failed > 0 && updated === 0 ? "PARTIAL" : "COMPLETED"),
      attempted, completed: updated, inserted: 0, updated, failed, retryableFailures: failed,
      checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details,
    });
    if (rateLimited) {
      return Response.json({ ok: false, task: "yahoo-tw-dividend-yield", error: "RATE_LIMITED", ...details }, { status: 429 });
    }
    return Response.json({ ok: true, task: "yahoo-tw-dividend-yield", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO_TW", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1,
      checkpointAfter: cpBefore, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "yahoo-tw-dividend-yield", error: (e as Error).message }, { status: 500 });
  }
}
