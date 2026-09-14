// Cloud fund-NAV worker — bounded, idempotent, resumable via DB checkpoint.
//
// provider=SITCA (and ALL) -> SITCA official daily NAV CSV (one fetch), joined to `funds` by an exact
//   NFKC+whitespace-normalized name, single active match only. Writes fund_history + moves
//   funds.latest_nav* forward only when the SITCA date is strictly newer.
// provider=YAHOO / FUNDCLEAR -> SKIPPED (see lib/cloud-ingestion/fundNav.ts for why).
//
// Trigger: GitHub Actions schedule -> GET with `Authorization: Bearer <CRON_SECRET>`.
// One invocation: fetch the SITCA CSV -> resolve matches -> take <=BATCH funds past the id cursor ->
// incremental date compare -> newer-only write -> advance checkpoint -> run log -> return. No loop.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import {
  fetchSitcaNavRecords,
  FUNDCLEAR_STATUS,
  FundNavHttpError,
  nfkcNameKey,
  persistFundNav,
  SITCA_FSC_NAV_SOURCE,
  YAHOO_FUND_NAV_STATUS,
} from "@/lib/cloud-ingestion/fundNav";
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

const JOB = "CLOUD_FUND_NAV";
const DEFAULT_BATCH = 200;
const MAX_BATCH = 400;
const TIME_BUDGET_MS = 240_000;

function resolveProvider(raw: string | null): "SITCA" | "YAHOO" | "FUNDCLEAR" | "ALL" {
  const v = (raw ?? "ALL").toUpperCase();
  if (v === "YAHOO" || v === "FUNDCLEAR" || v === "SITCA") return v;
  return "ALL";
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const url = new URL(request.url);
  const provider = resolveProvider(url.searchParams.get("provider"));
  const batch = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("batch") ?? DEFAULT_BATCH)));
  const startedMs = Date.now();

  if (provider === "YAHOO") {
    return Response.json({ ok: true, job: JOB, provider, status: "SKIPPED", ...YAHOO_FUND_NAV_STATUS });
  }
  if (provider === "FUNDCLEAR") {
    return Response.json({ ok: true, job: JOB, provider, status: "SKIPPED", ...FUNDCLEAR_STATUS });
  }

  // ---- SITCA (also the ALL default) ----
  const CHECKPOINT_KEY = "cloud-fund-nav:SITCA";
  const before = await readCheckpoint(CHECKPOINT_KEY);

  let records;
  try {
    records = await fetchSitcaNavRecords();
  } catch (error) {
    // fetch failure before any run row: log a FAILED run for visibility, don't touch data
    const rk = hourBucketKey("CLOUD_FUND_NAV:SITCA");
    const { runId, skipped } = await beginRun({
      jobName: `${JOB}:SITCA`,
      provider: "SITCA",
      runKey: rk,
      universeCount: 0,
      batchSize: batch,
      checkpointBefore: before,
    });
    if (!skipped) {
      const is4xx = error instanceof FundNavHttpError;
      await finishRun(runId, `${JOB}:SITCA`, "SITCA", startedMs, {
        status: is4xx ? "PARTIAL" : "FAILED",
        attempted: 0,
        completed: 0,
        inserted: 0,
        updated: 0,
        failed: 1,
        retryableFailures: 1,
        checkpointAfter: before,
        error: String(error).slice(0, 300),
        details: {
          checkpoint_before: before,
          http_403: error instanceof FundNavHttpError && error.httpStatus === 403 ? 1 : 0,
          http_429: error instanceof FundNavHttpError && error.httpStatus === 429 ? 1 : 0,
        },
      });
    }
    return Response.json({ ok: false, job: JOB, provider: "SITCA", error: String(error).slice(0, 300) }, { status: 200 });
  }

  // Build the exact-name -> fund map (single active match only; mark ambiguous names).
  const funds = await prisma.$queryRawUnsafe<
    Array<{ id: string; name: string; currency: string | null; latest_nav_date: string | null }>
  >(`SELECT id, name, currency, to_char(latest_nav_date, 'YYYY-MM-DD') AS latest_nav_date FROM funds WHERE is_active = TRUE`);
  const byName = new Map<string, { id: string; currency: string | null; latest_nav_date: string | null } | "DUP">();
  for (const f of funds) {
    const k = nfkcNameKey(f.name);
    byName.set(k, byName.has(k) ? "DUP" : { id: f.id, currency: f.currency, latest_nav_date: f.latest_nav_date });
  }

  // Resolve records to a single fund; keep the freshest record per fund; order by fund id.
  const resolved = new Map<
    string,
    { fundId: string; nav: number; navDate: string; currency: string | null; dbDate: string | null }
  >();
  let ambiguous = 0;
  let unmatched = 0;
  for (const r of records) {
    const hit = byName.get(nfkcNameKey(r.name));
    if (!hit) {
      unmatched++;
      continue;
    }
    if (hit === "DUP") {
      ambiguous++;
      continue;
    }
    const navDate = r.navDate.toISOString().slice(0, 10);
    const prev = resolved.get(hit.id);
    if (!prev || navDate > prev.navDate) {
      resolved.set(hit.id, { fundId: hit.id, nav: Number(r.nav), navDate, currency: r.currency ?? hit.currency, dbDate: hit.latest_nav_date });
    }
  }
  const universeCount = resolved.size;
  const sorted = [...resolved.values()].sort((a, b) => (a.fundId < b.fundId ? -1 : a.fundId > b.fundId ? 1 : 0));

  const runKey = hourBucketKey("CLOUD_FUND_NAV:SITCA");
  const { runId, skipped } = await beginRun({
    jobName: `${JOB}:SITCA`,
    provider: "SITCA",
    runKey,
    universeCount,
    batchSize: batch,
    checkpointBefore: before,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, provider: "SITCA", skipped: true, reason: "run_key already present this hour", runKey });
  }

  let cursor = before?.lastSymbol ?? "";
  let wrapped = false;
  let window = sorted.filter((r) => r.fundId > cursor).slice(0, batch);
  if (window.length === 0 && cursor !== "") {
    wrapped = true;
    cursor = "";
    window = sorted.slice(0, batch);
  }

  let attempted = 0;
  let initialWrite = 0;
  let updated = 0;
  let noChange = 0;
  let staleSkip = 0;
  let failed = 0;
  let timeBudgetStop = false;
  const failures: Array<{ fund: string; reason: string }> = [];
  let lastId = cursor;

  for (const r of window) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) {
      timeBudgetStop = true;
      break;
    }
    lastId = r.fundId;
    attempted++;
    try {
      if (r.dbDate) {
        if (r.navDate < r.dbDate) {
          staleSkip++;
          continue;
        }
        if (r.navDate === r.dbDate) {
          noChange++;
          continue;
        }
      }
      const res = await persistFundNav(prisma, {
        fundId: r.fundId,
        nav: r.nav,
        navDate: r.navDate,
        currency: r.currency,
        source: SITCA_FSC_NAV_SOURCE,
      });
      if (res.navMoved) {
        if (r.dbDate) updated++;
        else initialWrite++;
      } else {
        noChange++;
      }
    } catch (error) {
      failed++;
      failures.push({ fund: r.fundId, reason: String(error).slice(0, 200) });
    }
  }

  const reachedEnd = !timeBudgetStop && window.length < batch;
  const nextCursor = reachedEnd ? "" : lastId;
  const after: CheckpointRow = {
    lastSymbol: nextCursor,
    processed: (before?.processed ?? 0) + attempted,
    succeeded: (before?.succeeded ?? 0) + initialWrite + updated,
    failed: (before?.failed ?? 0) + failed,
    updatedAt: new Date().toISOString(),
  };
  await writeCheckpoint(`${JOB}:SITCA`, CHECKPOINT_KEY, runId, {
    lastSymbol: nextCursor,
    processed: after.processed,
    succeeded: after.succeeded,
    failed: after.failed,
  });

  const wrote = initialWrite + updated;
  const status = failed > 0 && wrote === 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, `${JOB}:SITCA`, "SITCA", startedMs, {
    status,
    attempted,
    completed: attempted - failed,
    inserted: 0,
    updated: wrote,
    failed,
    retryableFailures: failed,
    checkpointAfter: after,
    error: failures.length ? `${failures.length} failures; e.g. ${failures[0]?.reason}` : null,
    details: {
      checkpoint_before: before,
      batch_size: batch,
      wrapped,
      reached_end: reachedEnd,
      time_budget_stop: timeBudgetStop,
      window_size: window.length,
      sitca_records: records.length,
      matched_unique: universeCount,
      name_ambiguous: ambiguous,
      name_unmatched: unmatched,
      initial_write: initialWrite,
      updated,
      no_change: noChange,
      stale_skip: staleSkip,
      http_403: 0,
      http_429: 0,
      http_5xx: 0,
      sample_failures: failures.slice(0, 5),
    },
  });

  return Response.json({
    ok: true,
    job: JOB,
    provider: "SITCA",
    runId,
    httpStatus: 200,
    sitcaRecords: records.length,
    matchedUnique: universeCount,
    nameAmbiguous: ambiguous,
    nameUnmatched: unmatched,
    checked: attempted,
    initialWrite,
    updated,
    noChange,
    staleSkip,
    failed,
    checkpointBefore: before?.lastSymbol ?? null,
    checkpointAfter: nextCursor || "(wrapped to start)",
    wrapped,
    reachedEnd,
    universeCount,
    runtimeMs: Date.now() - startedMs,
    status,
  });
}
