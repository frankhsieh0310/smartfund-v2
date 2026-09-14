// Cloud fund-holdings worker — bounded, idempotent, resumable via DB checkpoint.
//
// provider=MONEYDJ  -> MoneyDJ fund disclosure (reuses lib/cloud-ingestion/moneydjFundDisclosure.ts;
//                      writes `holdings` asset_type='FUND', source MONEYDJ_PUBLIC_DISCLOSURE).
// provider=NPORT    -> not cloud-compatible yet (see lib/cloud-ingestion/fundHoldings.ts) -> SKIPPED.
// provider=ALL      -> MONEYDJ only for now.
//
// Trigger: GitHub Actions schedule -> GET with `Authorization: Bearer <CRON_SECRET>`.
// One invocation: read the provider ROLLING checkpoint -> next <=BATCH mapped fund codes by fund id
// -> fetch -> incremental 資料月份 compare -> only-newer write -> advance checkpoint -> run log ->
// return. 403/429 => 2s backoff + stop + PARTIAL, never clears existing data. No loop.
//
// MASTER-AWARE (Phase 1): funds linked to a fund_master are fetched only via the master's
// representative_fund_id; other linked share classes are excluded from the universe
// (MASTER_NON_REPRESENTATIVE) and read holdings through holdings_by_master. Unlinked funds (Tier B/C
// and everything not in a candidate group) keep the per-code behaviour. Selection lives in
// lib/cloud-ingestion/fundHoldings.ts; the loop also dedups fallback classes per master per run.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import {
  fetchMoneydjDisclosure,
  MoneydjHttpError,
  persistMoneydjDisclosure,
} from "@/lib/cloud-ingestion/moneydjFundDisclosure";
import {
  moneydjFundUniverseCount,
  nextMoneydjFundTargets,
  NPORT_CLOUD_COMPATIBLE,
  NPORT_DEFERRAL_REASON,
} from "@/lib/cloud-ingestion/fundHoldings";
import {
  beginRun,
  finishRun,
  hourBucketKey,
  readCheckpoint,
  writeCheckpoint,
  type CheckpointRow,
} from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_FUND_HOLDINGS";
const DEFAULT_BATCH = 150;
const MAX_BATCH = 300;
const FRESH_DAYS = 25; // matches the local disclosure worker's re-fetch guard
const TIME_BUDGET_MS = 240_000;

function resolveProvider(raw: string | null): "MONEYDJ" | "NPORT" | "ALL" {
  const v = (raw ?? "ALL").toUpperCase();
  return v === "NPORT" ? "NPORT" : v === "MONEYDJ" ? "MONEYDJ" : "ALL";
}
const checkpointKey = (p: string) => `cloud-fund-holdings:${p}`;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const url = new URL(request.url);
  const provider = resolveProvider(url.searchParams.get("provider"));
  const batch = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("batch") ?? DEFAULT_BATCH)));
  const startedMs = Date.now();

  if (provider === "NPORT" || (provider === "ALL" && url.searchParams.get("provider")?.toUpperCase() === "NPORT")) {
    return Response.json({
      ok: true,
      job: JOB,
      provider: "NPORT",
      status: "SKIPPED",
      nportCloudCompatible: NPORT_CLOUD_COMPATIBLE,
      reason: NPORT_DEFERRAL_REASON,
    });
  }

  // ---- MONEYDJ (also the ALL default for now) ----
  const CHECKPOINT_KEY = checkpointKey("MONEYDJ");
  const universeCount = await moneydjFundUniverseCount(prisma);
  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = hourBucketKey(`CLOUD_FUND_HOLDINGS:MONEYDJ`);
  const { runId, skipped } = await beginRun({
    jobName: `${JOB}:MONEYDJ`,
    provider: "MONEYDJ",
    runKey,
    universeCount,
    batchSize: batch,
    checkpointBefore: before,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, provider: "MONEYDJ", skipped: true, reason: "run_key already present this hour", runKey });
  }

  let cursor = before?.lastSymbol ?? "";
  let wrapped = false;
  let targets = await nextMoneydjFundTargets(prisma, cursor, batch, FRESH_DAYS);
  if (targets.length === 0 && cursor !== "") {
    wrapped = true;
    cursor = "";
    targets = await nextMoneydjFundTargets(prisma, cursor, batch, FRESH_DAYS);
  }

  let attempted = 0;
  let initialWrite = 0;
  let updated = 0;
  let noChange = 0;
  let staleSkip = 0;
  let emptyHoldings = 0;
  let parseFailed = 0;
  let failed = 0;
  let retryable = 0;
  let http403 = 0;
  let http429 = 0;
  let holdingsTotal = 0;
  let masterAlreadyFetched = 0;
  let backoffStop = false;
  let timeBudgetStop = false;
  const failures: Array<{ code: string; reason: string }> = [];
  const masterDoneThisRun = new Set<string>();
  let lastId = cursor;

  for (const t of targets) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) {
      timeBudgetStop = true;
      break;
    }
    lastId = t.fundId;
    // Master fallback dedup: once a master's holdings landed in this run (via representative or a
    // fallback class), skip any further class of the same master.
    if (t.masterFundId && masterDoneThisRun.has(t.masterFundId)) {
      masterAlreadyFetched++;
      continue;
    }
    attempted++;
    try {
      const disclosure = await fetchMoneydjDisclosure(t.moneydjCode);
      if (!disclosure.holdings.length) {
        emptyHoldings++;
        continue;
      }
      if (t.dbDate) {
        if (disclosure.date < t.dbDate) {
          staleSkip++;
          continue;
        }
        if (disclosure.date === t.dbDate) {
          noChange++;
          continue;
        }
      }
      const res = await persistMoneydjDisclosure(prisma, {
        fundId: t.fundId,
        shareClassId: null,
        moneydjCode: t.moneydjCode,
        disclosure,
      });
      holdingsTotal += res.rowsPersisted;
      if (t.masterFundId) masterDoneThisRun.add(t.masterFundId);
      if (t.dbDate) updated++;
      else initialWrite++;
    } catch (error) {
      if (error instanceof MoneydjHttpError) {
        if (error.httpStatus === 403) http403++;
        else http429++;
        failed++;
        retryable++;
        failures.push({ code: t.moneydjCode, reason: `HTTP_${error.httpStatus}` });
        await new Promise((r) => setTimeout(r, 2_000));
        backoffStop = true;
        break;
      }
      const message = String(error).slice(0, 300);
      if (/DISCLOSED_HOLDINGS_MISSING|DISCLOSURE_DATE_MISSING/.test(message)) {
        parseFailed++;
      } else if (/READBACK_FAILED|SINGLE_WRITER_LOCKED/.test(message)) {
        retryable++;
        failed++;
      } else {
        failed++;
      }
      failures.push({ code: t.moneydjCode, reason: message });
    }
  }

  const reachedEnd = !backoffStop && !timeBudgetStop && targets.length < batch;
  const nextCursor = reachedEnd ? "" : lastId;
  const after: CheckpointRow = {
    lastSymbol: nextCursor,
    processed: (before?.processed ?? 0) + attempted,
    succeeded: (before?.succeeded ?? 0) + initialWrite + updated,
    failed: (before?.failed ?? 0) + failed,
    updatedAt: new Date().toISOString(),
  };
  await writeCheckpoint(`${JOB}:MONEYDJ`, CHECKPOINT_KEY, runId, {
    lastSymbol: nextCursor,
    processed: after.processed,
    succeeded: after.succeeded,
    failed: after.failed,
  });

  const wrote = initialWrite + updated;
  const status = backoffStop || (failed > 0 && wrote === 0) ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, `${JOB}:MONEYDJ`, "MONEYDJ", startedMs, {
    status,
    attempted,
    completed: attempted - failed,
    inserted: holdingsTotal,
    updated: wrote,
    failed,
    retryableFailures: retryable,
    checkpointAfter: after,
    error: failures.length ? `${failures.length} failures; e.g. ${failures[0]?.reason}` : null,
    details: {
      checkpoint_before: before,
      batch_size: batch,
      wrapped,
      reached_end: reachedEnd,
      backoff_stop: backoffStop,
      time_budget_stop: timeBudgetStop,
      window_size: targets.length,
      initial_write: initialWrite,
      updated,
      no_change: noChange,
      stale_skip: staleSkip,
      parse_failed: parseFailed,
      empty_holdings: emptyHoldings,
      http_403: http403,
      http_429: http429,
      http_5xx: 0,
      master_already_fetched: masterAlreadyFetched,
      master_aware: true,
      sample_failures: failures.slice(0, 5),
    },
  });

  return Response.json({
    ok: true,
    job: JOB,
    provider: "MONEYDJ",
    runId,
    httpStatus: 200,
    checked: attempted,
    initialWrite,
    updated,
    noChange,
    staleSkip,
    emptyHoldings,
    parseFailed,
    failed,
    retryableFailures: retryable,
    masterAlreadyFetched,
    masterAware: true,
    holdingsTotal,
    canonicalMapped: 0,
    unmapped: holdingsTotal,
    mappingPct: 0,
    http403,
    http429,
    backoffStop,
    timeBudgetStop,
    checkpointBefore: before?.lastSymbol ?? null,
    checkpointAfter: nextCursor || "(wrapped to start)",
    wrapped,
    reachedEnd,
    universeCount,
    runtimeMs: Date.now() - startedMs,
    status,
    duplicateShareClassFetchRisk: true,
  });
}
