// Cloud MoneyDJ ETF holdings worker — bounded, idempotent, resumable via DB checkpoint.
//
// Reuses the MoneyDJ ETF holdings contract from
// scripts/data/etf-moneydj/run-etf-moneydj-holdings-bounded.ts (see lib/cloud-ingestion/moneydjEtfHoldings.ts):
// same Basic0007 URL, same cheerio parse, same etf_holding_snapshots / etf_holdings write path,
// same source string MONEYDJ_ETF_PUBLIC. No parser rewrite.
//
// Trigger: GitHub Actions schedule -> GET with `Authorization: Bearer <CRON_SECRET>`.
// One invocation: read ROLLING checkpoint -> next <=BATCH ETFs (with MoneyDJ coverage) by id ->
// fetch -> incremental date compare -> only-newer write -> advance checkpoint -> run log -> return.
// 403/429 => 2s backoff, stop early, PARTIAL, never clear existing data. No loop.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import {
  fetchMoneydjEtfHoldings,
  MoneydjEtfHttpError,
  persistMoneydjEtfHoldings,
  MONEYDJ_ETF_SOURCE,
} from "@/lib/cloud-ingestion/moneydjEtfHoldings";
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

const JOB = "CLOUD_MONEYDJ_ETF";
const PROVIDER = "MONEYDJ_ETF_PUBLIC";
const CHECKPOINT_KEY = "cloud-moneydj-etf:ROLLING";
const DEFAULT_BATCH = 150;
const MAX_BATCH = 300;

type EtfRow = {
  id: string;
  code: string;
  exchange: string | null;
  data_source: string | null;
  db_date: string | null; // latest existing MONEYDJ_ETF_PUBLIC effective_date (YYYY-MM-DD)
};

// ETFs with MoneyDJ coverage: those that already have a MONEYDJ_ETF_PUBLIC snapshot, plus TW-listed
// ETFs (where the .TW / .TWO etfid reliably resolves). Priority: never-fetched first, then oldest
// holdings date, then id — but the ROLLING id cursor is what guarantees full coverage + resumability.
async function nextEtfs(cursor: string, batch: number): Promise<EtfRow[]> {
  return prisma.$queryRawUnsafe<EtfRow[]>(
    `SELECT e.id, e.code, e.exchange, e.data_source,
            to_char(s.max_eff, 'YYYY-MM-DD') AS db_date
       FROM etfs e
       LEFT JOIN LATERAL (
         SELECT MAX(effective_date) AS max_eff
           FROM etf_holding_snapshots
          WHERE etf_id = e.id AND source = $1
       ) s ON TRUE
      WHERE e.is_active = TRUE
        AND e.id > $2
        AND ( s.max_eff IS NOT NULL OR e.exchange IN ('TWSE','TPEx','TPEX') )
      ORDER BY e.id
      LIMIT $3`,
    MONEYDJ_ETF_SOURCE,
    cursor,
    batch,
  );
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const url = new URL(request.url);
  const batch = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("batch") ?? DEFAULT_BATCH)));
  const startedMs = Date.now();

  const universeRows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n
       FROM etfs e
      WHERE e.is_active = TRUE
        AND ( EXISTS (SELECT 1 FROM etf_holding_snapshots s WHERE s.etf_id = e.id AND s.source = $1)
              OR e.exchange IN ('TWSE','TPEx','TPEX') )`,
    MONEYDJ_ETF_SOURCE,
  );
  const universeCount = Number(universeRows[0]?.n ?? 0);

  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = hourBucketKey("cloud-moneydj-etf");
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
  let etfs = await nextEtfs(cursor, batch);
  if (etfs.length === 0 && cursor !== "") {
    wrapped = true;
    cursor = "";
    etfs = await nextEtfs(cursor, batch);
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
  let http5xx = 0;
  let holdingsTotal = 0;
  let rowsWrittenTotal = 0;
  let backoffStop = false;
  const failures: Array<{ code: string; reason: string }> = [];
  let lastId = cursor;

  for (const etf of etfs) {
    lastId = etf.id;
    attempted++;
    try {
      const data = await fetchMoneydjEtfHoldings({
        code: etf.code,
        exchange: etf.exchange,
        dataSource: etf.data_source,
      });
      if (!data.holdings.length) {
        emptyHoldings++;
        continue;
      }
      // incremental date rule — never let an older provider date land
      if (etf.db_date) {
        if (data.holdingsDate < etf.db_date) {
          staleSkip++;
          continue;
        }
        if (data.holdingsDate === etf.db_date) {
          noChange++;
          continue;
        }
      }
      const res = await persistMoneydjEtfHoldings(prisma, { etfId: etf.id, data });
      holdingsTotal += data.holdings.length;
      rowsWrittenTotal += res.rowsWritten;
      if (etf.db_date) updated++;
      else initialWrite++;
    } catch (error) {
      if (error instanceof MoneydjEtfHttpError) {
        if (error.httpStatus === 403) http403++;
        else http429++;
        failed++;
        retryable++;
        failures.push({ code: etf.code, reason: `HTTP_${error.httpStatus}` });
        await new Promise((r) => setTimeout(r, 2_000)); // bounded backoff, then stop the batch
        backoffStop = true;
        break;
      }
      const message = String(error).slice(0, 300);
      if (/HOLDINGS_UNAVAILABLE/.test(message)) {
        parseFailed++;
      } else if (/HTTP_5\d\d/.test(message)) {
        http5xx++;
        retryable++;
        failed++;
      } else {
        failed++;
      }
      failures.push({ code: etf.code, reason: message });
    }
  }

  const reachedEnd = !backoffStop && etfs.length < batch;
  const nextCursor = reachedEnd ? "" : lastId;
  const after: CheckpointRow = {
    lastSymbol: nextCursor,
    processed: (before?.processed ?? 0) + attempted,
    succeeded: (before?.succeeded ?? 0) + initialWrite + updated,
    failed: (before?.failed ?? 0) + failed,
    updatedAt: new Date().toISOString(),
  };
  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: nextCursor,
    processed: after.processed,
    succeeded: after.succeeded,
    failed: after.failed,
  });

  const wrote = initialWrite + updated;
  const status = backoffStop || (failed > 0 && wrote === 0) ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status,
    attempted,
    completed: attempted - failed,
    inserted: rowsWrittenTotal,
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
      window_size: etfs.length,
      no_change: noChange,
      stale_skip: staleSkip,
      initial_write: initialWrite,
      updated,
      parse_failed: parseFailed,
      empty_holdings: emptyHoldings,
      http_403: http403,
      http_429: http429,
      http_5xx: http5xx,
      // MoneyDJ ETF contract is raw-holding only; canonical security resolution is a downstream job.
      canonical_mapped: 0,
      unmapped: holdingsTotal,
      sample_failures: failures.slice(0, 5),
    },
  });

  return Response.json({
    ok: true,
    job: JOB,
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
    holdingsTotal,
    rowsWritten: rowsWrittenTotal,
    canonicalMapped: 0,
    unmapped: holdingsTotal,
    mappingPct: 0,
    http403,
    http429,
    http5xx,
    backoffStop,
    checkpointBefore: before?.lastSymbol ?? null,
    checkpointAfter: nextCursor || "(wrapped to start)",
    wrapped,
    reachedEnd,
    universeCount,
    runtimeMs: Date.now() - startedMs,
    status,
  });
}
