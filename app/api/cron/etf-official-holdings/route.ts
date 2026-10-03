// Function 2: Taiwan ETF Official Daily Holdings — daily ingestion, bounded-batch + checkpoint.
//
// A full 331-portfolio pass does not fit inside Vercel's 300s maxDuration (confirmed from this
// session's own measured per-issuer timings — no Puppeteer/plain-HTTP mix comes close to finishing
// 331 sequential real requests in under 300s). So one invocation processes at most BATCH_SIZE
// canonical portfolios and returns; the GitHub Actions workflow (still triggered once/day at 19:30
// Asia/Taipei) calls this route repeatedly, up to MAX_INVOCATIONS times, until reachedEnd=true.
//
// Checkpoint storage is 100% reused, no schema change: production_scheduler_checkpoints /
// production_scheduler_runs via lib/cloud-ingestion/runContext.ts, exactly like
// app/api/cron/cloud-global-etf-holdings/route.ts already does for a different universe.
//
// Daily reset: the checkpoint's own updated_at is compared against "today" in Asia/Taipei. If the
// stored checkpoint is from a previous calendar day (whether or not it reached the end), today's
// first invocation ignores it and starts again from the first batch — a completed previous day never
// suppresses today's run.
//
// Never uses the scheduler's own run time as a holdings date — each snapshot's `dataDate` always comes
// from that issuer's own official response (see lib/etf-holdings-engine/types.ts CanonicalSnapshot).
//
// Trigger: GitHub Actions schedule -> GET with `Authorization: Bearer <CRON_SECRET>`.
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
const CHECKPOINT_KEY = "etf-official-holdings";
// Lowered from 40 after two real production timeouts (one single-ticker canary cold-start, one full
// batch-of-40 run) both hit Vercel's 300s maxDuration. 10 keeps a 300s budget comfortable even for an
// all-Puppeteer batch (JPMorgan/AB-style cold Chromium launches included).
const BATCH_SIZE = 10;
const TIME_BUDGET_MS = 270_000; // headroom under maxDuration=300s, in case a batch runs unusually slow
// No single ETF may consume the whole function's time budget — a hung browser/page on one ticker must
// not starve every other ticker still queued in this invocation.
const PER_ETF_TIMEOUT_MS = 45_000;

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

type FlatTarget = { issuer: string; ticker: string; adapter: OfficialPcfAdapter };

function buildFlatUniverse(): FlatTarget[] {
  const universe = loadUniverse();
  const CATHAY_CANONICAL = universe["國泰"].filter((t) => !t.endsWith("K"));
  const CAPITAL_ACTIVE = universe["群益"].filter((t) => t !== "00643K");
  const SINOPAC_ACTIVE = universe["永豐"].filter((t) => t !== "00838B");
  const targets: { issuer: string; adapter: OfficialPcfAdapter; tickers: string[] }[] = [
    { issuer: "Cathay", adapter: CathayOfficialPcfAdapter, tickers: CATHAY_CANONICAL },
    { issuer: "JPMorgan", adapter: JpmorganOfficialPcfAdapter, tickers: universe["摩根"] },
    { issuer: "Allianz", adapter: AllianzOfficialPcfAdapter, tickers: universe["安聯"] },
    { issuer: "UPAMC", adapter: UpamcOfficialPcfAdapter, tickers: universe["統一"] },
    { issuer: "AB", adapter: AbOfficialPcfAdapter, tickers: universe["聯博"] },
    { issuer: "Fubon", adapter: FubonOfficialPcfAdapter, tickers: universe["富邦"] },
    { issuer: "CTBC", adapter: CtbcOfficialPcfAdapter, tickers: universe["中信"] },
    { issuer: "KGI", adapter: KgiOfficialPcfAdapter, tickers: universe["凱基"] },
    { issuer: "First", adapter: FirstOfficialPcfAdapter, tickers: universe["第一金"] },
    { issuer: "FHT", adapter: FhtOfficialPcfAdapter, tickers: universe["復華"] },
    { issuer: "SinoPac", adapter: SinoPacOfficialPcfAdapter, tickers: SINOPAC_ACTIVE },
    { issuer: "Yuanta", adapter: YuantaOfficialPcfAdapter, tickers: universe["元大"] },
    { issuer: "Capital", adapter: CapitalOfficialPcfAdapter, tickers: CAPITAL_ACTIVE },
    { issuer: "Mega", adapter: MegaOfficialPcfAdapter, tickers: universe["兆豐"] },
    { issuer: "Taishin", adapter: TaishinOfficialPcfAdapter, tickers: universe["台新"] },
    { issuer: "Nomura", adapter: NomuraOfficialPcfAdapter, tickers: universe["野村"] },
    { issuer: "BlackRock", adapter: BlackRockOfficialPcfAdapter, tickers: universe["貝萊德"] },
  ];
  return targets.flatMap((t) => t.tickers.map((ticker) => ({ issuer: t.issuer, ticker, adapter: t.adapter })));
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

  const flat = buildFlatUniverse();

  // Daily reset: a checkpoint left over from a previous Taipei calendar day (finished or not) never
  // suppresses today's run — today always starts from the first batch.
  const storedCheckpoint = await readCheckpoint(CHECKPOINT_KEY);
  const isFromToday = taipeiDateKey(storedCheckpoint?.updatedAt ?? null) === todayTaipeiKey();
  const effectiveCheckpoint: CheckpointRow | null = isFromToday ? storedCheckpoint : null;

  const startIndex = effectiveCheckpoint?.lastSymbol
    ? flat.findIndex((t) => t.ticker === effectiveCheckpoint.lastSymbol) + 1
    : 0;
  const batch = flat.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + BATCH_SIZE);
  const reachedEnd = Math.max(startIndex, 0) + batch.length >= flat.length;

  const runKey = `${JOB}:${todayTaipeiKey()}:batch-starting-at-${Math.max(startIndex, 0)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB,
    provider: "ALL",
    runKey,
    universeCount: flat.length,
    batchSize: BATCH_SIZE,
    checkpointBefore: effectiveCheckpoint,
  });
  if (skipped) {
    return Response.json({
      ok: true, job: JOB, skipped: true, reason: "run_key already present (double trigger)", runKey,
    });
  }

  let ctbcDate: string | null = null;
  if (batch.some((t) => t.issuer === "CTBC")) {
    try {
      ctbcDate = await resolveCtbcLatestDate();
    } catch {
      /* every CTBC ticker in this batch will fail individually and be reported; other issuers unaffected */
    }
  }

  let processed = 0;
  let passed = 0;
  let failedCount = 0;
  let timeBudgetStop = false;
  const failedTickers: Array<{ issuer: string; ticker: string; error: string }> = [];
  let lastProcessedTicker: string | null = effectiveCheckpoint?.lastSymbol ?? null;

  for (const target of batch) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    processed++;
    lastProcessedTicker = target.ticker;

    const attempt = (): Promise<CanonicalSnapshot> =>
      target.issuer === "CTBC"
        ? target.adapter.fetchSnapshot(target.ticker, ctbcDate ?? undefined)
        : target.adapter.fetchSnapshot(target.ticker);

    try {
      let snap: CanonicalSnapshot;
      try {
        snap = await withTimeout(attempt(), PER_ETF_TIMEOUT_MS, target.ticker);
      } catch {
        await new Promise((r) => setTimeout(r, 1500)); // one bounded retry, transient network only
        snap = await withTimeout(attempt(), PER_ETF_TIMEOUT_MS, target.ticker);
      }
      if (!snap.positions.length) throw new Error("empty positions");
      const { snapshotId } = await upsertSnapshot(query, snap);
      passed++;
      // Bridge to the table the app actually reads. Isolated: a sync failure never undoes the
      // official snapshot write above, and never blocks the rest of this batch.
      try {
        await syncOfficialSnapshotToHoldings(query, snap.etfCode, { snapshotId });
      } catch {
        /* official snapshot is safely stored either way; this ETF's app-facing holdings just stay
           on whatever date they were last synced to, until the next successful run retries it */
      }
    } catch (e) {
      failedCount++;
      const message = e instanceof Error ? e.message : String(e);
      failedTickers.push({ issuer: target.issuer, ticker: target.ticker, error: message.slice(0, 300) });
      // per-ticker failure is isolated — never blocks the rest of this batch, and never blocks the
      // checkpoint from advancing past this ticker on the next invocation
    }

    // Checkpoint after EVERY ticker, not once at the end of the batch — if Vercel kills this
    // invocation mid-batch (the exact FUNCTION_INVOCATION_TIMEOUT seen in production), whatever was
    // already attempted stays saved and the next invocation resumes right after it, never re-doing
    // (or silently skipping) work that already happened.
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
      lastSymbol: lastProcessedTicker,
      processed: (isFromToday ? effectiveCheckpoint?.processed ?? 0 : 0) + processed,
      succeeded: (isFromToday ? effectiveCheckpoint?.succeeded ?? 0 : 0) + passed,
      failed: (isFromToday ? effectiveCheckpoint?.failed ?? 0 : 0) + failedCount,
    });
  }

  // If the time budget was hit mid-batch, the checkpoint must resume AT this ticker next time, not
  // skip past it — so it doesn't advance past a never-attempted item. reachedEnd clears the cursor
  // entirely (next invocation starts a fresh daily pass); every other case already has the correct
  // cursor saved from the in-loop checkpoint write above.
  const actuallyReachedEnd = timeBudgetStop ? false : reachedEnd;
  if (actuallyReachedEnd) {
    await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
      lastSymbol: null,
      processed: (isFromToday ? effectiveCheckpoint?.processed ?? 0 : 0) + processed,
      succeeded: (isFromToday ? effectiveCheckpoint?.succeeded ?? 0 : 0) + passed,
      failed: (isFromToday ? effectiveCheckpoint?.failed ?? 0 : 0) + failedCount,
    });
  }
  const nextCursor = actuallyReachedEnd ? null : lastProcessedTicker;

  // A batch that attempted tickers but succeeded at none is a total failure, not a completed run —
  // reachedEnd alone (what the workflow step currently gates on) must never read as "it worked".
  const totalFailure = processed > 0 && passed === 0;

  await finishRun(runId, JOB, "ALL", startedMs, {
    status: totalFailure ? "FAILED" : timeBudgetStop ? "PARTIAL" : failedCount > 0 ? "PARTIAL" : "COMPLETED",
    attempted: processed,
    completed: passed,
    inserted: passed,
    updated: 0,
    failed: failedCount,
    retryableFailures: 0,
    checkpointAfter: { lastSymbol: nextCursor, processed, succeeded: passed, failed: failedCount, updatedAt: null },
    error: failedTickers.length ? `${failedTickers.length} failures; e.g. ${failedTickers[0]?.error}` : null,
    details: { batchStartIndex: Math.max(startIndex, 0), batchSize: batch.length, reachedEnd: actuallyReachedEnd, timeBudgetStop },
  });

  return Response.json({
    ok: !totalFailure,
    job: JOB,
    processed,
    passed,
    failed: failedCount,
    failedTickers,
    reachedEnd: actuallyReachedEnd,
    batchStartIndex: Math.max(startIndex, 0),
    universeCount: flat.length,
    ctbcDate,
    runtimeMs: Date.now() - startedMs,
  }, { status: totalFailure ? 500 : 200 });
}
