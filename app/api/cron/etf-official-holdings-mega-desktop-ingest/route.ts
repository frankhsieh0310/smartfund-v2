// Mega-only desktop-fallback ingest endpoint.
//
// Why this exists: Mega's official site (www.megafunds.com.tw) blocks cloud/datacenter egress with an
// HTTP 403 "Access Denied" — confirmed identically from BOTH Vercel Production and a one-off GitHub
// Actions runner probe, while the exact same request from a residential/office network succeeds
// (HTTP 200, live-probed). Header variations (User-Agent, Referer, Accept-Language, even no headers at
// all) made no difference from either side — this is a network-origin block, not an adapter-request
// problem, so it cannot be fixed by changing headers, retries, or timeouts. Every other issuer keeps
// using the cloud `etf-official-holdings` route unchanged; this endpoint exists for Mega alone.
//
// This route does NOT fetch anything itself. It only validates and persists a CanonicalSnapshot that a
// trusted desktop process has ALREADY fetched and normalized — using the exact same
// MegaOfficialPcfAdapter parsing (lib/etf-holdings-engine/adapters/mega.ts) the cloud route would have
// used — so the data shape, snapshot/positions/holdings persistence, and checkpoint/run-log semantics
// are identical to the main cron route. The desktop side never touches the Production DB directly.
import { prisma } from "@/lib/prisma";
import { upsertSnapshot, type QueryFn } from "@/lib/etf-holdings-engine/storage";
import { syncOfficialSnapshotToHoldings } from "@/lib/etf-holdings-engine/syncToHoldings";
import { FUND_ID_MAP as MEGA_FUND_ID_MAP } from "@/lib/etf-holdings-engine/adapters/mega";
import type { CanonicalSnapshot } from "@/lib/etf-holdings-engine/types";
import {
  beginRun,
  finishRun,
  writeCheckpoint,
  type BoundedDbOptions,
} from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "ETF_OFFICIAL_HOLDINGS_MEGA_DESKTOP";

// Same shape/headroom principle as the main cron route's DB bounds (see runContext.ts's
// BoundedDbOptions doc for why statementTimeoutMs and timeoutMs must NOT be equal) — kept small since
// this endpoint only ever persists ONE ticker per call, never a batch.
const DB_MAX_WAIT_MS = 5_000;
const DB_STATEMENT_TIMEOUT_MS = 20_000;
const DB_TRANSACTION_TIMEOUT_MS = 30_000;
const CHECKPOINT_BOUND: BoundedDbOptions = { maxWaitMs: 5_000, statementTimeoutMs: 10_000, timeoutMs: 15_000 };

// Deliberately a SEPARATE secret from CRON_SECRET: every other cron route only triggers work this
// server already owns end-to-end (a bare GET, no attacker-controlled body). This route accepts a full
// data payload from an external desktop process and writes it to Production — a materially different
// trust boundary — so it gets its own secret, independently rotatable, whose blast radius if leaked is
// scoped to "can write Mega holdings snapshots" rather than every cron job in the project.
function isAuthorizedMegaDesktop(request: Request): boolean {
  const secret = process.env.MEGA_DESKTOP_INGEST_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

function badRequest(error: string) {
  return Response.json({ ok: false, error }, { status: 400 });
}

// Mirrors the main cron route's runBoundedPersistence exactly (same DB-level guarantee: a Postgres
// `SET LOCAL statement_timeout` for genuine server-side query cancellation, plus Prisma's own
// transaction timeout kept comfortably ABOVE it) — duplicated here rather than imported, since the
// main route's version is a private, non-exported function scoped to that file.
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

export async function POST(request: Request) {
  if (!isAuthorizedMegaDesktop(request)) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("MEGA_DESKTOP_INVALID_JSON");
  }
  const snap = body as Partial<CanonicalSnapshot> | null;
  if (!snap || typeof snap !== "object") return badRequest("MEGA_DESKTOP_MISSING_BODY");

  // 只接受 Mega — this endpoint exists for exactly one issuer, never a generic multi-issuer ingest path.
  if (snap.issuer !== "Mega") return badRequest(`MEGA_DESKTOP_WRONG_ISSUER_${String(snap.issuer)}`);
  if (typeof snap.etfCode !== "string" || !(snap.etfCode in MEGA_FUND_ID_MAP)) {
    return badRequest(`MEGA_DESKTOP_UNKNOWN_TICKER_${String(snap.etfCode)}`);
  }
  if (typeof snap.dataDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(snap.dataDate)) {
    return badRequest(`MEGA_DESKTOP_INVALID_DATADATE_${String(snap.dataDate)}`);
  }
  if (!Array.isArray(snap.positions) || snap.positions.length === 0) {
    return badRequest(`MEGA_DESKTOP_EMPTY_POSITIONS_${snap.etfCode}`);
  }

  const etfCode = snap.etfCode;
  const dataDate = snap.dataDate;
  const checkpointKey = `etf-official-holdings:mega-desktop:${etfCode}`;
  // One run_key per (ticker, dataDate) — idempotent per trading day, reusing the SAME beginRun
  // lifecycle (runContext.ts) as every other cron route: blocks a genuine concurrent duplicate POST for
  // the same ticker+date, but any terminal or stale-RUNNING prior attempt allows a fresh retry.
  const runKey = `${JOB}:${etfCode}:${dataDate}`;

  const { runId, skipped } = await beginRun({
    jobName: `${JOB}:${etfCode}`,
    provider: "Mega",
    runKey,
    universeCount: 1,
    batchSize: 1,
    checkpointBefore: null,
  }, CHECKPOINT_BOUND);
  if (skipped) {
    return Response.json({ ok: true, job: JOB, etfCode, skipped: true, reason: "run_key already present (double trigger)", runKey });
  }

  const startedMs = Date.now();
  try {
    const { snapshotId } = await runBoundedPersistence(snap as CanonicalSnapshot);
    // Checkpoint only on full success — mirrors the checkpoint-correctness invariant in the main cron
    // route: a failure must never be recorded as "done".
    await writeCheckpoint(`${JOB}:${etfCode}`, checkpointKey, runId, {
      lastSymbol: etfCode, processed: 1, succeeded: 1, failed: 0,
    }, CHECKPOINT_BOUND);
    await finishRun(runId, `${JOB}:${etfCode}`, "Mega", startedMs, {
      status: "COMPLETED", attempted: 1, completed: 1, inserted: 1, updated: 0, failed: 0,
      retryableFailures: 0,
      checkpointAfter: { lastSymbol: etfCode, processed: 1, succeeded: 1, failed: 0, updatedAt: null },
      error: null,
      details: { etfCode, dataDate, source: "MEGA_DESKTOP_FALLBACK" },
    }, CHECKPOINT_BOUND);
    return Response.json({ ok: true, job: JOB, etfCode, dataDate, snapshotId, positionsCount: snap.positions.length });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Best-effort: a run-log write failure here must never mask the real error being returned below.
    await finishRun(runId, `${JOB}:${etfCode}`, "Mega", startedMs, {
      status: "FAILED", attempted: 1, completed: 0, inserted: 0, updated: 0, failed: 1,
      retryableFailures: 0, checkpointAfter: null, error: message.slice(0, 300), details: { etfCode, dataDate },
    }, CHECKPOINT_BOUND).catch(() => {});
    return Response.json({ ok: false, job: JOB, etfCode, error: message.slice(0, 300) }, { status: 500 });
  }
}
