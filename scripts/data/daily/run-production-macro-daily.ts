import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { productionProviderRegistry } from "../../../lib/data-platform/providers/ProviderRegistry.ts";
import {
  acquireLifecycleLock, completeLifecycleRun, createLifecycleRun, createSummary, failLifecycleRun,
  heartbeatLifecycleLock, loadLifecycleResumeCheckpoint, persistLifecycleCheckpoint, releaseLifecycleLock,
} from "../production/run-lifecycle.ts";

type Series = { id: string; provider: string; seriesId: string; latestDate: Date | null };
const prisma = new PrismaClient();
const JOB_ID = "macro-production-daily";
const CONCURRENCY = 4;
const CHECKPOINT_EVERY = 25;

async function configuredProviders(): Promise<string[]> {
  const config = JSON.parse(await readFile(join(process.cwd(), "config", "asset-provider-registry.json"), "utf8")) as { assets: { MACRO?: { providerAdapters?: string[] } } };
  return config.assets.MACRO?.providerAdapters ?? [];
}

function noNewData(error: unknown): boolean {
  return /(?:FRED|ECB)_NO_DATA/.test(error instanceof Error ? error.message : String(error));
}

function newYorkDay(value = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function completedToday(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ started_at: Date }[]>("SELECT started_at FROM production_scheduler_runs WHERE job_id = $1 AND run_type = 'PRIMARY' AND status = 'COMPLETED' ORDER BY started_at DESC LIMIT 1", JOB_ID);
  return Boolean(rows[0] && newYorkDay(rows[0].started_at) === newYorkDay());
}

async function failure(series: Series, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.$executeRawUnsafe("INSERT INTO production_scheduler_failures (job_id, stock_id, symbol, attempts, last_error, error_type, last_attempted_at, next_retry_at, classification, resolved, resolution_reason) VALUES ($1, $2, $3, 1, $4, 'MACRO_PROVIDER_ERROR', NOW(), NOW() + INTERVAL '15 minutes', 'RETRYABLE_FAILURE', FALSE, NULL) ON CONFLICT (job_id, stock_id) DO UPDATE SET attempts = production_scheduler_failures.attempts + 1, last_error = EXCLUDED.last_error, last_attempted_at = NOW(), next_retry_at = EXCLUDED.next_retry_at, resolved = FALSE", JOB_ID, series.id, `${series.provider}:${series.seriesId}`, message);
}

async function main(): Promise<void> {
  if (await completedToday()) { console.log(JSON.stringify({ jobId: JOB_ID, status: "SKIPPED_COMPLETED" })); return; }
  const owner = `macro-daily:${process.env.RAILWAY_DEPLOYMENT_ID ?? process.pid}`;
  if (!await acquireLifecycleLock(prisma, JOB_ID, owner)) { console.log(JSON.stringify({ jobId: JOB_ID, status: "SKIPPED_LOCKED" })); return; }
  let runId = "";
  try {
    const adapterIds = new Set(await configuredProviders());
    const all = await prisma.$queryRawUnsafe<Series[]>("SELECT s.id, s.provider, s.series_id AS \"seriesId\", MAX(v.date) AS \"latestDate\" FROM economic_series s LEFT JOIN economic_values v ON v.series_id = s.id WHERE s.enabled = TRUE GROUP BY s.id, s.provider, s.series_id ORDER BY s.provider, s.series_id");
    const available = all.filter((series) => adapterIds.has(series.provider) && (() => { try { productionProviderRegistry.get(series.provider); return true; } catch { return false; } })());
    const pending = all.filter((series) => !available.includes(series));
    runId = await createLifecycleRun(prisma, JOB_ID, "MACRO", "PRIMARY");
    const summary = createSummary();
    const resume = await loadLifecycleResumeCheckpoint(prisma, JOB_ID);
    const resumeIndex = resume?.last_symbol ? available.findIndex((series) => `${series.provider}:${series.seriesId}` === resume.last_symbol) : -1;
    if (resume?.last_symbol && resumeIndex < 0) throw new Error(`RESUME_SYMBOL_NOT_IN_UNIVERSE:${resume.last_symbol}`);
    if (resume) Object.assign(summary, resume.details ?? { attempted: resume.processed, completed: resume.succeeded, failed: resume.failed });
    const selected = resume ? available.slice(resumeIndex + 1) : available;
    for (let offset = 0; offset < selected.length; offset += CONCURRENCY) {
      const batch = selected.slice(offset, offset + CONCURRENCY);
      const outcomes = await Promise.all(batch.map(async (series) => {
        try {
          const adapter = productionProviderRegistry.get(series.provider);
          const points = await adapter.fetchLatest({ assetClass: "MACRO", instrument: { id: series.id, symbol: series.seriesId, latestDate: series.latestDate } });
          let inserted = 0; let updated = 0;
          for (const point of points.filter((point) => point.value !== null && point.value !== undefined)) {
            const existing = await prisma.economicValue.findUnique({ where: { seriesId_date: { seriesId: series.id, date: point.date } }, select: { id: true } });
            await prisma.economicValue.upsert({ where: { seriesId_date: { seriesId: series.id, date: point.date } }, create: { seriesId: series.id, date: point.date, value: point.value!, sourceUrl: adapter.source().provider, sourceVersion: adapter.source().method, importedAt: new Date() }, update: { value: point.value!, sourceUrl: adapter.source().provider, sourceVersion: adapter.source().method, importedAt: new Date() } });
            if (existing) updated++; else inserted++;
          }
          await prisma.$executeRawUnsafe("DELETE FROM production_scheduler_failures WHERE job_id = $1 AND stock_id = $2", JOB_ID, series.id);
          return { attempted: 1, completed: 1, inserted, updated, success: inserted + updated ? 1 : 0, noUpdate: inserted + updated ? 0 : 1 };
        } catch (error) {
          if (noNewData(error)) return { attempted: 1, completed: 1, noUpdate: 1 };
          await failure(series, error); return { attempted: 1, failed: 1, retryableFailure: 1 };
        }
      }));
      outcomes.forEach((outcome) => Object.entries(outcome).forEach(([key, value]) => { (summary as Record<string, number>)[key] = ((summary as Record<string, number>)[key] ?? 0) + (value ?? 0); }));
      if (summary.attempted % CHECKPOINT_EVERY === 0 || offset + batch.length === selected.length) { await persistLifecycleCheckpoint(prisma, runId, summary, `${batch.at(-1)!.provider}:${batch.at(-1)!.seriesId}`); await heartbeatLifecycleLock(prisma, JOB_ID, owner); }
    }
    const validation = { status: summary.attempted === available.length && summary.attempted === summary.completed + summary.failed ? "PASS" : "FAIL", universe: all.length, adapterUniverse: available.length, providerPending: pending.map((series) => ({ provider: series.provider, seriesId: series.seriesId })), source: "OFFICIAL_PROVIDER_ADAPTERS", summaryType: "DAILY_SUMMARY" };
    await completeLifecycleRun(prisma, runId, summary, null, validation);
    console.log(JSON.stringify({ jobId: JOB_ID, status: validation.status, ...summary, providerPending: pending.length }, null, 2));
  } catch (error) { if (runId) await failLifecycleRun(prisma, runId, error); throw error; }
  finally { await releaseLifecycleLock(prisma, JOB_ID, owner); }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
