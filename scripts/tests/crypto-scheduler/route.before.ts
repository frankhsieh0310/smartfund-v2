// Global Crypto Data Platform — cloud cron worker, mirrors app/api/cron/yahoo-index/route.ts.
// Adds Yahoo as a new provider alongside the existing multi-exchange (Binance/Coinbase/Kraken/
// Bybit/OKX/Deribit/BitMEX) crypto pipeline — never touches those exchanges' data.
//
//   /api/cron/yahoo-crypto?phase=bootstrap -> idempotent upsert of the "yahoo" exchange + markets
//   /api/cron/yahoo-crypto?phase=quote     -> Yahoo Spark multi-symbol batch (20/request) ->
//                                              crypto_market_snapshots (stale-guarded, 24/7).
//   /api/cron/yahoo-crypto?phase=history   -> Yahoo Chart per-market incremental ->
//                                              crypto_candles (idempotent upsert).
//   /api/cron/yahoo-crypto?phase=marketcap -> Yahoo crypto screener -> crypto_market_cap_supply.
//
// Run-logged (production_scheduler_runs) and checkpointed (production_scheduler_checkpoints),
// reusing lib/cloud-ingestion/runContext.ts exactly as yahoo-fx/yahoo-index already do.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { updateCryptoQuotes, updateCryptoHistory, updateCryptoMarketCapSupply, ensureYahooCryptoUniverse, CORE_CRYPTO_SYMBOLS } from "@/lib/cron/cryptoUpdate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const TIME_BUDGET_MS = 240_000;
const HISTORY_BATCH_SIZE = 2;
const HISTORY_MAX_SAFE_RUNTIME_MS = 180_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const phase = (url.searchParams.get("phase") ?? "quote").toLowerCase();
  const batch = Math.min(20, Math.max(1, Number(url.searchParams.get("batch")) || 20));
  const started = Date.now();
  const JOB = `YAHOO_CRYPTO_${phase.toUpperCase()}`;

  if (phase === "bootstrap") {
    const runKey = `yahoo-crypto-bootstrap:${new Date().toISOString().slice(0, 13)}`;
    const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: 0, checkpointBefore: null });
    if (skipped) return Response.json({ ok: true, task: "yahoo-crypto", phase, skipped: true });
    try {
      const result = await ensureYahooCryptoUniverse();
      await finishRun(runId, JOB, "YAHOO", started, { status: "COMPLETED", attempted: result.created, completed: result.created, inserted: result.newAsset, updated: result.reusedAsset, failed: 0, retryableFailures: 0, checkpointAfter: null, details: result });
      return Response.json({ ok: true, task: "yahoo-crypto", phase, ...result });
    } catch (e) {
      await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
      return Response.json({ ok: false, task: "yahoo-crypto", phase, error: (e as Error).message }, { status: 500 });
    }
  }

  if (phase === "marketcap") {
    const runKey = `yahoo-crypto-marketcap:${new Date().toISOString().slice(0, 10)}`;
    const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: 0, checkpointBefore: null });
    if (skipped) return Response.json({ ok: true, task: "yahoo-crypto", phase, skipped: true });
    try {
      const result = await updateCryptoMarketCapSupply();
      await finishRun(runId, JOB, "YAHOO", started, { status: "COMPLETED", attempted: result.updated + result.failed, completed: result.updated, inserted: 0, updated: result.updated, failed: result.failed, retryableFailures: result.failed, checkpointAfter: null, details: result });
      return Response.json({ ok: true, task: "yahoo-crypto", phase, ...result });
    } catch (e) {
      await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
      return Response.json({ ok: false, task: "yahoo-crypto", phase, error: (e as Error).message }, { status: 500 });
    }
  }

  if (phase !== "quote" && phase !== "history") {
    return Response.json({ ok: false, task: "yahoo-crypto", error: `Unknown phase: ${phase}. Use bootstrap|quote|history|marketcap.` }, { status: 400 });
  }

  const scope = url.searchParams.get("scope") === "smoke" ? CORE_CRYPTO_SYMBOLS.slice(0, 5) : undefined;
  const cpKey = `yahoo-crypto-${phase}${scope ? "-smoke" : ""}`;
  const runKey = `${cpKey}:${new Date().toISOString().slice(0, 13)}`;
  const cpBefore = await readCheckpoint(cpKey);
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: cpBefore });
  if (skipped) return Response.json({ ok: true, task: "yahoo-crypto", phase, skipped: true });

  try {
    let cursor = cpBefore?.lastSymbol ?? null;
    if (phase === "quote") {
      let requestedMarkets = 0, updatedMarkets = 0, staleSkipped = 0, noNewData = 0;
      const failedMarkets: Array<{ id: string; symbol: string; reason: string }> = [];
      let wrapped = false, slices = 0;
      while (Date.now() - started < TIME_BUDGET_MS) {
        const r = await updateCryptoQuotes(cursor, batch, scope);
        requestedMarkets += r.requestedMarkets; updatedMarkets += r.updatedMarkets; staleSkipped += r.staleSkipped; noNewData += r.noNewData;
        failedMarkets.push(...r.failedMarkets);
        cursor = r.lastId; slices++;
        if (r.wrapped) { wrapped = true; break; }
      }
      const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedMarkets, succeeded: (cpBefore?.succeeded ?? 0) + updatedMarkets, failed: failedMarkets.length };
      await writeCheckpoint(JOB, cpKey, runId, cpAfter);

      await finishRun(runId, JOB, "YAHOO", started, { status: failedMarkets.length > 0 && updatedMarkets === 0 ? "PARTIAL" : "COMPLETED", attempted: requestedMarkets, completed: updatedMarkets, inserted: 0, updated: updatedMarkets, failed: failedMarkets.length, retryableFailures: failedMarkets.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, staleSkipped, noNewData } });
      return Response.json({ ok: true, task: "yahoo-crypto", phase, requestedMarkets, updatedMarkets, staleSkipped, noNewData, failedMarkets, wrapped, slices });
    } else {
      let requestedMarkets = 0, updatedMarkets = 0, rowsWritten = 0;
      const failedMarkets: Array<{ id: string; symbol: string; reason: string }> = [];
      let wrapped = false, slices = 0;
      while (Date.now() - started < HISTORY_MAX_SAFE_RUNTIME_MS) {
        const r = await updateCryptoHistory(cursor, HISTORY_BATCH_SIZE, scope);
        requestedMarkets += r.requestedMarkets; updatedMarkets += r.updatedMarkets; rowsWritten += r.rowsWritten;
        failedMarkets.push(...r.failedMarkets);
        cursor = r.lastId; slices++;
        const cpAfter = { lastSymbol: r.wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedMarkets, succeeded: (cpBefore?.succeeded ?? 0) + updatedMarkets, failed: failedMarkets.length };
        await writeCheckpoint(JOB, cpKey, runId, cpAfter);
        if (r.wrapped) { wrapped = true; break; }
        if (Date.now() - started >= HISTORY_MAX_SAFE_RUNTIME_MS) break;
      }
      const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedMarkets, succeeded: (cpBefore?.succeeded ?? 0) + updatedMarkets, failed: failedMarkets.length };
      await finishRun(runId, JOB, "YAHOO", started, { status: failedMarkets.length > 0 && updatedMarkets === 0 && rowsWritten === 0 ? "PARTIAL" : "COMPLETED", attempted: requestedMarkets, completed: updatedMarkets, inserted: rowsWritten, updated: 0, failed: failedMarkets.length, retryableFailures: failedMarkets.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, batchSize: HISTORY_BATCH_SIZE } });
      return Response.json({ ok: true, task: "yahoo-crypto", phase, requestedMarkets, updatedMarkets, rowsWritten, failedMarkets, wrapped, slices });
    }
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: cpBefore, error: (e as Error).message });
    return Response.json({ ok: false, task: "yahoo-crypto", phase, error: (e as Error).message }, { status: 500 });
  }
}
