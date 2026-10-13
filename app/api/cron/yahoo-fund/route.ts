// Cloud Yahoo US mutual-fund ingestion — consolidated worker, phased. No Windows, no local files.
//   /api/cron/yahoo-fund?phase=discover -> screener MUTUALFUND by category -> stage candidate symbols
//   /api/cron/yahoo-fund?phase=ingest   -> per symbol: quoteSummary enrich + Tier-A master collapse
//                                          + fund_share_classes + fund_provider_mappings + fund_history
//                                          + master-level holdings   (all idempotent, source=YAHOO_US_MF_V1)
// Bounded (?batch), resumable (checkpoint yahoo-fund-<phase>), run-logged (production_scheduler_runs).
// Morningstar overall/risk/category/rank are FUND-ONLY and only written when Yahoo returns a value.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import {
  discoverUsFunds, enrichFundFromYahoo, ingestUsFundShareClass, DISCOVERY_CATEGORIES,
} from "@/lib/yahoo/fundIngest";
import { screenerPage, sleep, type RateStats } from "@/lib/yahoo/productSession";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<any[]>;
const TIME_BUDGET_MS = 250_000;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const phase = (url.searchParams.get("phase") ?? "ingest").toLowerCase();
  const batch = Math.min(120, Math.max(1, Number(url.searchParams.get("batch")) || 30));
  const perCategory = Math.min(200, Math.max(25, Number(url.searchParams.get("perCategory")) || 50));
  const pace = Math.min(4000, Math.max(200, Number(url.searchParams.get("pace")) || 1200));
  const started = Date.now();
  const JOB = `YAHOO_FUND_${phase.toUpperCase()}`;
  const cpKey = `yahoo-fund-${phase}`;
  const runKey = `${cpKey}:${new Date().toISOString().slice(0, 13)}`;
  const stats: RateStats = { calls: 0, rateLimited: 0, crumbRefresh: 0 };

  const cpBefore = await readCheckpoint(cpKey);
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO", runKey, universeCount: 0, batchSize: batch, checkpointBefore: cpBefore,
  });
  if (skipped) return Response.json({ ok: true, task: "yahoo-fund", phase, skipped: true });

  try {
    if (phase === "discover") {
      const univ = await screenerPage("MUTUALFUND", [{ operator: "GT", operands: ["fundnetassets", 0] }], 0, 1, "fundnetassets", stats);
      const usUniv = await screenerPage("MUTUALFUND", [{ operator: "GT", operands: ["fundnetassets", 0] }, { operator: "EQ", operands: ["region", "us"] }], 0, 1, "fundnetassets", stats);
      const disc = await discoverUsFunds({ perCategory, stats });
      // stage candidates in fund_provider_mappings? — only real fund rows can be mapped, so staging goes
      // to the run-log details only; the ingest phase does the writes.
      const existing = (await query(`SELECT count(*)::int n FROM funds WHERE data_provider = 'yahoo'`, []))[0]?.n ?? 0;
      const details = {
        yahoo_mf_discoverable: univ.total, yahoo_mf_us_region: usUniv.total,
        smartmatch_fund_existing: Number(existing),
        discovered_symbols: disc.symbols.length, per_category_totals: disc.perCategoryTotals,
        categories: DISCOVERY_CATEGORIES, sample: disc.symbols.slice(0, 40), stats,
      };
      // persist the discovered set on the checkpoint's last_symbol as a small cursor (first symbol) +
      // stash full list on the run-log details for the ingest phase to consume manually if needed.
      await writeCheckpoint(JOB, cpKey, runId, {
        lastSymbol: disc.symbols[0] ?? null, processed: disc.symbols.length, succeeded: disc.symbols.length, failed: 0,
      });
      await finishRun(runId, JOB, "YAHOO", started, {
        status: "COMPLETED", attempted: disc.symbols.length, completed: disc.symbols.length,
        inserted: 0, updated: 0, failed: 0, retryableFailures: 0, checkpointAfter: cpBefore,
        details: { ...details, discovered_all: disc.symbols },
      });
      return Response.json({ ok: true, task: "yahoo-fund", phase, ...details });
    }

    // ingest phase — symbols come from ?symbols=CSV, else re-discover a small slice
    const symParam = url.searchParams.get("symbols");
    let symbols: string[] = [];
    if (symParam) symbols = symParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, batch);
    else {
      const disc = await discoverUsFunds({ perCategory: batch, stats });
      symbols = disc.symbols.slice(0, batch);
    }

    const mastersHoldings = new Set<string>();
    let attempted = 0, ok = 0, failed = 0, scIns = 0, scUpd = 0, masterCreated = 0, masterLinked = 0;
    let navRows = 0, distRows = 0, holdRows = 0, msPop = 0, msRiskPop = 0, msCatPop = 0;
    for (const sym of symbols) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      attempted++;
      try {
        const rec = await enrichFundFromYahoo(sym);
        if (!rec) { failed++; continue; }
        const r = await ingestUsFundShareClass(query, rec, mastersHoldings);
        if (r.ok) {
          ok++;
          if (r.shareClassInserted) scIns++;
          if (r.shareClassUpdated) scUpd++;
          if (r.masterCreated) masterCreated++;
          if (r.masterLinked) masterLinked++;
          navRows += r.navRowsWritten; distRows += r.distributionRows; holdRows += r.holdingsWritten;
          if (r.morningstar.overall != null) msPop++;
          if (r.morningstar.risk != null) msRiskPop++;
          if (r.morningstar.category) msCatPop++;
        } else failed++;
      } catch { failed++; }
      await sleep(pace);
    }

    const cpAfter = {
      lastSymbol: null, processed: (cpBefore?.processed ?? 0) + attempted,
      succeeded: (cpBefore?.succeeded ?? 0) + ok, failed,
    };
    await writeCheckpoint(JOB, cpKey, runId, cpAfter);
    const details = {
      phase, attempted, succeeded: ok, failed,
      shareClassInserted: scIns, shareClassUpdated: scUpd, masterCreated, masterLinked,
      navRowsWritten: navRows, distributionRows: distRows, holdingsWritten: holdRows,
      morningstarPopulated: msPop, morningstarRiskPopulated: msRiskPop, morningstarCategoryPopulated: msCatPop,
      stats, runtime_ms: Date.now() - started,
    };
    await finishRun(runId, JOB, "YAHOO", started, {
      status: failed > 0 && ok === 0 ? "PARTIAL" : "COMPLETED",
      attempted, completed: ok, inserted: scIns + masterCreated, updated: scUpd, failed, retryableFailures: failed,
      checkpointAfter: { ...cpAfter, updatedAt: new Date().toISOString() }, details,
    });
    return Response.json({ ok: true, task: "yahoo-fund", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "YAHOO", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1,
      checkpointAfter: cpBefore, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "yahoo-fund", phase, error: (e as Error).message }, { status: 500 });
  }
}
