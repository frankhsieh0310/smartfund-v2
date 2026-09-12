// FX Data Platform — one cron worker for the entire FX universe (Step 14: "one FX market updater
// -> entire active FX universe -> multi-symbol batch", not one cron per pair). Production scope is
// the full fx_coverage-validated Yahoo-direct universe (390 pairs), read from the DB, not
// hard-coded — see lib/cloud-ingestion/fxUniverse.ts:getActiveYahooDirectPairSymbols. The 162
// pairs Yahoo has no direct instrument for are covered by lib/cron/fxDerivedUpdate.ts, which reuses
// scripts/data/fx/run-derived-cross-rates.ts's 2-leg triangulation math (DB-only, zero Yahoo calls).
//
//   /api/cron/yahoo-fx?phase=seed      -> upsert the original 19-pair fixture (idempotent, fixture only)
//   /api/cron/yahoo-fx?phase=activate  -> validate ALL fx_pairs against Yahoo spark, tag
//                                          fx_coverage(YAHOO_DIRECT), add newly-discovered pairs.
//   /api/cron/yahoo-fx?phase=discovery -> weekly: re-validate YAHOO_DIRECT coverage for all fx_pairs
//                                          (same check as activate) and flip a pair inactive ONLY if
//                                          it lost direct coverage AND has no viable derived route
//                                          either (i.e. it's genuinely unquotable now). Never deletes
//                                          history.
//   /api/cron/yahoo-fx?phase=quote     -> full sweep: v7 spark batches (20 symbols/request) over all
//                                          390 direct pairs -> fx_latest_quotes (stale-guarded), then
//                                          automatically runs phase=derived on success (Step 6/7:
//                                          derived always follows a successful direct quote sweep,
//                                          same cadence, no separate cron).
//   /api/cron/yahoo-fx?phase=history   -> full sweep: v8 chart per pair, incremental only, over all
//                                          390 direct pairs -> fx_candles (idempotent upsert).
//   /api/cron/yahoo-fx?phase=derived   -> standalone derived-cross recompute (DB-only, 0 Yahoo calls)
//                                          -> fx_latest_quotes for the 162 derived-only pairs.
//   ...&scope=smoke on quote/history pins the working set to the original 19-pair fixture instead
//   of the full validated universe (smoke test / fast sanity check) and does not chain derived.
//
// quote/history now loop internally to full completion within one invocation (bounded by a time
// budget, same pattern as app/api/cron/yahoo-etf/route.ts) instead of one batch per cron tick, so a
// single hourly/daily trigger sweeps the whole universe in ~20 Yahoo requests, matching the
// production cadence design (Step 7/8).
//
// Run-logged (production_scheduler_runs) and checkpointed (production_scheduler_checkpoints),
// reusing lib/cloud-ingestion/runContext.ts exactly as yahoo-etf/yahoo-fund already do.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { seedFxUniverse, activateFullYahooDirectUniverse } from "@/lib/cloud-ingestion/fxUniverse";
import { prisma } from "@/lib/prisma";
import { fetchYahooFxSpark } from "@/lib/services/dataProviders/yahoo/yahooClient";
import { updateFxQuotes, updateFxHistory, CURATED_SYMBOLS } from "@/lib/cron/fxUpdate";
import { updateDerivedFxQuotes, pairHasViableDerivedRoute } from "@/lib/cron/fxDerivedUpdate";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

const TIME_BUDGET_MS = 240_000; // leaves headroom under maxDuration=280s for the final response

// 2026-09-12 history hotfix: a single 20-pair updateFxHistory() call was observed live to take
// long enough on Vercel's network (per-pair Yahoo chart fetch is far slower there than locally)
// that ONE batch alone could exceed the whole function's maxDuration — the outer while loop's
// TIME_BUDGET_MS check only runs BETWEEN calls, so it never got a chance to stop cleanly, and the
// run was hard-killed mid-batch with no checkpoint write and no finishRun. Fix: small batches
// (3-5 pairs, keeps a single call fast) + checkpoint written after EVERY batch (not just at the
// end) + a tighter, proactively-checked deadline. Quote is untouched — it already completes a
// 20-pair spark batch in one HTTP call, nothing like this risk applies there.
const HISTORY_BATCH_SIZE = 4;
const HISTORY_MAX_SAFE_RUNTIME_MS = 220_000;

async function validateAllPairs(): Promise<{ validation: Record<string, { ok: boolean; canonicalSymbol: string | null }>; validatedPairs: number }> {
  const aliases = await prisma.fxPairAlias.findMany({ where: { provider: { in: ["YAHOO_CHART", "YAHOO", "YAHOO-FINANCE2"] } }, orderBy: { provider: "asc" }, select: { pairSymbol: true, provider: true, providerSymbol: true } });
  const preferOrder = ["YAHOO_CHART", "YAHOO", "YAHOO-FINANCE2"];
  const byPair = new Map<string, string>();
  for (const pref of preferOrder) for (const a of aliases) if (a.provider === pref && !byPair.has(a.pairSymbol)) byPair.set(a.pairSymbol, a.providerSymbol);
  const entries = [...byPair.entries()];
  const validation: Record<string, { ok: boolean; canonicalSymbol: string | null }> = {};
  for (let i = 0; i < entries.length; i += 20) {
    const slice = entries.slice(i, i + 20);
    const spark = await fetchYahooFxSpark(slice.map(([, s]) => s));
    for (const [pairSymbol, providerSymbol] of slice) {
      const r = spark.find((s) => s.requestedSymbol === providerSymbol);
      validation[pairSymbol] = { ok: !!r?.ok, canonicalSymbol: r?.canonicalSymbol ?? null };
    }
  }
  return { validation, validatedPairs: entries.length };
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const phase = (url.searchParams.get("phase") ?? "quote").toLowerCase();
  const batch = Math.min(40, Math.max(1, Number(url.searchParams.get("batch")) || 20));
  const started = Date.now();
  const JOB = `YAHOO_FX_${phase.toUpperCase()}`;

  if (phase === "seed") {
    const runKey = `yahoo-fx-seed:${new Date().toISOString().slice(0, 13)}`;
    const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: 0, checkpointBefore: null });
    if (skipped) return Response.json({ ok: true, task: "yahoo-fx", phase, skipped: true });
    try {
      const result = await seedFxUniverse();
      await finishRun(runId, JOB, "YAHOO", started, { status: "COMPLETED", attempted: result.pairs, completed: result.pairs, inserted: 0, updated: result.pairs, failed: 0, retryableFailures: 0, checkpointAfter: null, details: result });
      return Response.json({ ok: true, task: "yahoo-fx", phase, ...result });
    } catch (e) {
      await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
      return Response.json({ ok: false, task: "yahoo-fx", phase, error: (e as Error).message }, { status: 500 });
    }
  }

  if (phase === "activate") {
    const runKey = `yahoo-fx-activate:${new Date().toISOString().slice(0, 13)}`;
    const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: 20, checkpointBefore: null });
    if (skipped) return Response.json({ ok: true, task: "yahoo-fx", phase, skipped: true });
    try {
      const { validation, validatedPairs } = await validateAllPairs();
      const result = await activateFullYahooDirectUniverse(validation);
      await finishRun(runId, JOB, "YAHOO", started, { status: "COMPLETED", attempted: validatedPairs, completed: result.markedValid, inserted: result.newPairs, updated: result.markedValid + result.markedInvalid, failed: result.markedInvalid, retryableFailures: 0, checkpointAfter: null, details: result });
      return Response.json({ ok: true, task: "yahoo-fx", phase, validatedPairs, ...result });
    } catch (e) {
      await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
      return Response.json({ ok: false, task: "yahoo-fx", phase, error: (e as Error).message }, { status: 500 });
    }
  }

  // Weekly recurring discovery (Step 7/11): re-validate every fx_pair's YAHOO_DIRECT coverage. A
  // pair that just lost direct coverage is flipped inactive ONLY if it also has no viable derived
  // route right now — i.e. it is genuinely unquotable, not merely "no longer direct". History rows
  // are never touched or deleted either way.
  if (phase === "discovery") {
    const runKey = `yahoo-fx-discovery:${new Date().toISOString().slice(0, 10)}`;
    const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: 20, checkpointBefore: null });
    if (skipped) return Response.json({ ok: true, task: "yahoo-fx", phase, skipped: true });
    try {
      const before = await prisma.fxCoverage.findMany({ where: { capability: "YAHOO_DIRECT", status: "VALID" }, select: { pairSymbol: true } });
      const beforeValid = new Set(before.map((b) => b.pairSymbol));
      const { validation, validatedPairs } = await validateAllPairs();
      const result = await activateFullYahooDirectUniverse(validation);

      const lostDirectCoverage = [...beforeValid].filter((sym) => !validation[sym]?.ok);
      let markedInactive = 0;
      const inactivated: string[] = [];
      for (const sym of lostDirectCoverage) {
        const pair = await prisma.fxPair.findUnique({ where: { symbol: sym }, select: { symbol: true, baseCurrency: true, quoteCurrency: true, active: true } });
        if (!pair || !pair.active) continue;
        const stillDerivable = await pairHasViableDerivedRoute(pair);
        if (!stillDerivable) {
          await prisma.fxPair.update({ where: { symbol: sym }, data: { active: false } });
          markedInactive++;
          inactivated.push(sym);
        }
      }

      const details = { ...result, validatedPairs, lostDirectCoverage: lostDirectCoverage.length, markedInactive, inactivated };
      await finishRun(runId, JOB, "YAHOO", started, { status: "COMPLETED", attempted: validatedPairs, completed: result.markedValid, inserted: result.newPairs, updated: result.markedValid + result.markedInvalid, failed: 0, retryableFailures: 0, checkpointAfter: null, details });
      return Response.json({ ok: true, task: "yahoo-fx", phase, ...details });
    } catch (e) {
      await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
      return Response.json({ ok: false, task: "yahoo-fx", phase, error: (e as Error).message }, { status: 500 });
    }
  }

  if (phase === "derived") {
    const runKey = `yahoo-fx-derived:${new Date().toISOString().slice(0, 13)}`;
    const { runId, skipped } = await beginRun({ jobName: JOB, provider: "DB_ONLY", runKey, universeCount: 0, batchSize: 0, checkpointBefore: null });
    if (skipped) return Response.json({ ok: true, task: "yahoo-fx", phase, skipped: true });
    try {
      const r = await updateDerivedFxQuotes();
      await finishRun(runId, JOB, "DB_ONLY", started, { status: "COMPLETED", attempted: r.targetPairs, completed: r.updated, inserted: 0, updated: r.updated, failed: 0, retryableFailures: 0, checkpointAfter: null, details: r });
      return Response.json({ ok: true, task: "yahoo-fx", phase, ...r });
    } catch (e) {
      await finishRun(runId, JOB, "DB_ONLY", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
      return Response.json({ ok: false, task: "yahoo-fx", phase, error: (e as Error).message }, { status: 500 });
    }
  }

  if (phase !== "quote" && phase !== "history") {
    return Response.json({ ok: false, task: "yahoo-fx", error: `Unknown phase: ${phase}. Use seed|activate|discovery|quote|history|derived.` }, { status: 400 });
  }

  // scope=smoke pins the working set to the original 19-pair fixture; default is the full
  // fx_coverage-validated Yahoo-direct universe. Smoke runs never chain derived.
  const scope = url.searchParams.get("scope") === "smoke" ? CURATED_SYMBOLS : undefined;

  const cpKey = `yahoo-fx-${phase}${scope ? "-smoke" : ""}`;
  const runKey = `${cpKey}:${new Date().toISOString().slice(0, 13)}`;
  const cpBefore = await readCheckpoint(cpKey);
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: cpBefore });
  if (skipped) return Response.json({ ok: true, task: "yahoo-fx", phase, skipped: true });

  try {
    let cursor = cpBefore?.lastSymbol ?? null;
    if (phase === "quote") {
      let requestedPairs = 0, resolvedPairs = 0, updatedPairs = 0, staleSkipped = 0, noNewData = 0;
      const failedPairs: Array<{ symbol: string; reason: string }> = [];
      let wrapped = false, slices = 0;
      while (Date.now() - started < TIME_BUDGET_MS) {
        const r = await updateFxQuotes(cursor, batch, scope);
        requestedPairs += r.requestedPairs; resolvedPairs += r.resolvedPairs; updatedPairs += r.updatedPairs; staleSkipped += r.staleSkipped; noNewData += r.noNewData;
        failedPairs.push(...r.failedPairs);
        cursor = r.lastSymbol; slices++;
        if (r.wrapped) { wrapped = true; break; }
      }
      const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedPairs, succeeded: (cpBefore?.succeeded ?? 0) + updatedPairs, failed: failedPairs.length };
      await writeCheckpoint(JOB, cpKey, runId, cpAfter);

      let derived: Awaited<ReturnType<typeof updateDerivedFxQuotes>> | null = null;
      if (wrapped && !scope) {
        // Step 6/7: derived only runs after a successful FULL direct sweep, same trigger, no
        // separate cron. Skipped for the smoke-test scope on purpose.
        try { derived = await updateDerivedFxQuotes(); } catch { /* derived failure never fails the quote run */ }
      }

      await finishRun(runId, JOB, "YAHOO", started, { status: failedPairs.length > 0 && updatedPairs === 0 ? "PARTIAL" : "COMPLETED", attempted: requestedPairs, completed: updatedPairs, inserted: 0, updated: updatedPairs, failed: failedPairs.length, retryableFailures: failedPairs.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, staleSkipped, noNewData, derived } });
      return Response.json({ ok: true, task: "yahoo-fx", phase, requestedPairs, resolvedPairs, updatedPairs, staleSkipped, noNewData, failedPairs, wrapped, slices, derived });
    } else {
      // History-specific small batch + per-batch checkpoint (see HISTORY_BATCH_SIZE comment above).
      // `batch` query param is ignored here on purpose — history's safe batch size is a property of
      // Yahoo chart latency, not something a caller should override upward.
      let requestedPairs = 0, updatedPairs = 0, rowsWritten = 0;
      const failedPairs: Array<{ symbol: string; reason: string }> = [];
      let wrapped = false, slices = 0;
      while (Date.now() - started < HISTORY_MAX_SAFE_RUNTIME_MS) {
        const r = await updateFxHistory(cursor, HISTORY_BATCH_SIZE, scope);
        requestedPairs += r.requestedPairs; updatedPairs += r.updatedPairs; rowsWritten += r.rowsWritten;
        failedPairs.push(...r.failedPairs);
        cursor = r.lastSymbol; slices++;
        // Checkpoint after EVERY batch — a kill on a LATER batch must never lose progress already
        // made and durably written to fx_candles by this invocation.
        const cpAfter = { lastSymbol: r.wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedPairs, succeeded: (cpBefore?.succeeded ?? 0) + updatedPairs, failed: failedPairs.length };
        await writeCheckpoint(JOB, cpKey, runId, cpAfter);
        if (r.wrapped) { wrapped = true; break; }
        if (Date.now() - started >= HISTORY_MAX_SAFE_RUNTIME_MS) break; // no time left for another batch — stop cleanly instead of risking a kill mid-batch
      }
      const cpAfter = { lastSymbol: wrapped ? null : cursor, processed: (cpBefore?.processed ?? 0) + requestedPairs, succeeded: (cpBefore?.succeeded ?? 0) + updatedPairs, failed: failedPairs.length };
      // A slice that completed cleanly (whether or not the full 390-pair universe wrapped this
      // invocation) is a normal, successful run — progress lives in the checkpoint, not in whether
      // this one call finished the whole universe. Reuses the existing COMPLETED/PARTIAL states,
      // no new status introduced.
      await finishRun(runId, JOB, "YAHOO", started, { status: failedPairs.length > 0 && updatedPairs === 0 && rowsWritten === 0 ? "PARTIAL" : "COMPLETED", attempted: requestedPairs, completed: updatedPairs, inserted: rowsWritten, updated: 0, failed: failedPairs.length, retryableFailures: failedPairs.length, checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details: { slices, wrapped, batchSize: HISTORY_BATCH_SIZE } });
      return Response.json({ ok: true, task: "yahoo-fx", phase, requestedPairs, updatedPairs, rowsWritten, failedPairs, wrapped, slices });
    }
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: cpBefore, error: (e as Error).message });
    return Response.json({ ok: false, task: "yahoo-fx", phase, error: (e as Error).message }, { status: 500 });
  }
}
