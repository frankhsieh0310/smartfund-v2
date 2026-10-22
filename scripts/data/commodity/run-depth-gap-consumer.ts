import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type Gap = {
  gap_id: string;
  priority: string;
  domain: string;
  worker: string;
  work_type: string;
  state: string;
  checkpoint: unknown;
  attempts: number;
  started_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  last_error?: string | null;
};
type Queue = { asset: string; items: Gap[]; generatedAt?: string; [key: string]: unknown };

const root = process.cwd();
const runtime = path.join(root, "runtime", "commodity", "depth-gap-consumer");
const queuePath = path.join(root, "runtime", "commodity", "depth-gap-work-queue.json");
const statusPath = path.join(root, "runtime-status", "commodity.json");
const manifestPath = path.join(root, "runtime", "commodity", "commodity-gap-manifest.json");
const lockPath = path.join(runtime, "single-writer.lock");
const checkpointPath = path.join(runtime, "checkpoint.json");
const heartbeatPath = path.join(runtime, "heartbeat.json");
const once = process.argv.includes("--once");
const batchLimit = 1;
const pollMs = 15 * 60_000;
const activeBatchDelayMs = 5_000;
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")); }
async function atomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

const eligible = new Set([
  "COMMODITY-GAP-005", "COMMODITY-GAP-008", "COMMODITY-GAP-014", "COMMODITY-GAP-024",
  "COMMODITY-GAP-029", "COMMODITY-GAP-030", "COMMODITY-GAP-031", "COMMODITY-GAP-032",
  "COMMODITY-GAP-033", "COMMODITY-GAP-036", "COMMODITY-GAP-037", "COMMODITY-GAP-038",
  "COMMODITY-GAP-039", "COMMODITY-GAP-040", "COMMODITY-GAP-041",
]);
const terminalDisposition: Record<string, { state: string; blocker: string }> = {
  "COMMODITY-GAP-014": { state: "AUTH_REQUIRED", blocker: "USDA_NASS_HISTORICAL_API_CREDENTIAL_REQUIRED" },
  "COMMODITY-GAP-024": { state: "SOURCE_LIMITED", blocker: "ONE_OF_ELEVEN_MARKETS_HAS_VERIFIED_CANONICAL_ANALYTICS" },
  "COMMODITY-GAP-031": { state: "SOURCE_LIMITED", blocker: "NO_SEMANTICALLY_COMPATIBLE_INVENTORY_CONSUMPTION_PAIR" },
  "COMMODITY-GAP-037": { state: "SOURCE_LIMITED", blocker: "PUBLICATION_EVENTS_READY_EXPECTATION_SEMANTICS_NOT_SOURCE_REPORTED" },
  "COMMODITY-GAP-038": { state: "IDENTITY_PENDING", blocker: "EXACT_CROSS_ASSET_MAPPING_INCOMPLETE" },
  "COMMODITY-GAP-039": { state: "NOT_APPLICABLE", blocker: "NO_OFFICIAL_PUBLIC_COMMODITY_ATTENTION_SOURCE_CONTRACT" },
  "COMMODITY-GAP-040": { state: "SOURCE_LIMITED", blocker: "AGRICULTURE_HISTORICAL_REPORT_VINTAGES_UNAVAILABLE_IN_STABLE_STRUCTURED_ROUTE" },
};

async function verify(prisma: PrismaClient, gap: Gap) {
  if (gap.gap_id === "COMMODITY-GAP-005") {
    const rows = await prisma.$queryRawUnsafe<Array<{ series_count: number; analytic_count: number }>>(
      `SELECT count(DISTINCT series_id)::int series_count,count(*)::int analytic_count FROM energy_physical_analytics`,
    );
    const evidence = rows[0] ?? { series_count: 0, analytic_count: 0 };
    if (evidence.series_count < 1 || evidence.analytic_count < 1) throw new Error("ENERGY_ANALYTICS_READBACK_EMPTY");
    return { verification: "PASS", canonicalTable: "energy_physical_analytics", ...evidence };
  }
  if (gap.gap_id === "COMMODITY-GAP-008") {
    const artifact = await json<{ analytics?: Array<{ status?: string }> }>(path.join(root, "runtime", "commodity-inventory", "analytics.json"));
    const ready = artifact.analytics?.filter((item) => item.status === "READY").length ?? 0;
    if (ready < 1) throw new Error("INVENTORY_ANALYTICS_READBACK_EMPTY");
    return { verification: "PASS", canonicalArtifact: "runtime/commodity-inventory/analytics.json", readyAnalytics: ready };
  }
  if (gap.gap_id === "COMMODITY-GAP-029") {
    const artifact = await json<{ canonicalPrograms?: number; canonicalInstruments?: number; euAuctionHistory?: { observations?: number }; duplicateAuctionIds?: number }>(path.join(root, "runtime", "carbon-markets", "completion-manifest.json"));
    if (!artifact.canonicalPrograms || !artifact.canonicalInstruments || !artifact.euAuctionHistory?.observations || artifact.duplicateAuctionIds !== 0) throw new Error("CARBON_CANONICAL_READBACK_FAILED");
    return { verification: "PASS", canonicalArtifact: "runtime/carbon-markets/completion-manifest.json", programs: artifact.canonicalPrograms, instruments: artifact.canonicalInstruments, auctionRows: artifact.euAuctionHistory.observations };
  }
  if (gap.gap_id === "COMMODITY-GAP-032" || gap.gap_id === "COMMODITY-GAP-033") {
    const artifact = await json<{ analytics?: Array<{ status?: string; range52w?: unknown; sampleCount?: number }> }>(path.join(root, "runtime", "commodity-inventory", "analytics.json"));
    const seasonal = artifact.analytics?.filter((item) => item.status === "READY" && item.range52w && Number(item.sampleCount ?? 0) >= 52).length ?? 0;
    if (seasonal < 1) throw new Error("SEASONAL_RANGE_READBACK_EMPTY");
    return { verification: "PASS", canonicalArtifact: "runtime/commodity-inventory/analytics.json", seasonalSeries: seasonal };
  }
  if (gap.gap_id === "COMMODITY-GAP-036") {
    const artifact = await json<{ series?: Array<{ analytics?: { risk?: { volatility90D?: number | null; maxDrawdown1Y?: number | null } } }> }>(path.join(root, "runtime", "commodity", "professional-depth", "price-series.json"));
    const ready = artifact.series?.filter((item) => Number.isFinite(item.analytics?.risk?.volatility90D) && Number.isFinite(item.analytics?.risk?.maxDrawdown1Y)).length ?? 0;
    if (ready < 1) throw new Error("COMMODITY_TECHNICAL_RISK_READBACK_EMPTY");
    return { verification: "PASS", canonicalArtifact: "runtime/commodity/professional-depth/price-series.json", readySeries: ready };
  }
  if (gap.gap_id === "COMMODITY-GAP-041") {
    const registry = await json<{ sources?: unknown[] }>(path.join(root, "config", "commodity-official-source-registry.json"));
    const coverage = await json<{ metrics?: Array<{ provenance_state?: string; freshness_state?: string }> }>(path.join(root, "runtime", "commodity-inventory", "coverage-matrix.json"));
    const evidenced = coverage.metrics?.filter((item) => item.provenance_state && item.freshness_state).length ?? 0;
    if (!(registry.sources?.length) || !evidenced) throw new Error("DATA_TRUST_READBACK_FAILED");
    return { verification: "PASS", registrySources: registry.sources.length, freshnessAndProvenanceSeries: evidenced };
  }
  const rows = await prisma.$queryRawUnsafe<Array<{ observations: number; net_import_rows: number }>>(
    `SELECT count(*)::int observations,count(*) FILTER (WHERE analytic_code='NET_IMPORTS')::int net_import_rows FROM energy_physical_analytics`,
  );
  const evidence = rows[0] ?? { observations: 0, net_import_rows: 0 };
  if (evidence.net_import_rows < 1) throw new Error("ENERGY_BALANCE_NET_IMPORTS_READBACK_EMPTY");
  return { verification: "PASS", canonicalTable: "energy_physical_analytics", ...evidence };
}

async function publish(queue: Queue, current: Gap | null, event: string) {
  const completed = queue.items.filter((item) => item.state === "COMPLETE").length;
  const checkpoint = {
    owner: "COMMODITY_DEPTH_GAP_CHILD",
    pid: process.pid,
    state: current ? current.state : "HEALTHY_WAITING",
    last_claimed_gap: current?.gap_id ?? null,
    completed_gap_ids: queue.items.filter((item) => item.state === "COMPLETE").map((item) => item.gap_id),
    retry_gap_ids: queue.items.filter((item) => item.state === "RETRY_WAIT").map((item) => item.gap_id),
    terminal_gap_ids: queue.items.filter((item) => ["BLOCKED", "DEPENDENCY_BLOCKED", "AUTH_REQUIRED", "SOURCE_LIMITED", "SOURCE_TERMS_BLOCKED", "LICENSE_CONSTRAINED", "IDENTITY_PENDING", "NOT_APPLICABLE"].includes(item.state)).map((item) => item.gap_id),
    lastEvent: event,
    updatedAt: now(),
    nextRunAt: new Date(Date.now() + pollMs).toISOString(),
  };
  await atomic(checkpointPath, checkpoint);
  await atomic(heartbeatPath, { ...checkpoint, heartbeatAt: checkpoint.updatedAt, pending: queue.items.filter((item) => item.state === "PENDING").length });
  const manifest = await json<{ gaps?: Array<{ gap_id: string; status: string }> }>(manifestPath).catch(() => null);
  if (manifest?.gaps) {
    for (const item of queue.items) {
      const target = manifest.gaps.find((gap) => gap.gap_id === item.gap_id);
      if (target && ["COMPLETE", "BLOCKED", "DEPENDENCY_BLOCKED", "AUTH_REQUIRED", "SOURCE_LIMITED", "SOURCE_TERMS_BLOCKED", "LICENSE_CONSTRAINED", "IDENTITY_PENDING", "NOT_APPLICABLE"].includes(item.state)) target.status = item.state;
    }
    await atomic(manifestPath, manifest);
  }
  const status = await json<Record<string, unknown>>(statusPath).catch(() => ({}));
  await atomic(statusPath, {
    ...status,
    CURRENT_GAP_ID: current?.gap_id ?? null,
    GAPS_COMPLETED: completed,
    LAST_GAP_PROGRESS: current ? `${current.gap_id}: ${event}` : event,
    GAP_QUEUE_STATUS: current?.state ?? "HEALTHY_WAITING",
    HEARTBEAT_AT: checkpoint.updatedAt,
  });
}

async function cycle(prisma: PrismaClient) {
  const queue = await json<Queue>(queuePath);
  let processed = 0;
  for (const gap of queue.items) {
    const retryDue = gap.state === "RETRY_WAIT" && Number(gap.attempts ?? 0) < 3;
    if (processed >= batchLimit || (gap.state !== "PENDING" && !retryDue) || !eligible.has(gap.gap_id)) continue;
    const claimedAt = now();
    gap.state = "RUNNING";
    gap.attempts = Number(gap.attempts ?? 0) + 1;
    gap.started_at ??= claimedAt;
    gap.updated_at = claimedAt;
    gap.last_error = null;
    gap.checkpoint = { phase: "CLAIMED", owner: "COMMODITY_DEPTH_GAP_CHILD", pid: process.pid, at: claimedAt };
    queue.generatedAt = claimedAt;
    await atomic(queuePath, queue);
    await publish(queue, gap, "CLAIMED");
    try {
      const terminal = terminalDisposition[gap.gap_id];
      if (terminal) {
        gap.state = terminal.state;
        gap.updated_at = now();
        gap.completed_at = gap.updated_at;
        gap.last_error = null;
        gap.checkpoint = { phase: "FINAL_DISPOSITION", blocker: terminal.blocker, at: gap.updated_at };
        await atomic(queuePath, queue);
        await publish(queue, gap, terminal.blocker);
        processed++;
        continue;
      }
      const evidence = await verify(prisma, gap);
      gap.state = "COMPLETE";
      gap.updated_at = now();
      gap.completed_at = gap.updated_at;
      gap.checkpoint = { phase: "VERIFIED_COMPLETE", ...evidence, at: gap.updated_at };
      await atomic(queuePath, queue);
      await publish(queue, gap, `canonical readback PASS (${JSON.stringify(evidence)})`);
    } catch (error) {
      gap.state = gap.attempts >= 3 ? "BLOCKED" : "RETRY_WAIT";
      gap.updated_at = now();
      gap.last_error = error instanceof Error ? error.message : String(error);
      gap.checkpoint = { phase: gap.state, at: gap.updated_at };
      await atomic(queuePath, queue);
      await publish(queue, gap, gap.last_error);
    }
    processed++;
  }
  if (!processed) await publish(queue, null, "NO_ELIGIBLE_PENDING_GAP");
  return processed > 0;
}

async function main() {
  if (Number(process.env.MAX_DB_CONCURRENCY ?? "1") !== 1) throw new Error("MAX_DB_CONCURRENCY_MUST_EQUAL_1");
  if (process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER) process.env.DATABASE_URL = process.env.SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER;
  await mkdir(runtime, { recursive: true });
  const lock = await open(lockPath, "wx");
  await lock.writeFile(`${JSON.stringify({ pid: process.pid, owner: "COMMODITY_DEPTH_GAP_CHILD", startedAt: now() })}\n`);
  const prisma = new PrismaClient();
  try {
    do { const advanced = await cycle(prisma); if (!once) await sleep(advanced ? activeBatchDelayMs : pollMs); } while (!once);
  } finally {
    await prisma.$disconnect();
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
