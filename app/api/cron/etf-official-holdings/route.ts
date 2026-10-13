// Function 2: Taiwan ETF Official Daily Holdings — issuer-scoped, time-boxed ingestion with a
// per-issuer checkpoint.
//
// Each of the 17 issuers' official sources were already individually verified to have no bulk/multi-
// fund holdings endpoint (see each adapter's own header comment) — every issuer genuinely requires one
// request per fund. What changed here is orchestration, not data access: a single shared, serial
// 331-ticker pass (and even a single-issuer batch) could spend its whole invocation on one slow/stuck
// issuer. Now one invocation always scopes to exactly one issuer (?issuer=Yuanta etc.), runs a time-
// boxed loop over that issuer's own remaining tickers, and checkpoints independently per issuer — so
// GitHub Actions can run all 17 as parallel matrix jobs, and one issuer's trouble never blocks another's.
//
// Checkpoint storage is 100% reused, no schema change: production_scheduler_checkpoints /
// production_scheduler_runs via lib/cloud-ingestion/runContext.ts.
//
// Daily reset: a checkpoint from a previous Taipei calendar day never suppresses today's run for that
// issuer — today's first invocation for that issuer starts again from its own first ticker.
//
// Never uses the scheduler's own run time as a holdings date — each snapshot's `dataDate` always comes
// from that issuer's own official response (see lib/etf-holdings-engine/types.ts CanonicalSnapshot).
//
// Trigger: GitHub Actions matrix (17 parallel jobs, fail-fast: false) ->
//   GET ?issuer=<Name> with `Authorization: Bearer <CRON_SECRET>`, called repeatedly by that matrix
//   job until it reports reachedEnd=true.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { upsertSnapshot, type QueryFn } from "@/lib/etf-holdings-engine/storage";
import { syncOfficialSnapshotToHoldings } from "@/lib/etf-holdings-engine/syncToHoldings";
import type { CanonicalSnapshot, OfficialPcfAdapter } from "@/lib/etf-holdings-engine/types";
import {
  beginRun,
  finishRun,
  readCheckpoint,
  writeCheckpoint,
  type CheckpointRow,
  type BoundedDbOptions,
} from "@/lib/cloud-ingestion/runContext";
import * as fs from "fs";
import * as path from "path";

import { NomuraOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/nomura";
import { UpamcOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/upamc";
import { AllianzOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/allianz";
import { TaishinOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/taishin";
import { FubonOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/fubon";
import { CtbcOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/ctbc";
import { FhtOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/fht";
import { CapitalOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/capital";
import { AbOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/ab";
import { JpmorganOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/jpmorgan";
import { FirstOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/first";
import { YuantaOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/yuanta";
import { MegaOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/mega";
import { CathayOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/cathay";
import { KgiOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/kgi";
import { SinoPacOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/sinopac";
import { BlackRockOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/blackrock";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "ETF_OFFICIAL_HOLDINGS";
// Real wall-clock hard stop for the whole invocation — well under Vercel's 300s maxDuration. This is
// one of TWO independent guarantees against a stuck invocation (the other is the DB-level transaction
// timeout below): even if every per-ticker/DB bound below somehow failed to fire, the loop's own
// remaining-time check (MIN_REMAINING_TO_START_MS) stops starting new work comfortably before this.
const HARD_RESPONSE_DEADLINE_MS = 120_000;
// A single invocation never attempts more than this many ETFs, regardless of how much time budget is
// left — GitHub's own while-loop (cloud-data-ingestion.yml) calls this route again immediately, so
// there is no benefit to risking a longer invocation, and real benefit (smaller blast radius per call,
// faster checkpoint cadence) to keeping this small. Do not attempt to finish a whole issuer in one call.
const MAX_ETFS_PER_INVOCATION = 2;
// Before starting the NEXT ticker, if less than this much of HARD_RESPONSE_DEADLINE_MS remains, stop
// cleanly (HTTP 200, reachedEnd=false) instead of risking Vercel killing the function mid-ticker. Must
// comfortably exceed PER_ETF_TOTAL_TIMEOUT_MS so a started ticker always has room to finish.
const MIN_REMAINING_TO_START_MS = 50_000;
// fetch + the one bounded retry, COMBINED, for a single ETF — not 45s each. One AbortController per
// ticker is given this deadline (or the route's own remaining global budget, whichever is smaller — see
// the loop below), and aborting it actually cancels the in-flight work (closes the Puppeteer page,
// aborts the fetch) instead of merely abandoning an unawaited promise. A signal that's already aborted
// when the first attempt fails means the deadline — not the attempt itself — caused the failure, and
// the retry is skipped outright.
const PER_ETF_TOTAL_TIMEOUT_MS = 45_000;
// Per-ticker DB persistence (official snapshot + app-facing holdings sync, now one atomic
// prisma.$transaction — see runBoundedPersistence below). maxWait bounds how long Prisma may queue
// waiting to ACQUIRE a pooled connection (the actual historical failure mode — see lib/prisma.ts's own
// comment about a prior pgbouncer connection-exhaustion incident); DB_STATEMENT_TIMEOUT_MS is the
// Postgres-level `SET LOCAL statement_timeout` that genuinely cancels a hanging query server-side;
// DB_TRANSACTION_TIMEOUT_MS is Prisma's own outer transaction-wrapper timeout, which MUST stay
// comfortably larger than DB_STATEMENT_TIMEOUT_MS. Production run #1221 (tickers 006203/006206) showed
// why: with both set to 20000ms, a query that ran right up to its own statement_timeout caused the
// Prisma wrapper to ALSO expire at almost the same instant (elapsed≈20513–20537ms), so a query that
// Postgres was about to legitimately finish/cancel got reported as "transaction already closed"
// instead of being allowed to COMMIT. The headroom below exists so COMMIT always has room to run.
const DB_MAX_WAIT_MS = 5_000;
const DB_STATEMENT_TIMEOUT_MS = 20_000;
const DB_TRANSACTION_TIMEOUT_MS = 30_000;
// Same shape, applied to the much smaller checkpoint/run-log writes (beginRun/readCheckpoint/
// writeCheckpoint/finishRun) so they also can never silently exceed the route's own hard deadline —
// same headroom principle: the transaction wrapper timeout stays above the statement timeout.
const CHECKPOINT_BOUND: BoundedDbOptions = { maxWaitMs: 5_000, statementTimeoutMs: 10_000, timeoutMs: 15_000 };
// Per-probe cap for resolveCtbcLatestDate's backward date search (below) — it runs BEFORE the main
// loop and, pre-fix, had no timeout at all on its own fetchSnapshot calls.
const CTBC_DATE_PROBE_TIMEOUT_MS = 20_000;

/** Sleep that resolves immediately if `signal` is already aborted, and stops waiting the moment it
 * aborts mid-sleep — the 1.5s bounded retry delay must not itself ignore the deadline. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

// CTBC's adapter has no "today" fallback by design and exposes no listAvailableDates() — it always
// requires an explicit date, and its Buyback API is strict (a date with no official publication for
// it returns CTBC_NO_ENTRY, confirmed via a bounded live probe: 2026-09-22/23/24 all succeeded with
// dataDate exactly equal to the date requested; 2026-09-25 failed outright). So "today's real date" is
// resolved by probing backward from the current Taipei calendar date until CTBC's own API confirms one
// with a real snapshot — never by computing or guessing a date locally. Bounded to at most 7 calendar
// days back (covers a normal weekend/holiday gap), so this never becomes an unbounded retry loop.
// deadlineAt bounds this against the route's own HARD_RESPONSE_DEADLINE_MS: each probe gets its own
// AbortController (min of CTBC_DATE_PROBE_TIMEOUT_MS and whatever's actually left), and once there's
// not enough budget left for another probe, this gives up early rather than risk blowing the route's
// hard deadline before the main per-ticker loop even starts — CTBC's tickers then fall through to the
// existing documented per-ticker failure path (ctbcDate stays null, each one fails individually).
async function resolveCtbcLatestDate(deadlineAt: number): Promise<string> {
  const anchorTicker = "00406A";
  const taipeiToday = new Date(Date.now() + 8 * 60 * 60 * 1000);
  for (let back = 0; back <= 7; back++) {
    const remaining = deadlineAt - Date.now();
    if (remaining < 5_000) break;
    const d = new Date(taipeiToday);
    d.setUTCDate(d.getUTCDate() - back);
    const candidate = d.toISOString().slice(0, 10);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(CTBC_DATE_PROBE_TIMEOUT_MS, remaining));
    try {
      const snap = await CtbcOfficialPcfAdapter.fetchSnapshot(anchorTicker, candidate, controller.signal);
      if (snap.dataDate) return snap.dataDate;
    } catch {
      // no official publication for this candidate date, or this probe hit its own timeout — try the
      // previous day
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("CTBC_NO_AVAILABLE_DATE_WITHIN_7_DAYS");
}

function loadUniverse(): Record<string, string[]> {
  const p = path.join(process.cwd(), "lib", "etf-holdings-engine", "universe_by_issuer.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Issuer name -> { adapter, tickers }. Same 17 issuers, same canonical-count filters, as the prior
// cross-issuer flat universe — just keyed for single-issuer lookup instead of flattened across all 17.
function buildIssuerUniverse(): Record<string, { adapter: OfficialPcfAdapter; tickers: string[] }> {
  const universe = loadUniverse();
  const CATHAY_CANONICAL = universe["國泰"].filter((t) => !t.endsWith("K"));
  const CAPITAL_ACTIVE = universe["群益"].filter((t) => t !== "00643K");
  const SINOPAC_ACTIVE = universe["永豐"].filter((t) => t !== "00838B");
  return {
    Cathay: { adapter: CathayOfficialPcfAdapter, tickers: CATHAY_CANONICAL },
    JPMorgan: { adapter: JpmorganOfficialPcfAdapter, tickers: universe["摩根"] },
    Allianz: { adapter: AllianzOfficialPcfAdapter, tickers: universe["安聯"] },
    UPAMC: { adapter: UpamcOfficialPcfAdapter, tickers: universe["統一"] },
    AB: { adapter: AbOfficialPcfAdapter, tickers: universe["聯博"] },
    Fubon: { adapter: FubonOfficialPcfAdapter, tickers: universe["富邦"] },
    CTBC: { adapter: CtbcOfficialPcfAdapter, tickers: universe["中信"] },
    KGI: { adapter: KgiOfficialPcfAdapter, tickers: universe["凱基"] },
    First: { adapter: FirstOfficialPcfAdapter, tickers: universe["第一金"] },
    FHT: { adapter: FhtOfficialPcfAdapter, tickers: universe["復華"] },
    SinoPac: { adapter: SinoPacOfficialPcfAdapter, tickers: SINOPAC_ACTIVE },
    Yuanta: { adapter: YuantaOfficialPcfAdapter, tickers: universe["元大"] },
    Capital: { adapter: CapitalOfficialPcfAdapter, tickers: CAPITAL_ACTIVE },
    Mega: { adapter: MegaOfficialPcfAdapter, tickers: universe["兆豐"] },
    Taishin: { adapter: TaishinOfficialPcfAdapter, tickers: universe["台新"] },
    Nomura: { adapter: NomuraOfficialPcfAdapter, tickers: universe["野村"] },
    BlackRock: { adapter: BlackRockOfficialPcfAdapter, tickers: universe["貝萊德"] },
  };
}

function taipeiDateKey(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function todayTaipeiKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Replaces two separate, unbounded raw-SQL calls (upsertSnapshot's own writes, then
// syncOfficialSnapshotToHoldings's own internal BEGIN/COMMIT) with ONE prisma.$transaction carrying a
// real DB-level bound. This is deliberately NOT "wrap the existing calls in Promise.race" — a
// client-side race would abandon the promise while the underlying query/connection kept running.
//
// Critically, Prisma's own $transaction `timeout` option is NOT sufficient by itself: verified against
// a real hanging query (pg_sleep(30) inside a transaction with Prisma timeout:20000) that the promise
// only rejects once the hanging query naturally finishes (~30s), reporting "transaction already closed"
// post-hoc — it never cancels the in-flight query. Only a Postgres-level `SET LOCAL statement_timeout`,
// issued as the transaction's first statement, makes Postgres itself cancel the query server-side
// (error 57014) at the actual bound. So both are used together: statement_timeout for genuine per-query
// interruption, maxWait/timeout for connection-acquisition and total-transaction-duration — but they
// must NOT be set to the same value. Production run #1221 (006203/006206) proved that equal values let
// a query run right up to its own statement_timeout and have the Prisma wrapper expire at almost the
// same instant, turning a query Postgres was about to legitimately finish into a false
// "transaction already closed" failure instead of letting it COMMIT. DB_TRANSACTION_TIMEOUT_MS is kept
// comfortably above DB_STATEMENT_TIMEOUT_MS for exactly this reason.
//
// syncOfficialSnapshotToHoldings is called with manageOwnTransaction: false because it's now running
// inside this function's own transaction — a nested BEGIN/COMMIT would conflict with it. Its failure is
// caught (not rethrown) to preserve the pre-existing isolation: an app-facing holdings-sync failure must
// never undo the official snapshot write that already succeeded above it in the same transaction.
async function runBoundedPersistence(snap: CanonicalSnapshot): Promise<{ snapshotId: string }> {
  const statementTimeoutMs = Math.trunc(DB_STATEMENT_TIMEOUT_MS) | 0;
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      const txQuery: QueryFn = async (sql, params) => tx.$queryRawUnsafe(sql, ...params);
      const { snapshotId } = await upsertSnapshot(txQuery, snap);
      try {
        await syncOfficialSnapshotToHoldings(txQuery, snap.etfCode, { snapshotId, manageOwnTransaction: false });
      } catch {
        /* official snapshot is safely stored either way; this ETF's app-facing holdings just stay
           on whatever date they were last synced to, until the next successful run retries it */
      }
      return { snapshotId };
    },
    { maxWait: DB_MAX_WAIT_MS, timeout: DB_TRANSACTION_TIMEOUT_MS },
  );
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();

  const issuerUniverse = buildIssuerUniverse();
  const issuer = new URL(request.url).searchParams.get("issuer");
  if (!issuer || !(issuer in issuerUniverse)) {
    return Response.json(
      { ok: false, error: `issuer query param required; one of: ${Object.keys(issuerUniverse).join(", ")}` },
      { status: 400 },
    );
  }
  const { adapter, tickers } = issuerUniverse[issuer];
  const checkpointKey = `etf-official-holdings:${issuer.toLowerCase()}`;

  // Daily reset, scoped to this issuer only: a checkpoint from a previous Taipei calendar day never
  // suppresses today's run for THIS issuer — other issuers' checkpoints are untouched either way.
  const storedCheckpoint = await readCheckpoint(checkpointKey, CHECKPOINT_BOUND);
  const isFromToday = taipeiDateKey(storedCheckpoint?.updatedAt ?? null) === todayTaipeiKey();
  const effectiveCheckpoint: CheckpointRow | null = isFromToday ? storedCheckpoint : null;

  const startIndex = effectiveCheckpoint?.lastSymbol
    ? tickers.indexOf(effectiveCheckpoint.lastSymbol) + 1
    : 0;

  const runKey = `${JOB}:${issuer}:${todayTaipeiKey()}:starting-at-${Math.max(startIndex, 0)}`;
  const { runId, skipped } = await beginRun({
    jobName: `${JOB}:${issuer}`,
    provider: issuer,
    runKey,
    universeCount: tickers.length,
    batchSize: tickers.length - Math.max(startIndex, 0),
    checkpointBefore: effectiveCheckpoint,
  }, CHECKPOINT_BOUND);
  if (skipped) {
    return Response.json({
      ok: true, job: JOB, issuer, skipped: true, reason: "run_key already present (double trigger)", runKey,
    });
  }

  let ctbcDate: string | null = null;
  if (issuer === "CTBC") {
    try {
      ctbcDate = await resolveCtbcLatestDate(startedMs + HARD_RESPONSE_DEADLINE_MS);
    } catch {
      /* every CTBC ticker this run will fail individually and be reported */
    }
  }

  let processed = 0;
  let passed = 0;
  let failedCount = 0;
  let timeBudgetStop = false;
  // Set the instant any ticker fails — the invocation stops immediately (no further tickers attempted
  // this call) and reachedEnd can never be true this call. This is the checkpoint-correctness invariant:
  // lastSymbol (below) only ever advances to a ticker that fully succeeded (fetch + snapshot persistence
  // + holdings sync all succeeded) — a failed ticker is NEVER recorded as "attempted" in the checkpoint,
  // so the next invocation's startIndex computation naturally retries that SAME ticker, not the one
  // after it. Previously, the checkpoint advanced past a ticker whether it succeeded or failed, so a
  // transient failure (e.g. a DB timeout) got permanently skipped for the rest of that calendar day —
  // this is what this round fixes. Correctness over completeness: an issuer that hits a failure now
  // blocks here with a clear red signal, rather than finishing the day with a silent data hole.
  let stoppedOnFailure = false;
  const failedTickers: Array<{ ticker: string; error: string }> = [];
  // Only ever sourced from a FULLY successful ticker (either from a prior invocation's checkpoint, or
  // one just processed below) — never the ticker a failure occurred on.
  let lastProcessedTicker: string | null = effectiveCheckpoint?.lastSymbol ?? null;
  let index = Math.max(startIndex, 0);

  for (; index < tickers.length; index++) {
    // Hard cap: never attempt to finish a whole issuer in one invocation — GitHub's own while-loop
    // calls this route again immediately, so there's no reachedEnd=true here even if time remains.
    if (processed >= MAX_ETFS_PER_INVOCATION) { timeBudgetStop = true; break; }
    const elapsedBeforeTicker = Date.now() - startedMs;
    const remainingGlobalMs = HARD_RESPONSE_DEADLINE_MS - elapsedBeforeTicker;
    if (remainingGlobalMs < MIN_REMAINING_TO_START_MS) { timeBudgetStop = true; break; }
    const ticker = tickers[index];
    processed++;

    // This ticker's deadline is whichever is SMALLER: its own 45s total budget, or whatever's left of
    // the route's 120s hard deadline. If the global budget is the tighter one, aborting it here still
    // cancels real in-flight work (closes the page / aborts the fetch) rather than letting it run on
    // past the hard deadline while the route itself has already moved on.
    const tickerDeadlineMs = Math.min(PER_ETF_TOTAL_TIMEOUT_MS, remainingGlobalMs);
    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), tickerDeadlineMs);

    const attempt = (): Promise<CanonicalSnapshot> =>
      issuer === "CTBC"
        ? adapter.fetchSnapshot(ticker, ctbcDate ?? undefined, controller.signal)
        : adapter.fetchSnapshot(ticker, undefined, controller.signal);

    try {
      let snap: CanonicalSnapshot;
      try {
        snap = await attempt();
      } catch (firstError) {
        // The deadline (not the attempt itself) already fired — this ticker's whole budget, first
        // attempt + retry combined, is spent. Do not retry past an already-expired deadline.
        if (controller.signal.aborted) throw firstError;
        await abortableSleep(1500, controller.signal); // one bounded retry, transient network only
        if (controller.signal.aborted) throw firstError;
        snap = await attempt();
      }
      if (!snap.positions.length) throw new Error("empty positions");
      // Official snapshot write + app-facing holdings bridge, as one DB-timeout-bounded transaction —
      // see runBoundedPersistence above for why this replaced two separate unbounded raw-SQL calls.
      await runBoundedPersistence(snap);
      passed++;
      lastProcessedTicker = ticker;
      // Checkpoint immediately after a successful ticker — if Vercel kills this invocation or the work
      // budget runs out before the next ticker starts, this ticker's success is already durably saved.
      await writeCheckpoint(`${JOB}:${issuer}`, checkpointKey, runId, {
        lastSymbol: lastProcessedTicker,
        processed: (isFromToday ? effectiveCheckpoint?.processed ?? 0 : 0) + processed,
        succeeded: (isFromToday ? effectiveCheckpoint?.succeeded ?? 0 : 0) + passed,
        failed: (isFromToday ? effectiveCheckpoint?.failed ?? 0 : 0) + failedCount,
      }, CHECKPOINT_BOUND);
    } catch (e) {
      failedCount++;
      const message = e instanceof Error ? e.message : String(e);
      failedTickers.push({ ticker, error: message.slice(0, 300) });
      // Deliberately NOT writing a checkpoint here: lastSymbol must stay at the last ticker that fully
      // succeeded, so the next invocation's startIndex = indexOf(lastSymbol)+1 retries THIS SAME ticker
      // instead of skipping past it. Stop the whole invocation now rather than attempting more tickers
      // past a failure — a clear red signal (failedTickers below, totalFailure/non-200 status) beats an
      // issuer that silently finishes its list with a persistence hole in it.
      stoppedOnFailure = true;
    } finally {
      clearTimeout(deadlineTimer);
    }

    if (stoppedOnFailure) break;
  }

  // reachedEnd means every one of this issuer's own tickers has been FULLY synced (not just attempted —
  // see stoppedOnFailure above). A ticker that failed blocks reachedEnd from ever becoming true this
  // call; the next invocation retries that exact ticker. timeBudgetStop also covers the
  // MAX_ETFS_PER_INVOCATION cap (see the loop above), so hitting that cap correctly keeps
  // reachedEnd=false even when plenty of time budget remains.
  const reachedEnd = !timeBudgetStop && !stoppedOnFailure && index >= tickers.length;
  if (reachedEnd) {
    // Clear the cursor so tomorrow's first invocation for this issuer starts from ticker 0 again.
    await writeCheckpoint(`${JOB}:${issuer}`, checkpointKey, runId, {
      lastSymbol: null,
      processed: (isFromToday ? effectiveCheckpoint?.processed ?? 0 : 0) + processed,
      succeeded: (isFromToday ? effectiveCheckpoint?.succeeded ?? 0 : 0) + passed,
      failed: (isFromToday ? effectiveCheckpoint?.failed ?? 0 : 0) + failedCount,
    }, CHECKPOINT_BOUND);
  }
  const nextCursor = reachedEnd ? null : lastProcessedTicker;

  // A run that attempted tickers but succeeded at none is a total (systemic) failure for this issuer,
  // not a completed run — reachedEnd alone must never read as "it worked".
  const totalFailure = processed > 0 && passed === 0;

  await finishRun(runId, `${JOB}:${issuer}`, issuer, startedMs, {
    status: totalFailure ? "FAILED" : timeBudgetStop ? "PARTIAL" : failedCount > 0 ? "PARTIAL" : "COMPLETED",
    attempted: processed,
    completed: passed,
    inserted: passed,
    updated: 0,
    failed: failedCount,
    retryableFailures: 0,
    checkpointAfter: { lastSymbol: nextCursor, processed, succeeded: passed, failed: failedCount, updatedAt: null },
    error: failedTickers.length ? `${failedTickers.length} failures; e.g. ${failedTickers[0]?.error}` : null,
    details: { issuer, startIndex: Math.max(startIndex, 0), attempted: processed, reachedEnd, timeBudgetStop, stoppedOnFailure },
  }, CHECKPOINT_BOUND);

  return Response.json({
    ok: !totalFailure,
    job: JOB,
    issuer,
    universeCount: tickers.length,
    startIndex: Math.max(startIndex, 0),
    processed,
    passed,
    failed: failedCount,
    failedTickers,
    reachedEnd,
    runtimeMs: Date.now() - startedMs,
  }, { status: totalFailure ? 500 : 200 });
}
