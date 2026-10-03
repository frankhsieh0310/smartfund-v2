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
// A full invocation never runs past this — well under Vercel's 300s maxDuration, leaving headroom for
// whatever ticker is in flight when the budget check fires (bounded by PER_ETF_TIMEOUT_MS below) plus
// the final checkpoint/response write.
const WORK_BUDGET_MS = 180_000;
// Before starting the NEXT ticker, if less than this much budget remains, stop cleanly (HTTP 200,
// reachedEnd left for the next invocation to determine) instead of risking Vercel killing the function
// mid-ticker. Must comfortably exceed PER_ETF_TOTAL_TIMEOUT_MS so a started ticker always has room to
// finish within WORK_BUDGET_MS.
const MIN_REMAINING_TO_START_MS = 50_000;
// fetch + the one bounded retry, combined, for a single ETF — no single ticker may consume the rest of
// the invocation's time budget.
const PER_ETF_TOTAL_TIMEOUT_MS = 45_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT_${ms}ms`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

// CTBC's adapter has no "today" fallback by design and exposes no listAvailableDates() — it always
// requires an explicit date, and its Buyback API is strict (a date with no official publication for
// it returns CTBC_NO_ENTRY, confirmed via a bounded live probe: 2026-09-22/23/24 all succeeded with
// dataDate exactly equal to the date requested; 2026-09-25 failed outright). So "today's real date" is
// resolved by probing backward from the current Taipei calendar date until CTBC's own API confirms one
// with a real snapshot — never by computing or guessing a date locally. Bounded to at most 7 calendar
// days back (covers a normal weekend/holiday gap), so this never becomes an unbounded retry loop.
async function resolveCtbcLatestDate(): Promise<string> {
  const anchorTicker = "00406A";
  const taipeiToday = new Date(Date.now() + 8 * 60 * 60 * 1000);
  for (let back = 0; back <= 7; back++) {
    const d = new Date(taipeiToday);
    d.setUTCDate(d.getUTCDate() - back);
    const candidate = d.toISOString().slice(0, 10);
    try {
      const snap = await CtbcOfficialPcfAdapter.fetchSnapshot(anchorTicker, candidate);
      if (snap.dataDate) return snap.dataDate;
    } catch {
      // no official publication for this candidate date — try the previous day
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

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const query: QueryFn = async (sql, params) => prisma.$queryRawUnsafe(sql, ...params);

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
  const storedCheckpoint = await readCheckpoint(checkpointKey);
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
  });
  if (skipped) {
    return Response.json({
      ok: true, job: JOB, issuer, skipped: true, reason: "run_key already present (double trigger)", runKey,
    });
  }

  let ctbcDate: string | null = null;
  if (issuer === "CTBC") {
    try {
      ctbcDate = await resolveCtbcLatestDate();
    } catch {
      /* every CTBC ticker this run will fail individually and be reported */
    }
  }

  let processed = 0;
  let passed = 0;
  let failedCount = 0;
  let timeBudgetStop = false;
  const failedTickers: Array<{ ticker: string; error: string }> = [];
  let lastProcessedTicker: string | null = effectiveCheckpoint?.lastSymbol ?? null;
  let index = Math.max(startIndex, 0);

  for (; index < tickers.length; index++) {
    if (Date.now() - startedMs > WORK_BUDGET_MS - MIN_REMAINING_TO_START_MS) { timeBudgetStop = true; break; }
    const ticker = tickers[index];
    processed++;
    lastProcessedTicker = ticker;

    const attempt = (): Promise<CanonicalSnapshot> =>
      issuer === "CTBC" ? adapter.fetchSnapshot(ticker, ctbcDate ?? undefined) : adapter.fetchSnapshot(ticker);

    try {
      let snap: CanonicalSnapshot;
      try {
        snap = await withTimeout(attempt(), PER_ETF_TOTAL_TIMEOUT_MS, ticker);
      } catch {
        await new Promise((r) => setTimeout(r, 1500)); // one bounded retry, transient network only
        snap = await withTimeout(attempt(), PER_ETF_TOTAL_TIMEOUT_MS, ticker);
      }
      if (!snap.positions.length) throw new Error("empty positions");
      const { snapshotId } = await upsertSnapshot(query, snap);
      passed++;
      // Bridge to the table the app actually reads, immediately — not deferred until this issuer (or
      // all 17) finishes. Isolated: a sync failure never undoes the official snapshot write above.
      try {
        await syncOfficialSnapshotToHoldings(query, snap.etfCode, { snapshotId });
      } catch {
        /* official snapshot is safely stored either way; this ETF's app-facing holdings just stay
           on whatever date they were last synced to, until the next successful run retries it */
      }
    } catch (e) {
      failedCount++;
      const message = e instanceof Error ? e.message : String(e);
      failedTickers.push({ ticker, error: message.slice(0, 300) });
      // Source failure (502/403/browser timeout/parse failure) for this one ticker — the existing
      // holdings row for it is never cleared, no empty data is ever written over it, and the loop
      // simply moves to the next ticker.
    }

    // Checkpoint after EVERY ticker — "completed" means attempted (success OR a recorded source
    // failure), never just success. If Vercel kills this invocation or the work budget runs out mid-
    // run, whatever was already attempted stays saved and the next invocation resumes right after it.
    await writeCheckpoint(`${JOB}:${issuer}`, checkpointKey, runId, {
      lastSymbol: lastProcessedTicker,
      processed: (isFromToday ? effectiveCheckpoint?.processed ?? 0 : 0) + processed,
      succeeded: (isFromToday ? effectiveCheckpoint?.succeeded ?? 0 : 0) + passed,
      failed: (isFromToday ? effectiveCheckpoint?.failed ?? 0 : 0) + failedCount,
    });
  }

  // reachedEnd means every one of this issuer's own tickers has now been attempted at least once
  // today (success or recorded source failure) — not that they all succeeded. A few source failures
  // never block the rest of this issuer's list, and never prevent reachedEnd from becoming true.
  const reachedEnd = !timeBudgetStop && index >= tickers.length;
  if (reachedEnd) {
    // Clear the cursor so tomorrow's first invocation for this issuer starts from ticker 0 again.
    await writeCheckpoint(`${JOB}:${issuer}`, checkpointKey, runId, {
      lastSymbol: null,
      processed: (isFromToday ? effectiveCheckpoint?.processed ?? 0 : 0) + processed,
      succeeded: (isFromToday ? effectiveCheckpoint?.succeeded ?? 0 : 0) + passed,
      failed: (isFromToday ? effectiveCheckpoint?.failed ?? 0 : 0) + failedCount,
    });
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
    details: { issuer, startIndex: Math.max(startIndex, 0), attempted: processed, reachedEnd, timeBudgetStop },
  });

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
