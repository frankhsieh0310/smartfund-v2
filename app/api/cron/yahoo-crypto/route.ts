// Global Crypto Data Platform — cloud cron worker, mirrors app/api/cron/yahoo-index/route.ts.
// Adds Yahoo as a new provider alongside the existing multi-exchange (Binance/Coinbase/Kraken/
// Bybit/OKX/Deribit/BitMEX) crypto pipeline — never touches those exchanges' data.
//
//   /api/cron/yahoo-crypto?phase=bootstrap -> idempotent upsert of the "yahoo" exchange + markets
//   /api/cron/yahoo-crypto?phase=quote     -> Yahoo Spark multi-symbol batch (20/request) ->
//                                              crypto_market_snapshots (stale-guarded, 24/7).
//   /api/cron/yahoo-crypto?phase=history   -> Yahoo Chart per-market incremental ->
//                                              crypto_candles (idempotent upsert).
//   /api/cron/yahoo-crypto?phase=marketcap -> DB-keyset slice (max 250) -> Yahoo quote -> crypto_market_cap_supply.
//
// Run-logged (production_scheduler_runs) and checkpointed (production_scheduler_checkpoints),
// reusing lib/cloud-ingestion/runContext.ts exactly as yahoo-fx/yahoo-index already do.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { updateCryptoQuotes, updateCryptoHistory, ensureYahooCryptoUniverse, CORE_CRYPTO_SYMBOLS } from "@/lib/cron/cryptoUpdate";

import { cryptoRunKey, runMarketcapSlice, withCryptoLease } from "@/lib/cron/cryptoMarketcap";
import { isCryptoSyncWriteEnabled } from "@/lib/cron/cryptoWriteGate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const TIME_BUDGET_MS = 240_000;
const HISTORY_BATCH_SIZE = 2;
const HISTORY_MAX_SAFE_RUNTIME_MS = 180_000;
// This round's audit fix: marketcap previously ran exactly ONE 250-symbol slice per invocation with
// no internal loop (unlike quote/history, which both wrap-loop to completion already) — with only
// one daily trigger and an 8,209-row universe, that was a ~33-DAY full-pass cadence, the single
// worst daily-completion gap this round's audit found. Wrap-looping it here, the same pattern
// yahoo-commodity/yahoo-index/yahoo-fx already use, lets one invocation walk through every ~33
// slices (8,209/250) in well under the 280s maxDuration, since each slice's own internal budget
// (fetchMarketcapQuotes's 210s deadline) bounds a single slice's Yahoo fetch time, not the whole
// route — most slices finish in a few seconds. The lease acquired once below is held for the whole
// loop (6-minute expiry, comfortably longer than MARKETCAP_MAX_SAFE_RUNTIME_MS).
const MARKETCAP_MAX_SAFE_RUNTIME_MS = 250_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const phase = (new URL(request.url).searchParams.get("phase") ?? "quote").toLowerCase();
  if (!["quote", "marketcap", "history"].includes(phase)) return handleCryptoRequest(request);
  const invocation = request.headers.get("x-crypto-invocation-id");
  if (invocation && !/^[A-Za-z0-9_-]{1,80}$/.test(invocation)) return Response.json({ ok: false, error: "INVALID_INVOCATION_ID" }, { status: 400 });
  return withCryptoLease(phase, owner => phase === "marketcap"
    ? runMarketcapSlicesUntilDone(owner, invocation, isCryptoSyncWriteEnabled())
    : handleCryptoRequest(request));
}

async function runMarketcapSlicesUntilDone(owner: string, invocation: string | null, writeEnabled: boolean): Promise<Response> {
  const started = Date.now();
  let slices = 0, totalProcessed = 0, totalUpdated = 0, totalFailed = 0;
  let lastBody: Record<string, unknown> = {};
  while (Date.now() - started < MARKETCAP_MAX_SAFE_RUNTIME_MS) {
    const res = await runMarketcapSlice(owner, invocation, writeEnabled);
    lastBody = await res.json();
    slices++;
    if (lastBody.skipped || lastBody.ok === false) break;
    totalProcessed += Number(lastBody.processed ?? 0);
    totalUpdated += Number(lastBody.updated ?? 0);
    totalFailed += Number((lastBody.failedMarkets as unknown[] | undefined)?.length ?? 0);
    if (lastBody.wrapped) break;
  }
  return Response.json({ ...lastBody, task: "yahoo-crypto", phase: "marketcap", loopSlices: slices, loopTotalProcessed: totalProcessed, loopTotalUpdated: totalUpdated, loopTotalFailed: totalFailed });
}

async function handleCryptoRequest(request: Request) {
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

  if (phase !== "quote" && phase !== "history") {
    return Response.json({ ok: false, task: "yahoo-crypto", error: `Unknown phase: ${phase}. Use bootstrap|quote|history|marketcap.` }, { status: 400 });
  }

  const scope = url.searchParams.get("scope") === "smoke" ? CORE_CRYPTO_SYMBOLS.slice(0, 5) : undefined;
  const cpKey = `yahoo-crypto-${phase}${scope ? "-smoke" : ""}`;
  const runKey = phase === "quote" ? cryptoRunKey(cpKey.slice("yahoo-crypto-".length), started, request.headers.get("x-crypto-invocation-id")) : `${cpKey}:${new Date().toISOString().slice(0, 13)}`;
  const cpBefore = await readCheckpoint(cpKey);
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: cpBefore });
  if (skipped) return Response.json({ ok: true, task: "yahoo-crypto", phase, skipped: true });

  const writeEnabled = isCryptoSyncWriteEnabled();
  try {
    let cursor = cpBefore?.lastSymbol ?? null;
    if (phase === "quote") {
      let requestedMarkets = 0, updatedMarkets = 0, staleSkipped = 0, noNewData = 0;
      const failedMarkets: Array<{ id: string; symbol: string; reason: string }> = [];
      let wrapped = false, slices = 0;
      while (Date.now() - started < TIME_BUDGET_MS) {
        const r = await updateCryptoQuotes(cursor, batch, scope, writeEnabled);
        requestedMarkets += r.requestedMarkets; updatedMarkets += r.updatedMarkets; staleSkipped += r.staleSkipped; noNewData += r.noNewData;
        failedMarkets.push(...r.failedMarkets);
        cursor = r.lastId; slices++;
        if (r.wrapped) { wrapped = true; break; }
      }
      const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedMarkets, succeeded: (cpBefore?.succeeded ?? 0) + updatedMarkets, failed: failedMarkets.length };
      await writeCheckpoint(JOB, cpKey, runId, cpAfter);

      await finishRun(runId, JOB, "YAHOO", started, { status: failedMarkets.length > 0 && updatedMarkets === 0 ? "PARTIAL" : "COMPLETED", attempted: requestedMarkets, completed: updatedMarkets, inserted: 0, updated: updatedMarkets, failed: failedMarkets.length, retryableFailures: failedMarkets.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, staleSkipped, noNewData, writeEnabled } });
      return Response.json({ ok: true, task: "yahoo-crypto", phase, writeEnabled, requestedMarkets, updatedMarkets, staleSkipped, noNewData, failedMarkets, wrapped, slices });
    } else {
      let requestedMarkets = 0, updatedMarkets = 0, rowsWritten = 0;
      const failedMarkets: Array<{ id: string; symbol: string; reason: string }> = [];
      let wrapped = false, slices = 0;
      while (Date.now() - started < HISTORY_MAX_SAFE_RUNTIME_MS) {
        const r = await updateCryptoHistory(cursor, HISTORY_BATCH_SIZE, scope, writeEnabled);
        requestedMarkets += r.requestedMarkets; updatedMarkets += r.updatedMarkets; rowsWritten += r.rowsWritten;
        failedMarkets.push(...r.failedMarkets);
        cursor = r.lastId; slices++;
        const cpAfter = { lastSymbol: r.wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedMarkets, succeeded: (cpBefore?.succeeded ?? 0) + updatedMarkets, failed: failedMarkets.length };
        await writeCheckpoint(JOB, cpKey, runId, cpAfter);
        if (r.wrapped) { wrapped = true; break; }
        if (Date.now() - started >= HISTORY_MAX_SAFE_RUNTIME_MS) break;
      }
      const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedMarkets, succeeded: (cpBefore?.succeeded ?? 0) + updatedMarkets, failed: failedMarkets.length };
      await finishRun(runId, JOB, "YAHOO", started, { status: failedMarkets.length > 0 && updatedMarkets === 0 && rowsWritten === 0 ? "PARTIAL" : "COMPLETED", attempted: requestedMarkets, completed: updatedMarkets, inserted: rowsWritten, updated: 0, failed: failedMarkets.length, retryableFailures: failedMarkets.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, batchSize: HISTORY_BATCH_SIZE, writeEnabled } });
      return Response.json({ ok: true, task: "yahoo-crypto", phase, writeEnabled, requestedMarkets, updatedMarkets, rowsWritten, failedMarkets, wrapped, slices });
    }
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: cpBefore, error: (e as Error).message });
    return Response.json({ ok: false, task: "yahoo-crypto", phase, error: (e as Error).message }, { status: 500 });
  }
}
