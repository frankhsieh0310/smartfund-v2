// Cloud MoneyDJ fund worker — bounded, idempotent, resumable via DB checkpoint.
//
// Reuses the MoneyDJ disclosure contract from
// scripts/data/global-fund/run-fund-moneydj-disclosure.ts (see lib/cloud-ingestion/moneydjFundDisclosure.ts).
// No scraper logic is duplicated beyond that single-page parse contract; the DB write path,
// conflict target and advisory lock are identical to the existing local job.
//
// Trigger: GitHub Actions schedule -> GET with `Authorization: Bearer <CRON_SECRET>`.
// One invocation: read ROLLING checkpoint -> next <=BATCH mapped fund codes by fund id ->
// fetch MoneyDJ -> compare 資料月份 -> only-newer write -> advance checkpoint -> run log -> return.
// 403/429 => bounded backoff, mark PARTIAL, stop early, never clear existing data. No loop.
//
// TODO_MASTER_FUND_DEDUP = YES  (per-code behavior retained this round; master/share-class
// dedup is a later phase and is not attempted here.)

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import {
  fetchMoneydjDisclosure,
  MoneydjHttpError,
  persistMoneydjDisclosure,
  MONEYDJ_SOURCE,
} from "@/lib/cloud-ingestion/moneydjFundDisclosure";
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

const JOB = "CLOUD_MONEYDJ_FUND";
const PROVIDER = "MONEYDJ";
const CHECKPOINT_KEY = "cloud-moneydj-fund:ROLLING";
// 2026-10-08: confirmed in Production that no CLOUD_MONEYDJ_FUND run has EVER reached COMPLETED —
// every invocation is left permanently IN_PROGRESS with attempted=0, because run stats are only
// written once by finishRun() at the very end of the loop (same gap as the cloud-etf-price hang
// fixed in d800f8097), and a 200-fund batch cannot reliably finish inside maxDuration=300s: the
// nextCodes() lookup alone measured ~12.5s, leaving an unrealistic per-item budget for 200 real
// MoneyDJ fetch+parse+persist calls (each already individually timeout-protected at 30s). Lowered
// to a batch size this window can realistically complete start-to-finish; no change to the fetch,
// parse, persist, checkpoint or backoff logic itself.
const DEFAULT_BATCH = 50;
const MAX_BATCH = 80;
const FRESH_DAYS = 25; // matches the local disclosure worker's re-fetch guard
// 2026-10-08: the real fix for "every run stuck IN_PROGRESS" is a time budget, not just a smaller
// batch cap — a smaller batch only lowers the odds of running out of time, it doesn't guarantee a
// checkpoint gets written before Vercel's hard maxDuration kill. Same margin convention as
// yahoo-etf-full-sweep (TIME_BUDGET_MS well under maxDuration=300s so a checkpoint write always
// happens). Not a maxDuration increase — maxDuration stays 300.
const TIME_BUDGET_MS = 240_000;

type MappedFund = { fundId: string; moneydjCode: string; canonicalName: string };

export type MoneydjBatchOutcome = {
  attempted: number;
  updatedFunds: number;
  rowsPersisted: number;
  failed: number;
  retryable: number;
  http403: number;
  http429: number;
  alreadyCurrent: number;
  backoffStop: boolean;
  timeBudgetStop: boolean;
  failures: Array<{ code: string; reason: string }>;
  lastId: string;
};

// Pure-ish loop (only effects are the two injected callbacks) extracted so the time-budget /
// per-item-checkpoint contract can be tested directly, without a live DB or network call: given a
// `now` that reports elapsed time past the budget partway through, and a `processOne` that resolves
// instantly, the test asserts onProgress fires after every reached item (not just once at the end)
// and the loop stops — with `lastId` pointing at the right resume point — exactly at the budget.
export async function runMoneydjBatch(
  codes: MappedFund[],
  opts: {
    cursor: string;
    startedMs: number;
    timeBudgetMs: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    processOne: (fund: MappedFund) => Promise<{ rowsPersisted: number; isNewMonth: boolean }>;
    onProgress: (lastId: string, counters: { attempted: number; updatedFunds: number; failed: number }) => Promise<void>;
  },
): Promise<MoneydjBatchOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let attempted = 0;
  let updatedFunds = 0;
  let rowsPersisted = 0;
  let failed = 0;
  let retryable = 0;
  let http403 = 0;
  let http429 = 0;
  let alreadyCurrent = 0;
  let backoffStop = false;
  let timeBudgetStop = false;
  const failures: Array<{ code: string; reason: string }> = [];
  let lastId = opts.cursor;

  for (const fund of codes) {
    if (now() - opts.startedMs > opts.timeBudgetMs) {
      timeBudgetStop = true;
      break;
    }
    lastId = fund.fundId;
    attempted++;
    try {
      const result = await opts.processOne(fund);
      rowsPersisted += result.rowsPersisted;
      if (result.isNewMonth) updatedFunds++;
      else alreadyCurrent++;
    } catch (error) {
      if (error instanceof MoneydjHttpError) {
        if (error.httpStatus === 403) http403++;
        else http429++;
        failed++;
        retryable++;
        failures.push({ code: fund.moneydjCode, reason: `HTTP_${error.httpStatus}` });
        await opts.onProgress(lastId, { attempted, updatedFunds, failed });
        // bounded backoff: one short pause, then stop the batch (no aggressive retry)
        await sleep(2_000);
        backoffStop = true;
        break;
      }
      failed++;
      const message = String(error).slice(0, 300);
      if (/READBACK_FAILED|SINGLE_WRITER_LOCKED/.test(message)) retryable++;
      failures.push({ code: fund.moneydjCode, reason: message });
    }
    // Progress checkpoint after every fund we reached, success or non-backoff failure alike — the
    // cursor only ever needs to mean "everything up to and including this id has been attempted."
    // This is what makes a fund already successfully processed safe from re-fetch/re-write even if
    // this invocation is hard-killed immediately after: onProgress, not the run's final return, is
    // what the next invocation's readCheckpoint() actually resumes from.
    await opts.onProgress(lastId, { attempted, updatedFunds, failed });
  }

  return { attempted, updatedFunds, rowsPersisted, failed, retryable, http403, http429, alreadyCurrent, backoffStop, timeBudgetStop, failures, lastId };
}

async function nextCodes(cursor: string, batch: number): Promise<MappedFund[]> {
  return prisma.$queryRawUnsafe<MappedFund[]>(
    `SELECT f.id AS "fundId", m.moneydj_code AS "moneydjCode", f.name AS "canonicalName"
       FROM fund_mappings m
       JOIN funds f ON f.id = m.fund_id
      WHERE m.moneydj_code IS NOT NULL
        AND f.id > $1
        AND NOT EXISTS (
          SELECT 1 FROM holdings h
           WHERE h.fund_id = f.id AND h.source = $2
             AND h.as_of_date >= CURRENT_DATE - ($3 || ' days')::interval
        )
      ORDER BY f.id
      LIMIT $4`,
    cursor,
    MONEYDJ_SOURCE,
    String(FRESH_DAYS),
    batch,
  );
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const url = new URL(request.url);
  const batch = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("batch") ?? DEFAULT_BATCH)));
  const startedMs = Date.now();

  const universeRows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n FROM fund_mappings WHERE moneydj_code IS NOT NULL`,
  );
  const universeCount = Number(universeRows[0]?.n ?? 0);

  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = hourBucketKey("cloud-moneydj-fund");
  const { runId, skipped } = await beginRun({
    jobName: JOB,
    provider: PROVIDER,
    runKey,
    universeCount,
    batchSize: batch,
    checkpointBefore: before,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey });
  }

  let cursor = before?.lastSymbol ?? "";
  let wrapped = false;
  let codes = await nextCodes(cursor, batch);
  if (codes.length === 0 && cursor !== "") {
    wrapped = true;
    cursor = "";
    codes = await nextCodes(cursor, batch);
  }

  const outcome = await runMoneydjBatch(codes, {
    cursor,
    startedMs,
    timeBudgetMs: TIME_BUDGET_MS,
    processOne: (fund) =>
      fetchMoneydjDisclosure(fund.moneydjCode).then((disclosure) =>
        persistMoneydjDisclosure(prisma, { fundId: fund.fundId, shareClassId: null, moneydjCode: fund.moneydjCode, disclosure }),
      ),
    onProgress: (lastSymbol, counters) =>
      writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
        lastSymbol,
        processed: (before?.processed ?? 0) + counters.attempted,
        succeeded: (before?.succeeded ?? 0) + counters.updatedFunds,
        failed: (before?.failed ?? 0) + counters.failed,
      }),
  });
  const {
    attempted,
    updatedFunds,
    rowsPersisted,
    failed,
    retryable,
    http403,
    http429,
    alreadyCurrent,
    backoffStop,
    timeBudgetStop,
    failures,
    lastId,
  } = outcome;

  // Advance cursor to the last code we *reached*. If we stopped on backoff or the time budget, keep
  // the cursor there so the next run resumes from the same place. If the window was short, we hit
  // the tail -> wrap.
  const reachedEnd = !backoffStop && !timeBudgetStop && codes.length < batch;
  const nextCursor = reachedEnd ? "" : lastId;
  const after: CheckpointRow = {
    lastSymbol: nextCursor,
    processed: (before?.processed ?? 0) + attempted,
    succeeded: (before?.succeeded ?? 0) + updatedFunds,
    failed: (before?.failed ?? 0) + failed,
    updatedAt: new Date().toISOString(),
  };
  // Final write: same shape as saveProgress, but also resolves reachedEnd's wrap-to-start case,
  // which saveProgress (called mid-loop, before that's known) can't express.
  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: nextCursor,
    processed: after.processed,
    succeeded: after.succeeded,
    failed: after.failed,
  });

  const status =
    backoffStop || timeBudgetStop || (failed > 0 && updatedFunds === 0 && rowsPersisted === 0) ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status,
    attempted,
    completed: attempted - failed,
    inserted: rowsPersisted,
    updated: updatedFunds,
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
      time_budget_ms: TIME_BUDGET_MS,
      window_size: codes.length,
      already_current: alreadyCurrent,
      http_403: http403,
      http_429: http429,
      http_5xx: 0,
      todo_master_fund_dedup: true,
      sample_failures: failures.slice(0, 5),
    },
  });

  return Response.json({
    ok: true,
    job: JOB,
    runId,
    httpStatus: 200,
    checked: attempted,
    updated: updatedFunds,
    holdingRowsPersisted: rowsPersisted,
    alreadyCurrent,
    failed,
    retryableFailures: retryable,
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
    todoMasterFundDedup: true,
  });
}
