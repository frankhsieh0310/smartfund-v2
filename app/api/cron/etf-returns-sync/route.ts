// Task X: daily ETF return sync — writes ONLY Yahoo's own fundPerformance.trailingReturns numbers
// into etf_performances (1M/3M/YTD/1Y/3Y/5Y; 3Y/5Y are Yahoo's own ANNUALIZED figures, confirmed live
// this session against an independently-computed CAGR). Never computes a return itself. A brand-new
// file/endpoint — does not modify lib/yahoo/etfEnrich.ts or any existing cron route; reuses the
// SAME upsert shape that pipeline already uses (lib/etf-returns-sync/returnsWriter.ts), so the two
// pipelines coexist on the same table without clobbering each other's columns (COALESCE-based).
//
// SHADOW MODE BY DEFAULT: unless ETF_RETURNS_SYNC_WRITE is exactly "on"
// (lib/etf-returns-sync/writeGate.ts), this route fetches and classifies but writes nothing.
//
// Completion is DB-truth based, not checkpoint-based (Task X item B.3, same principle Task W4/W6
// established for market-close-sync): an ETF counts as "done for today" only if etf_performances
// already has a row for it dated today. The checkpoint below is purely a forward-sweep cursor for
// ordering within one invocation's time budget — never trusted to mean "done" on its own.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { fetchQuoteSummary, newRateStats, rawNum, type RateStats } from "@/lib/yahoo/productSession";
import { isWriteEnabled, currentRunMode, writeEnvDiagnostic } from "@/lib/etf-returns-sync/writeGate";
import { writeBatchIfEnabled, type WriteCandidate, type TrailingReturns } from "@/lib/etf-returns-sync/returnsWriter";

const JOB = "ETF_RETURNS_SYNC";
const TIME_BUDGET_MS = 240_000;
const REQUEST_DELAY_MS = 400; // matches the existing Yahoo ETF enrichment pipeline's own pacing
const CORE_UNIVERSE_LOOKBACK_DAYS = 20;
const CORE_UNIVERSE_MIN_ACTIVE_DAYS = 15;
const CHECKPOINT_KEY = "etf-returns-sync:cursor";

const writerQuery = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function todayLocalDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Task X's own core-universe definition (20 trading days lookback, >=15 active) — a self-contained
 * equivalent of lib/market-close-sync/coreUniverse.ts's rule, deliberately NOT imported from there so
 * this feature stays fully independent of that pipeline (per the task's "不修改既有管線" — and
 * importing from it would couple this feature's correctness to a module whose tuning this task never
 * reviewed). Uses Prisma's own query builder (findMany/groupBy-equivalent via raw aggregation is
 * still needed for the window-function logic, but ids are handled as Prisma-typed scalars, never a
 * raw array bind parameter, avoiding the exact class of issue Task W6 found). */
async function computeCoreUniverseIds(): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ etf_id: string; days_available: bigint; active_days: bigint }>>(
    `WITH ranked AS (
       SELECT h.etf_id, h.volume, h.close,
              row_number() OVER (PARTITION BY h.etf_id ORDER BY h.date DESC) AS rn
       FROM etf_history h
       JOIN etfs e ON e.id = h.etf_id
       WHERE e.is_active = true AND e.data_source IS NOT NULL
     )
     SELECT etf_id,
            count(*) FILTER (WHERE rn <= $1) AS days_available,
            count(*) FILTER (WHERE rn <= $1 AND ((volume IS NOT NULL AND volume > 0) OR close IS NOT NULL)) AS active_days
     FROM ranked WHERE rn <= $1 GROUP BY etf_id`,
    CORE_UNIVERSE_LOOKBACK_DAYS,
  );
  const core = new Set<string>();
  for (const r of rows) {
    if (Number(r.days_available) >= CORE_UNIVERSE_MIN_ACTIVE_DAYS && Number(r.active_days) >= CORE_UNIVERSE_MIN_ACTIVE_DAYS) core.add(r.etf_id);
  }
  return core;
}

/** DB-truth: which core-universe ETFs are still missing a return row for `date`. Prisma
 * findMany/where/in, batched at 1,000 — never a handwritten `= ANY($1)` array bind (Task W6's fix
 * applied here from the start, not retrofitted after a crash). */
async function lookupMissingForDate(coreIds: string[], date: string): Promise<string[]> {
  if (coreIds.length === 0) return [];
  const present = new Set<string>();
  const BATCH = 1000;
  for (let i = 0; i < coreIds.length; i += BATCH) {
    const batch = coreIds.slice(i, i + BATCH);
    const rows = await prisma.etfPerformance.findMany({
      where: { etfId: { in: batch }, date: new Date(`${date}T00:00:00.000Z`) },
      select: { etfId: true },
    });
    for (const r of rows) present.add(r.etfId);
  }
  return coreIds.filter((id) => !present.has(id));
}

function parseTrailingReturns(result: any): TrailingReturns {
  const t = result?.fundPerformance?.trailingReturns ?? {};
  const pctOf = (v: any): number | null => {
    const raw = rawNum(v);
    if (raw == null) return null;
    // Same convention as the existing Yahoo ETF enrichment pipeline: a fmt string containing "%", or
    // a raw magnitude small enough to plausibly be a fraction (<=2), is treated as a fraction and
    // scaled to percent units; otherwise the raw value is already in percent units.
    const fmt = v && typeof v === "object" && typeof v.fmt === "string" ? v.fmt : "";
    return fmt.includes("%") || Math.abs(raw) <= 2 ? raw * 100 : raw;
  };
  return {
    r1d: pctOf(t.oneDay), r1m: pctOf(t.oneMonth), r3m: pctOf(t.threeMonth), r6m: pctOf(t.sixMonth),
    rytd: pctOf(t.ytd), r1y: pctOf(t.oneYear), r3y: pctOf(t.threeYear), r5y: pctOf(t.fiveYear),
  };
}

type EtfRow = { id: string; code: string; data_source: string };

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const today = todayLocalDate();
  const writeEnabledThisRun = isWriteEnabled();

  const coreUniverseIds = await computeCoreUniverseIds();
  const coreIdsArray = [...coreUniverseIds];
  const missingIds = await lookupMissingForDate(coreIdsArray, today);
  const missingSet = new Set(missingIds);

  const runKey = `etf-returns-sync:${today}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_QUOTE_SUMMARY", runKey,
    universeCount: coreUniverseIds.size, batchSize: 1, checkpointBefore: null,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present today", runKey, runMode: currentRunMode() });
  }

  if (missingIds.length === 0) {
    await finishRun(runId, JOB, "YAHOO_QUOTE_SUMMARY", startedMs, {
      status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      checkpointAfter: null, details: { run_mode: currentRunMode(), core_universe_size: coreUniverseIds.size, missing_count: 0 },
    });
    return Response.json({ ok: true, job: JOB, runId, status: "COMPLETED", runMode: currentRunMode(), missingCount: 0, coreUniverseSize: coreUniverseIds.size });
  }

  // Checkpoint cursor: purely a speed hint for ordering within/across invocations on the SAME day —
  // reset whenever the date changes (a new day's missing-set is unrelated to yesterday's cursor
  // position). Never consulted to decide "done" — lookupMissingForDate's fresh DB query already did
  // that, unconditionally, above.
  const before = await readCheckpoint(CHECKPOINT_KEY);
  let cursor = "";
  try {
    const persisted = before?.lastSymbol ? JSON.parse(before.lastSymbol) : null;
    if (persisted?.date === today) cursor = persisted.cursor ?? "";
  } catch { /* corrupt/old checkpoint — start a fresh sweep */ }

  const sortedMissing = [...missingSet].sort();
  const startIdx = Math.max(0, sortedMissing.findIndex((id) => id > cursor));
  const orderedMissing = startIdx === -1 ? sortedMissing : sortedMissing.slice(startIdx);

  const rows = await prisma.$queryRawUnsafe<EtfRow[]>(
    `SELECT id, code, data_source FROM etfs WHERE id = ANY($1::text[])`,
    orderedMissing,
  );
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const stats: RateStats = newRateStats();
  let attempted = 0, written = 0, fetchFailed = 0, writeErrorCount = 0, droppedFieldCount = 0;
  let lastProcessedId = cursor;
  let timeBudgetStop = false;

  for (const etfId of orderedMissing) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    const row = rowById.get(etfId);
    if (!row) { lastProcessedId = etfId; continue; } // stale id, no longer a real etfs row — skip, never blocks the sweep

    attempted++;
    try {
      const res = await fetchQuoteSummary(row.data_source, ["fundPerformance"], stats);
      if (!res) {
        fetchFailed++;
      } else {
        const returns = parseTrailingReturns(res.result);
        const candidate: WriteCandidate = { etfId: row.id, date: today, returns };
        const writeResult = await writeBatchIfEnabled(writerQuery, [candidate], new Date().toISOString(), writeEnabledThisRun);
        written += writeResult.written;
        writeErrorCount += writeResult.writeErrorCount;
        droppedFieldCount += writeResult.droppedFieldCount;
      }
    } catch {
      fetchFailed++; // never propagated — Task X item B.3's error isolation: one ETF's failure never aborts the sweep
    }
    lastProcessedId = etfId;
    await sleep(REQUEST_DELAY_MS);
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: JSON.stringify({ date: today, cursor: lastProcessedId }),
    processed: attempted, succeeded: written, failed: fetchFailed + writeErrorCount,
  });

  const status = timeBudgetStop ? "PARTIAL" : "COMPLETED";
  const writeEnvDiag = writeEnvDiagnostic();
  await finishRun(runId, JOB, "YAHOO_QUOTE_SUMMARY", startedMs, {
    status, attempted, completed: written, inserted: written, updated: 0, failed: fetchFailed + writeErrorCount, retryableFailures: fetchFailed,
    checkpointAfter: null,
    details: {
      run_mode: currentRunMode(), core_universe_size: coreUniverseIds.size, missing_count_at_start: missingIds.length,
      attempted, written, fetch_failed: fetchFailed, write_error_count: writeErrorCount, dropped_field_count: droppedFieldCount,
      rate_stats: stats, write_env_read_exactly_on: writeEnvDiag.readExactlyOn, write_env_var_present: writeEnvDiag.envVarPresent,
      deployment_id: writeEnvDiag.deploymentId, deployment_url: writeEnvDiag.deploymentUrl,
    },
  });

  return Response.json({
    ok: true, job: JOB, runId, status, runMode: currentRunMode(),
    coreUniverseSize: coreUniverseIds.size, missingCountAtStart: missingIds.length,
    attempted, written, fetchFailed, writeErrorCount, droppedFieldCount, timeBudgetStop,
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
