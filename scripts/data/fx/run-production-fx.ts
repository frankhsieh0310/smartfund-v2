import { hostname } from "node:os";
import { PrismaClient } from "@prisma/client";
import {
  acquireLifecycleLock, completeLifecycleRun, createLifecycleRun, createSummary,
  failLifecycleRun, heartbeatLifecycleLock, loadLifecycleResumeCheckpoint,
  pauseLifecycleRun, persistLifecycleCheckpoint, recoverOrphanedLifecycleRun,
  releaseLifecycleLock,
} from "../production/run-lifecycle.ts";
import { hasFlag, loadFxConfig, option } from "./fx-config.ts";

type ChartResult = { timestamp?: number[]; indicators?: { quote?: Array<{ open?: Array<number | null>; high?: Array<number | null>; low?: Array<number | null>; close?: Array<number | null>; volume?: Array<number | null> }> } };
const prisma = new PrismaClient();
const interval = option("--interval", "1d");
const incremental = hasFlag("--incremental");
const maxPairs = Math.max(1, Math.min(100, Number(option("--max-pairs", "20")) || 20));
const jobId = `global-fx-${interval}-${incremental ? "incremental" : "historical"}`;
const runType = incremental ? "INCREMENTAL" : "HISTORICAL";
const owner = `${hostname()}:${process.pid}`;

function rangeFor(value: string): string {
  if (!incremental) return value === "1d" || value === "1wk" || value === "1mo" ? "max" : value === "1m" ? "7d" : "60d";
  return value === "1d" || value === "1wk" || value === "1mo" ? "10d" : "2d";
}

const derivedHours: Record<string, number> = { "2h": 2, "4h": 4, "6h": 6, "12h": 12 };
function providerInterval(value: string): string { return derivedHours[value] ? "60m" : value; }

async function fetchChart(providerSymbol: string) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}`);
  url.searchParams.set("interval", providerInterval(interval));
  url.searchParams.set("range", rangeFor(interval));
  url.searchParams.set("events", "history");
  const response = await fetch(url, { headers: { "user-agent": "SmartFund-FX/1.0" }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`YAHOO_HTTP_${response.status}`);
  const payload = await response.json() as { chart?: { result?: ChartResult[]; error?: unknown } };
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(`YAHOO_EMPTY:${JSON.stringify(payload.chart?.error ?? null)}`);
  return { result, sourceUrl: url.toString() };
}

async function writePair(pair: { symbol: string; providerSymbol: string | null }) {
  if (!pair.providerSymbol) throw new Error("NO_PROVIDER_MAPPING");
  const { result, sourceUrl } = await fetchChart(pair.providerSymbol);
  const quote = result.indicators?.quote?.[0];
  const sourceRows = (result.timestamp ?? []).flatMap((epoch, index) => {
    const open = quote?.open?.[index], high = quote?.high?.[index], low = quote?.low?.[index], close = quote?.close?.[index];
    if (open == null || high == null || low == null || close == null) return [];
    const openTime = new Date(epoch * 1000);
    const closeTime = new Date((result.timestamp?.[index + 1] ?? epoch + (providerInterval(interval) === "60m" ? 3_600 : 86_400)) * 1000);
    return [{ pairSymbol: pair.symbol, interval, openTime, closeTime, open, high, low, close, mid: close, volume: quote?.volume?.[index] ?? null, source: "YAHOO_CHART", sourceUrl }];
  });
  const rows = !derivedHours[interval] ? sourceRows : [...sourceRows.reduce((groups, row) => {
    const bucketSeconds = derivedHours[interval] * 3_600;
    const bucket = Math.floor(row.openTime.getTime() / 1000 / bucketSeconds) * bucketSeconds;
    const current = groups.get(bucket);
    if (!current) groups.set(bucket, { ...row, interval, openTime: new Date(bucket * 1000), closeTime: new Date((bucket + bucketSeconds) * 1000) });
    else groups.set(bucket, { ...current, high: Math.max(current.high, row.high), low: Math.min(current.low, row.low), close: row.close, mid: row.close, volume: current.volume == null && row.volume == null ? null : (current.volume ?? 0) + (row.volume ?? 0) });
    return groups;
  }, new Map<number, (typeof sourceRows)[number]>()).values()];
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += 500) inserted += (await prisma.fxCandle.createMany({ data: rows.slice(offset, offset + 500), skipDuplicates: true })).count;
  const last = rows.at(-1);
  if (last) await prisma.fxLatestQuote.upsert({ where: { pairSymbol: pair.symbol }, create: { pairSymbol: pair.symbol, mid: last.close, quotedAt: last.openTime, source: last.source }, update: { mid: last.close, quotedAt: last.openTime, source: last.source, ingestedAt: new Date() } });
  await prisma.fxCoverage.upsert({
    where: { pairSymbol_capability_interval: { pairSymbol: pair.symbol, capability: "HISTORICAL", interval } },
    create: { pairSymbol: pair.symbol, capability: "HISTORICAL", interval, status: rows.length ? "AVAILABLE" : "MISSING", provider: "YAHOO_CHART", earliestAt: rows[0]?.openTime, latestAt: last?.openTime, rowCount: rows.length, qualityStatus: rows.length ? "PASS" : "FAIL" },
    update: { status: rows.length ? "AVAILABLE" : "MISSING", provider: "YAHOO_CHART", earliestAt: rows[0]?.openTime, latestAt: last?.openTime, rowCount: rows.length, qualityStatus: rows.length ? "PASS" : "FAIL", checkedAt: new Date() },
  });
  return { inserted, latest: last?.openTime ?? null };
}

async function queueFailure(pairSymbol: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const dedupeKey = `${jobId}:${pairSymbol}`;
  await prisma.fxWorkItem.upsert({
    where: { dedupeKey },
    create: { dedupeKey, kind: runType, pairSymbol, payload: { pairSymbol, interval, incremental }, status: "PENDING", attempts: 1, lastError: message, nextRunAt: new Date(Date.now() + 300_000) },
    update: { status: "PENDING", attempts: { increment: 1 }, lastError: message, nextRunAt: new Date(Date.now() + 300_000), completedAt: null },
  });
}

async function main() {
  const config = await loadFxConfig();
  if (!config.intervals.includes(interval)) throw new Error(`UNSUPPORTED_INTERVAL:${interval}`);
  await recoverOrphanedLifecycleRun(prisma, jobId);
  if (!await acquireLifecycleLock(prisma, jobId, owner)) { console.log(JSON.stringify({ status: "SKIPPED_ACTIVE_WRITER", jobId })); return; }
  let runId: string | null = null;
  try {
    const pairs = await prisma.fxPair.findMany({ where: { active: true }, orderBy: { symbol: "asc" }, select: { symbol: true, providerSymbol: true } });
    const resume = hasFlag("--resume") ? await loadLifecycleResumeCheckpoint(prisma, jobId) : null;
    const start = resume?.last_symbol ? Math.max(0, pairs.findIndex((pair) => pair.symbol === resume.last_symbol) + 1) : 0;
    const selected = pairs.slice(start, start + maxPairs);
    const summary = createSummary();
    if (resume?.details) Object.assign(summary, resume.details);
    runId = await createLifecycleRun(prisma, jobId, "GLOBAL_FX", runType, { universeCount: pairs.length });
    let latest: Date | null = null;
    for (const pair of selected) {
      summary.attempted += 1;
      try {
        const result = await writePair(pair);
        summary.completed += 1; summary.success += 1; summary.inserted += result.inserted;
        if (result.inserted === 0) summary.noUpdate += 1;
        if (result.latest && (!latest || result.latest > latest)) latest = result.latest;
      } catch (error) {
        summary.failed += 1; summary.retryableFailure += 1;
        await queueFailure(pair.symbol, error);
      }
      await persistLifecycleCheckpoint(prisma, runId, summary, pair.symbol);
      await heartbeatLifecycleLock(prisma, jobId, owner);
    }
    if (start + selected.length < pairs.length) {
      await pauseLifecycleRun(prisma, runId);
      console.log(JSON.stringify({ status: "PAUSED_CHECKPOINTED", jobId, interval, processedThisSlice: selected.length, remaining: pairs.length - start - selected.length, ...summary }));
      return;
    }
    const validation = { status: summary.failed === 0 ? "PASS" : "FAIL", interval, universe: pairs.length, failureQueue: summary.failed };
    await completeLifecycleRun(prisma, runId, latest, validation);
    console.log(JSON.stringify({ status: validation.status === "PASS" ? "COMPLETE" : "COMPLETE_WITH_FAILURES", jobId, ...summary, validation }));
  } catch (error) {
    if (runId) await failLifecycleRun(prisma, runId, error);
    throw error;
  } finally {
    await releaseLifecycleLock(prisma, jobId, owner);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
