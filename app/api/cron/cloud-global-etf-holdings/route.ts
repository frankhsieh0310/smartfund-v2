// Cloud global (official issuer) ETF holdings worker — BlackRock / iShares latest-holdings.csv.
// Bounded, idempotent, resumable via DB checkpoint. Reuses the iShares CSV contract + the
// `holdings` (asset_type='ETF') DELETE-and-replace write from
// scripts/data/etf-holdings/run-ishares-holdings.ts (see lib/cloud-ingestion/globalEtfHoldings.ts).
//
// Trigger: GitHub Actions schedule -> GET with `Authorization: Bearer <CRON_SECRET>`.
// One invocation: read the provider ROLLING checkpoint -> next <=BATCH mapped ETFs by id ->
// fetch CSV -> incremental as-of date compare -> only-newer write -> advance checkpoint -> run log
// -> return. 403/429 => 2s backoff, stop provider, PARTIAL. 5xx => one retry. Per-ETF failure is
// isolated. Soft 240s budget so we always checkpoint before maxDuration. No loop.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import {
  fetchIsharesHoldings,
  GlobalEtfHttpError,
  getIsharesUniverse,
  ISHARES_HOLDINGS_SOURCE,
  persistIsharesHoldings,
} from "@/lib/cloud-ingestion/globalEtfHoldings";
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

const JOB = "CLOUD_GLOBAL_ETF_HOLDINGS";
const DEFAULT_BATCH = 100;
const MAX_BATCH = 200;
const TIME_BUDGET_MS = 240_000;

// BlackRock and iShares are one issuer on one feed; both resolve to the iShares CSV universe and
// the same BLACKROCK_OFFICIAL_CSV source string. Distinct checkpoint keys are kept per the spec.
function resolveProvider(raw: string | null): "ISHARES" | "BLACKROCK" {
  const v = (raw ?? "ALL").toUpperCase();
  return v === "BLACKROCK" ? "BLACKROCK" : "ISHARES";
}
const checkpointKey = (p: string) => `cloud-global-etf-holdings:${p}`;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const url = new URL(request.url);
  const provider = resolveProvider(url.searchParams.get("provider"));
  const batch = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("batch") ?? DEFAULT_BATCH)));
  const startedMs = Date.now();
  const CHECKPOINT_KEY = checkpointKey(provider);

  const universe = getIsharesUniverse(); // [{ code, sourceUrl }]
  const byCode = new Map(universe.map((p) => [p.code.toUpperCase(), p]));
  // Resolve config codes to live ETF rows, ordered by id (deterministic cursor). Attach the latest
  // existing as-of date for this source so we can apply the incremental rule.
  const mapped = await prisma.$queryRawUnsafe<
    Array<{ id: string; code: string; asset_id: string | null; db_date: string | null }>
  >(
    `SELECT e.id, UPPER(e.code) AS code, e.asset_id,
            to_char(h.max_asof, 'YYYY-MM-DD') AS db_date
       FROM etfs e
       LEFT JOIN LATERAL (
         SELECT MAX(as_of_date) AS max_asof
           FROM holdings
          WHERE etf_id = e.id AND asset_type = 'ETF' AND source = $2
       ) h ON TRUE
      WHERE e.is_active = TRUE AND UPPER(e.code) = ANY($1::text[])
      ORDER BY e.id`,
    [...byCode.keys()],
    ISHARES_HOLDINGS_SOURCE,
  );
  const universeCount = mapped.length;

  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = hourBucketKey(`CLOUD_GLOBAL_ETF_HOLDINGS:${provider}`);
  const { runId, skipped } = await beginRun({
    jobName: `${JOB}:${provider}`,
    provider,
    runKey,
    universeCount,
    batchSize: batch,
    checkpointBefore: before,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, provider, skipped: true, reason: "run_key already present this hour", runKey });
  }

  let cursor = before?.lastSymbol ?? "";
  let wrapped = false;
  const windowOf = (c: string) => mapped.filter((m) => m.id > c).slice(0, batch);
  let window = windowOf(cursor);
  if (window.length === 0 && cursor !== "") {
    wrapped = true;
    cursor = "";
    window = windowOf(cursor);
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
  let canonicalMapped = 0;
  let backoffStop = false;
  let timeBudgetStop = false;
  const failures: Array<{ code: string; reason: string }> = [];
  let lastId = cursor;

  for (const etf of window) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) {
      timeBudgetStop = true;
      break;
    }
    lastId = etf.id;
    const product = byCode.get(etf.code);
    if (!product) {
      parseFailed++;
      failures.push({ code: etf.code, reason: "NO_PRODUCT_URL" });
      continue;
    }
    attempted++;
    try {
      let data;
      try {
        data = await fetchIsharesHoldings(product);
      } catch (err) {
        if (err instanceof Error && /GLOBAL_ETF_HTTP_5\d\d/.test(err.message)) {
          await new Promise((r) => setTimeout(r, 1_500)); // one limited retry on 5xx
          data = await fetchIsharesHoldings(product);
          http5xx++;
        } else {
          throw err;
        }
      }
      if (!data.rows.length) {
        emptyHoldings++;
        continue;
      }
      if (etf.db_date) {
        if (data.asOfIso < etf.db_date) {
          staleSkip++;
          continue;
        }
        if (data.asOfIso === etf.db_date) {
          noChange++;
          continue;
        }
      }
      const res = await persistIsharesHoldings(prisma, { etfId: etf.id, assetId: etf.asset_id, data });
      holdingsTotal += res.written;
      canonicalMapped += res.matched;
      if (etf.db_date) updated++;
      else initialWrite++;
    } catch (error) {
      if (error instanceof GlobalEtfHttpError) {
        if (error.httpStatus === 403) http403++;
        else http429++;
        failed++;
        retryable++;
        failures.push({ code: etf.code, reason: `HTTP_${error.httpStatus}` });
        await new Promise((r) => setTimeout(r, 2_000));
        backoffStop = true;
        break;
      }
      const message = String(error).slice(0, 300);
      if (/ISHARES_NOT_CSV|ISHARES_CSV_INVALID|ISHARES_CSV_NO_ROWS|ISHARES_CSV_ASOF/.test(message)) {
        parseFailed++;
      } else if (/GLOBAL_ETF_HTTP_5\d\d/.test(message)) {
        http5xx++;
        retryable++;
        failed++;
      } else {
        failed++;
      }
      failures.push({ code: etf.code, reason: message });
    }
  }

  const reachedEnd = !backoffStop && !timeBudgetStop && window.length < batch;
  const nextCursor = reachedEnd ? "" : lastId;
  const after: CheckpointRow = {
    lastSymbol: nextCursor,
    processed: (before?.processed ?? 0) + attempted,
    succeeded: (before?.succeeded ?? 0) + initialWrite + updated,
    failed: (before?.failed ?? 0) + failed,
    updatedAt: new Date().toISOString(),
  };
  await writeCheckpoint(`${JOB}:${provider}`, CHECKPOINT_KEY, runId, {
    lastSymbol: nextCursor,
    processed: after.processed,
    succeeded: after.succeeded,
    failed: after.failed,
  });

  const wrote = initialWrite + updated;
  const status = backoffStop || (failed > 0 && wrote === 0) ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, `${JOB}:${provider}`, provider, startedMs, {
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
      window_size: window.length,
      initial_write: initialWrite,
      updated,
      no_change: noChange,
      stale_skip: staleSkip,
      parse_failed: parseFailed,
      empty_holdings: emptyHoldings,
      http_403: http403,
      http_429: http429,
      http_5xx: http5xx,
      canonical_mapped: canonicalMapped,
      unmapped: holdingsTotal - canonicalMapped,
      sample_failures: failures.slice(0, 5),
    },
  });

  return Response.json({
    ok: true,
    job: JOB,
    provider,
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
    canonicalMapped,
    unmapped: holdingsTotal - canonicalMapped,
    mappingPct: holdingsTotal ? Number(((canonicalMapped / holdingsTotal) * 100).toFixed(2)) : 0,
    http403,
    http429,
    http5xx,
    backoffStop,
    timeBudgetStop,
    checkpointBefore: before?.lastSymbol ?? null,
    checkpointAfter: nextCursor || "(wrapped to start)",
    wrapped,
    reachedEnd,
    universeCount,
    runtimeMs: Date.now() - startedMs,
    status,
  });
}
