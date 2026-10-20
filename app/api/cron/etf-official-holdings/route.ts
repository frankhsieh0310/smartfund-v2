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
// Trigger (2026-10-19): one Vercel native cron entry per issuer (vercel.json), each
// GET ?issuer=<Name> with the platform's auto-sent `Authorization: Bearer $CRON_SECRET`. 16 issuers
// (Mega excluded -- its official site blocks cloud/datacenter egress, updated via a separate desktop
// fallback path) are split into 6 "waves" of 2-3 issuers each, every wave on its own distinct minute
// offset so at most one wave's issuers (≤3) ever run concurrently against this single deployment --
// same concurrency ceiling the old GitHub Actions matrix's `max-parallel: 3` enforced, just achieved
// by scheduling instead of a job-level setting. Each wave repeats 3x/hour across a multi-hour evening
// window (see vercel.json), giving every issuer several independent chances to reach reachedEnd=true
// the same trading day even if one attempt gets interrupted. Previously: GitHub Actions matrix (16
// parallel jobs, fail-fast: false), each calling this route in a tight bash while-loop (~every 20s)
// until reachedEnd=true -- replaced because GitHub Actions' free Actions-minutes budget for this repo
// was being exhausted mid-month, silently halting ALL of that workflow's scheduled triggers.
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
// 2026-10-19: migrated off GitHub Actions (whose own tight bash while-loop was the external re-driver
// these two constants were originally sized for — see each one's history below) onto Vercel's native
// cron, which fires at most every few minutes per issuer, not every ~20s. Raised both so one Vercel
// invocation does meaningfully more real work per call instead of returning almost immediately with
// reachedEnd=false every time — still well inside maxDuration=300s, with the same two independent
// stop conditions (this deadline, and the DB-level transaction timeout below) doing the same job they
// always did, just re-tuned for a coarser-grained caller.
//
// Real wall-clock hard stop for the whole invocation — well under Vercel's 300s maxDuration. This is
// one of TWO independent guarantees against a stuck invocation (the other is the DB-level transaction
// timeout below): even if every per-ticker/DB bound below somehow failed to fire, the loop's own
// remaining-time check (MIN_REMAINING_TO_START_MS) stops starting new work comfortably before this.
const HARD_RESPONSE_DEADLINE_MS = 260_000;
// A single invocation never attempts more than this many ETFs, regardless of how much time budget is
// left. Raised from 2 (GitHub Actions' own tight while-loop called this route again immediately, so a
// tiny per-call batch cost nothing) to a generous cap that in practice is never the binding constraint
// -- HARD_RESPONSE_DEADLINE_MS/MIN_REMAINING_TO_START_MS above are what actually stop the loop now.
// Kept as a sanity ceiling, not a throughput lever: do not lower this back down without re-checking
// Vercel's own trigger frequency for this route in vercel.json.
const MAX_ETFS_PER_INVOCATION = 200;
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

// 2026-10-20（使用者訂立）: universe_by_issuer.json 是寫死的清單，新上市偵測只會建立 etfs 資料列，
// 不會自動更新這份清單——這正是 00412A 等 16 檔主動式 ETF 從未被抓取過的根因（daily-health-
// report 新的 checkActiveEtfOfficialHoldingsCoverage 抓到的缺口）。改成直接查 `etfs` 這個該投信
// 現行掛牌（is_active=true）的名單，不再讀這個檔案（檔案本身保留，scripts/etf-holdings-engine-
// final-gate.ts 還在用，不動它）。
//
// 用 provider 欄位 OR name 欄位（去掉「主動」前綴後）雙重比對，因為部分主動式 ETF 的 provider
// 欄位本身還沒補上官方全名（例如 00981D 的 provider 是「未知（待補）」，但 name 是「主動中信非
// 投等債」，含有「中信」這個跟既有清單同一套的品牌關鍵字），只比對 provider 會漏掉這些。
const ISSUER_KEYWORD: Record<string, string> = {
  Cathay: "國泰", JPMorgan: "摩根", Allianz: "安聯", UPAMC: "統一", AB: "聯博", Fubon: "富邦",
  CTBC: "中信", KGI: "凱基", First: "第一金", FHT: "復華", SinoPac: "永豐", Yuanta: "元大",
  Capital: "群益", Mega: "兆豐", Taishin: "台新", Nomura: "野村", BlackRock: "貝萊德",
};

// 既有、已知的個別排除——跟搬來之前完全一樣的三個例外，不是這次新增的邏輯：
const ISSUER_EXCLUDE: Partial<Record<string, (ticker: string) => boolean>> = {
  Cathay: (t) => t.endsWith("K"),
  Capital: (t) => t === "00643K",
  SinoPac: (t) => t === "00838B",
};

async function getIssuerUniverse(issuerName: string): Promise<{ adapter: OfficialPcfAdapter; tickers: string[] } | null> {
  const adapterMap: Record<string, OfficialPcfAdapter> = {
    Cathay: CathayOfficialPcfAdapter, JPMorgan: JpmorganOfficialPcfAdapter, Allianz: AllianzOfficialPcfAdapter,
    UPAMC: UpamcOfficialPcfAdapter, AB: AbOfficialPcfAdapter, Fubon: FubonOfficialPcfAdapter,
    CTBC: CtbcOfficialPcfAdapter, KGI: KgiOfficialPcfAdapter, First: FirstOfficialPcfAdapter,
    FHT: FhtOfficialPcfAdapter, SinoPac: SinoPacOfficialPcfAdapter, Yuanta: YuantaOfficialPcfAdapter,
    Capital: CapitalOfficialPcfAdapter, Mega: MegaOfficialPcfAdapter, Taishin: TaishinOfficialPcfAdapter,
    Nomura: NomuraOfficialPcfAdapter, BlackRock: BlackRockOfficialPcfAdapter,
  };
  const keyword = ISSUER_KEYWORD[issuerName];
  const adapter = adapterMap[issuerName];
  if (!keyword || !adapter) return null;
  const rows = await prisma.$queryRawUnsafe<{ code: string }[]>(
    `SELECT DISTINCT code FROM etfs
      WHERE is_active = true
        AND (provider LIKE '%' || $1 || '%' OR name LIKE '主動' || $1 || '%' OR name LIKE $1 || '%')
      ORDER BY code`,
    keyword,
  );
  const exclude = ISSUER_EXCLUDE[issuerName];
  const tickers = exclude ? rows.map((r) => r.code).filter((t) => !exclude(t)) : rows.map((r) => r.code);
  return { adapter, tickers };
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

  const issuer = new URL(request.url).searchParams.get("issuer");
  const issuerEntry = issuer ? await getIssuerUniverse(issuer) : null;
  if (!issuer || !issuerEntry) {
    return Response.json(
      { ok: false, error: `issuer query param required; one of: ${Object.keys(ISSUER_KEYWORD).join(", ")}` },
      { status: 400 },
    );
  }
  // 2026-10-20: tickers now come straight from `etfs WHERE is_active = true` (see getIssuerUniverse
  // above), so a separately-filtered is_active=false exclusion pass is no longer needed here —
  // e.g. CTBC's delisted 00847B (the original reason this exclusion was added, see history below)
  // simply never appears in the query result in the first place.
  const { adapter, tickers } = issuerEntry;
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
