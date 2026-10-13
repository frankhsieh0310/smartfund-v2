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
import { timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { upsertSnapshot, type QueryFn } from "@/lib/etf-holdings-engine/storage";
import { syncOfficialSnapshotToHoldings } from "@/lib/etf-holdings-engine/syncToHoldings";
import { FUND_ID_MAP as MEGA_FUND_ID_MAP } from "@/lib/etf-holdings-engine/adapters/mega";
import type { CanonicalSnapshot, CanonicalPosition, PositionType, PositionUnit } from "@/lib/etf-holdings-engine/types";
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

// Last-mile payload-safety limits before this external write path goes live. No real Mega ETF is
// anywhere close to either bound — both are generous anomaly caps, not realistic expectations.
const MAX_BODY_BYTES = 2_000_000; // 2MB
const MAX_POSITIONS = 2_000;

// Deliberately a SEPARATE secret from CRON_SECRET: every other cron route only triggers work this
// server already owns end-to-end (a bare GET, no attacker-controlled body). This route accepts a full
// data payload from an external desktop process and writes it to Production — a materially different
// trust boundary — so it gets its own secret, independently rotatable, whose blast radius if leaked is
// scoped to "can write Mega holdings snapshots" rather than every cron job in the project.
//
// timingSafeEqual requires equal-length buffers, so a length mismatch is checked (and rejected) first —
// that length check alone is not exploitable the way a byte-by-byte early-exit comparison would be, and
// doesn't change the auth model otherwise: still one secret, one Bearer header, same as every other
// cron route's isAuthorizedCron().
function isAuthorizedMegaDesktop(request: Request): boolean {
  const secret = process.env.MEGA_DESKTOP_INGEST_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function badRequest(error: string) {
  return Response.json({ ok: false, error }, { status: 400 });
}

const ALLOWED_POSITION_TYPES: readonly PositionType[] = ["EQUITY", "BOND", "FUTURE", "OPTION", "OTHER"];
const ALLOWED_POSITION_UNITS: readonly PositionUnit[] = ["SHARES", "PAR_VALUE", "CONTRACTS", "OTHER"];

function todayTaipeiDateKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validatePosition(p: unknown, index: number): { ok: true; value: CanonicalPosition } | { ok: false; error: string } {
  if (!p || typeof p !== "object") return { ok: false, error: `MEGA_DESKTOP_POSITION_NOT_OBJECT_${index}` };
  const r = p as Record<string, unknown>;
  if (typeof r.securityCode !== "string" || !r.securityCode) return { ok: false, error: `MEGA_DESKTOP_POSITION_MISSING_SECURITY_CODE_${index}` };
  if (typeof r.securityName !== "string" || !r.securityName) return { ok: false, error: `MEGA_DESKTOP_POSITION_MISSING_SECURITY_NAME_${index}` };
  if (typeof r.positionType !== "string" || !ALLOWED_POSITION_TYPES.includes(r.positionType as PositionType)) {
    return { ok: false, error: `MEGA_DESKTOP_POSITION_BAD_TYPE_${index}_${String(r.positionType)}` };
  }
  if (typeof r.positionUnit !== "string" || !ALLOWED_POSITION_UNITS.includes(r.positionUnit as PositionUnit)) {
    return { ok: false, error: `MEGA_DESKTOP_POSITION_BAD_UNIT_${index}_${String(r.positionUnit)}` };
  }
  // Never NaN/Infinity — a non-finite amount or weight would otherwise be silently written to the DB
  // (Postgres numeric columns reject NaN/Infinity at insert time, but by then the transaction is
  // already open; rejecting here, before any DB call, is the correct place for this check).
  if (typeof r.positionAmount !== "number" || !Number.isFinite(r.positionAmount)) {
    return { ok: false, error: `MEGA_DESKTOP_POSITION_NON_FINITE_AMOUNT_${index}` };
  }
  if (typeof r.weight !== "number" || !Number.isFinite(r.weight)) {
    return { ok: false, error: `MEGA_DESKTOP_POSITION_NON_FINITE_WEIGHT_${index}` };
  }
  // No invented unit/percentage normalization here — weight travels through exactly as the adapter
  // produced it (same canonical invariant every other issuer's adapter already follows); this only
  // rejects non-finite values, never rescales or reinterprets a finite one.
  if (r.canonicalSecurityId !== null && typeof r.canonicalSecurityId !== "string") {
    return { ok: false, error: `MEGA_DESKTOP_POSITION_BAD_CANONICAL_ID_${index}` };
  }
  return {
    ok: true,
    value: {
      securityCode: r.securityCode, securityName: r.securityName,
      positionType: r.positionType as PositionType, positionAmount: r.positionAmount,
      positionUnit: r.positionUnit as PositionUnit, weight: r.weight,
      canonicalSecurityId: (r.canonicalSecurityId as string | null) ?? null,
    },
  };
}

/** Validates a parsed JSON body as a CanonicalSnapshot for Mega specifically — the SAME type contract
 * from lib/etf-holdings-engine/types.ts, no second schema. Every check here runs BEFORE any DB call. */
function validateMegaSnapshot(body: unknown): { ok: true; value: CanonicalSnapshot } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "MEGA_DESKTOP_MISSING_BODY" };
  const snap = body as Record<string, unknown>;

  if (snap.issuer !== "Mega") return { ok: false, error: `MEGA_DESKTOP_WRONG_ISSUER_${String(snap.issuer)}` };
  if (typeof snap.etfCode !== "string" || !(snap.etfCode in MEGA_FUND_ID_MAP)) {
    return { ok: false, error: `MEGA_DESKTOP_UNKNOWN_TICKER_${String(snap.etfCode)}` };
  }
  if (typeof snap.dataDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(snap.dataDate)) {
    return { ok: false, error: `MEGA_DESKTOP_INVALID_DATADATE_${String(snap.dataDate)}` };
  }
  // dataDate is the date the holdings actually reflect — it can never be later than "today" in the
  // issuer's own Taipei calendar date (matches the Taipei-date convention the main cron route already
  // uses for its own daily-reset logic).
  if (snap.dataDate > todayTaipeiDateKey()) {
    return { ok: false, error: `MEGA_DESKTOP_FUTURE_DATADATE_${snap.dataDate}` };
  }
  if (typeof snap.fundNav !== "number" || !Number.isFinite(snap.fundNav)) {
    return { ok: false, error: "MEGA_DESKTOP_NON_FINITE_FUND_NAV" };
  }
  if (typeof snap.outstandingUnits !== "number" || !Number.isFinite(snap.outstandingUnits)) {
    return { ok: false, error: "MEGA_DESKTOP_NON_FINITE_OUTSTANDING_UNITS" };
  }
  if (!Array.isArray(snap.positions) || snap.positions.length === 0) {
    return { ok: false, error: `MEGA_DESKTOP_EMPTY_POSITIONS_${snap.etfCode}` };
  }
  if (snap.positions.length > MAX_POSITIONS) {
    return { ok: false, error: `MEGA_DESKTOP_TOO_MANY_POSITIONS_${snap.positions.length}` };
  }

  const positions: CanonicalPosition[] = [];
  const seenCodes = new Set<string>();
  for (let i = 0; i < snap.positions.length; i++) {
    const r = validatePosition(snap.positions[i], i);
    if (!r.ok) return r;
    // Canonical identity for a position within one snapshot is its securityCode (the same identity
    // storage.ts/syncToHoldings.ts rely on elsewhere) — two rows sharing one in the SAME snapshot is a
    // malformed/duplicated payload, never a legitimate real-world holding shape.
    if (seenCodes.has(r.value.securityCode)) {
      return { ok: false, error: `MEGA_DESKTOP_DUPLICATE_POSITION_${r.value.securityCode}` };
    }
    seenCodes.add(r.value.securityCode);
    positions.push(r.value);
  }

  if (typeof snap.assetType !== "string") return { ok: false, error: "MEGA_DESKTOP_MISSING_ASSET_TYPE" };
  if (typeof snap.announcementDate !== "string") return { ok: false, error: "MEGA_DESKTOP_MISSING_ANNOUNCEMENT_DATE" };
  if (typeof snap.source !== "string") return { ok: false, error: "MEGA_DESKTOP_MISSING_SOURCE" };
  if (typeof snap.retrievedAt !== "string") return { ok: false, error: "MEGA_DESKTOP_MISSING_RETRIEVED_AT" };

  return {
    ok: true,
    value: {
      etfCode: snap.etfCode as string,
      issuer: "Mega",
      assetType: snap.assetType as CanonicalSnapshot["assetType"],
      dataDate: snap.dataDate as string,
      announcementDate: snap.announcementDate as string,
      fundNav: snap.fundNav as number,
      outstandingUnits: snap.outstandingUnits as number,
      positions,
      source: snap.source as string,
      retrievedAt: snap.retrievedAt as string,
    },
  };
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

  // Body-size cap enforced on the raw text BEFORE JSON.parse — rejecting an oversized payload must not
  // itself require fully parsing it first.
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return badRequest(`MEGA_DESKTOP_BODY_TOO_LARGE_${Buffer.byteLength(rawBody, "utf8")}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return badRequest("MEGA_DESKTOP_INVALID_JSON");
  }

  const validated = validateMegaSnapshot(body);
  if (!validated.ok) return badRequest(validated.error);
  const snap = validated.value;

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
    const { snapshotId } = await runBoundedPersistence(snap);
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
