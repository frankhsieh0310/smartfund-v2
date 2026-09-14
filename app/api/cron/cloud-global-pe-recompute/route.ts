// Cloud global PE recompute — DB-side only, zero external fetch. Bounded, idempotent, checkpointed via
// production_scheduler_runs / production_scheduler_checkpoints.
//
// Why not just re-run scripts/data/financial/backfill-sec-historical-pe.ts on a schedule: that script
// re-derives split-normalized TTM EPS from scratch per stock (SEC companyfacts + submissions + full Yahoo
// split/price history) — correct, but expensive, and only ever run for 3 hardcoded tickers. Instead this
// job reuses the plain quarterly diluted/basic EPS SEC_EDGAR facts the general financial pipeline already
// writes for ~4,100 NASDAQ/NYSE stocks, canonicalizes them via lib/fundamentals/canonicalEps.ts (handles
// the missing-Q4 / pre-vs-post-split-duplicate problems — see that file's header for how), and recomputes
// PE = latest_close / canonical TTM diluted EPS (falling back to basic EPS only if diluted is unavailable).
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { resolveTtmEps, type RawFact, type SplitEvent } from "@/lib/fundamentals/canonicalEps";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_GLOBAL_PE_RECOMPUTE";
const PROVIDER = "SMARTFUND_PE_DAILY_RECOMPUTE_V1";
const CHECKPOINT_KEY = "cloud-global-pe-recompute:ROLLING";
const DEFAULT_BATCH = 400;
const MAX_BATCH = 800;
// Always refreshed every run regardless of cursor position — the "我的分析" acceptance-test set.
const PRIORITY_TICKERS = ["NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA"];

type FactRow = { stockId: string; periodStart: string; periodEnd: string; value: string; filingDate: string | null; metric: string };
type SplitRow = { stockId: string; effectiveDate: string; ratio: string };

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const url = new URL(request.url);
  const batch = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("batch") ?? DEFAULT_BATCH)));
  const today = new Date().toISOString().slice(0, 10);

  const universeCount = await prisma.stock.count({ where: { isActive: true, exchange: { in: ["NASDAQ", "NYSE"] } } });
  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = hourBucketKey("cloud-global-pe-recompute");
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount, batchSize: batch, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey });

  const cursor = before?.lastSymbol ?? "";
  let candidates = await prisma.stock.findMany({
    where: { isActive: true, exchange: { in: ["NASDAQ", "NYSE"] }, ticker: { gt: cursor } },
    orderBy: { ticker: "asc" },
    take: batch,
    select: { id: true, ticker: true, latestClose: true },
  });
  let wrapped = false;
  if (candidates.length === 0 && cursor !== "") {
    wrapped = true;
    candidates = await prisma.stock.findMany({ where: { isActive: true, exchange: { in: ["NASDAQ", "NYSE"] } }, orderBy: { ticker: "asc" }, take: batch, select: { id: true, ticker: true, latestClose: true } });
  }
  const priorityRows = await prisma.stock.findMany({ where: { isActive: true, exchange: { in: ["NASDAQ", "NYSE"] }, ticker: { in: PRIORITY_TICKERS } }, select: { id: true, ticker: true, latestClose: true } });
  const byId = new Map([...priorityRows, ...candidates].map((s) => [s.id, s]));
  const stocks = [...byId.values()];
  const stockIds = stocks.map((s) => s.id);

  const [epsFacts, splitFacts] = stockIds.length
    ? await Promise.all([
        prisma.$queryRawUnsafe<FactRow[]>(
          `SELECT stock_id AS "stockId", period_start::text AS "periodStart", period_end::text AS "periodEnd", value::text AS value, filing_date::text AS "filingDate", metric
             FROM stock_financial_facts
            WHERE metric IN ('diluted_eps','basic_eps') AND source='SEC_EDGAR' AND stock_id = ANY($1::text[])
              AND period_end >= (CURRENT_DATE - INTERVAL '3 years')`,
          stockIds,
        ),
        prisma.$queryRawUnsafe<SplitRow[]>(
          `SELECT stock_id AS "stockId", period_end::text AS "effectiveDate", value::text AS ratio
             FROM stock_financial_facts WHERE metric='yahoo.event.splitRatio' AND stock_id = ANY($1::text[])`,
          stockIds,
        ),
      ])
    : [[], []];

  const factsByStock = new Map<string, FactRow[]>();
  for (const f of epsFacts) (factsByStock.get(f.stockId) ?? factsByStock.set(f.stockId, []).get(f.stockId)!).push(f);
  const splitsByStock = new Map<string, SplitEvent[]>();
  for (const s of splitFacts) (splitsByStock.get(s.stockId) ?? splitsByStock.set(s.stockId, []).get(s.stockId)!).push({ effectiveDate: s.effectiveDate, ratio: Number(s.ratio) });

  let attempted = 0;
  let computed = 0;
  let insufficient = 0;
  let splitAdjustedCount = 0;
  let restatedCount = 0;
  const writes: Array<{ stockId: string; metric: string; periodEnd: Date; value: number; unit: string; currency: string; source: string; sourceFactKey: string }> = [];
  for (const stock of stocks) {
    attempted++;
    const close = stock.latestClose == null ? null : Number(stock.latestClose);
    if (close == null || close <= 0) { insufficient++; continue; }
    const allFacts = factsByStock.get(stock.id) ?? [];
    const splits = splitsByStock.get(stock.id) ?? [];
    const toRaw = (metric: string): RawFact[] => allFacts.filter((f) => f.metric === metric).map((f) => ({ periodStart: f.periodStart, periodEnd: f.periodEnd, value: Number(f.value), filingDate: f.filingDate }));
    let epsBasis: "diluted" | "basic" = "diluted";
    let result = resolveTtmEps(toRaw("diluted_eps"), splits);
    if (!result) { result = resolveTtmEps(toRaw("basic_eps"), splits); epsBasis = "basic"; }
    if (!result || !(result.ttm > 0)) { insufficient++; continue; }
    computed++;
    if (result.quarters.some((q) => q.adjustment === "SPLIT_ADJUSTED")) splitAdjustedCount++;
    if (result.quarters.some((q) => q.adjustment === "RESTATED")) restatedCount++;
    writes.push({
      stockId: stock.id, metric: "valuation.pe.ttm.point_in_time", periodEnd: new Date(`${today}T00:00:00.000Z`),
      value: close / result.ttm, unit: "RATIO", currency: "USD", source: PROVIDER,
      sourceFactKey: `${stock.id}:pe-recompute:${today}:${epsBasis}`,
    });
  }
  const insertedCount = writes.length ? (await prisma.stockFinancialFact.createMany({ data: writes, skipDuplicates: true })).count : 0;

  const reachedEnd = candidates.length < batch;
  const nextCursor = reachedEnd ? "" : (candidates.at(-1)?.ticker ?? "");
  const after = { lastSymbol: nextCursor, processed: (before?.processed ?? 0) + attempted, succeeded: (before?.succeeded ?? 0) + computed, failed: (before?.failed ?? 0) + insufficient, updatedAt: new Date().toISOString() };
  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: after.lastSymbol, processed: after.processed, succeeded: after.succeeded, failed: after.failed });

  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status: "COMPLETED", attempted, completed: computed, inserted: insertedCount, updated: 0, failed: insufficient,
    retryableFailures: 0, checkpointAfter: after, error: null,
    details: { batch_size: batch, wrapped, reached_end: reachedEnd, priority_tickers: PRIORITY_TICKERS, computed, insufficient_data: insufficient, split_adjusted_count: splitAdjustedCount, restated_count: restatedCount },
  });

  return Response.json({ ok: true, job: JOB, runId, universeCount, attempted, computed, insufficient, splitAdjustedCount, restatedCount, factsWritten: insertedCount, wrapped, reachedEnd, checkpointAfter: nextCursor || "(wrapped to start)", runtimeMs: Date.now() - startedMs });
}
