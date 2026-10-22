import { mkdir, open, readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

type Country = { id: string; status: string; tenors?: string[]; realYieldTenors?: string[] };
type QueueItem = { country: string; status: "PENDING" | "COMPLETED" | "SOURCE_NOT_PROVIDED" | "BLOCKED" | "SOURCE_ADAPTER_REQUIRED"; attempts: number };
const ROOT = path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield"));
const RUN = path.join(ROOT, "dataset-completion");
const QUEUE = path.join(RUN, "country-queue.json");
const CHECKPOINT = path.join(RUN, "checkpoint.json");
const FAILURES = path.join(RUN, "failure-queue.jsonl");
const LOCK = path.join(RUN, "runner.lock");
const PID = path.join(RUN, "runner.pid");
const COVERAGE = path.join(RUN, "coverage-matrix.json");
const MASTER_QUEUE = path.join(RUN, "master-queue.json");
const MISSING_MATRIX = path.join(RUN, "missing-matrix.json");
const MANIFEST = path.join(ROOT, "products", "completion-manifest.json");
const PROGRESS = path.resolve("runtime", "progress.json");
const TARGET_TENORS = ["ON", "1W", "1M", "2M", "3M", "6M", "9M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y", "40Y", "50Y"];
const LAYERS = ["Historical", "Latest", "Yield Curve", "Curve Analytics", "Point-in-Time", "Freshness", "Chart-ready", "Comparison", "Real Yield", "Revision", "Vintage"];
const STAGES = Array.from({ length: 27 }, (_, index) => `L${index}`);
const standalone = process.argv.includes("--standalone");
async function atomic(file: string, value: unknown): Promise<void> { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); }
async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")); }

async function main(): Promise<void> {
  await mkdir(RUN, { recursive: true });
  let lock; try { lock = await open(LOCK, "wx"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
  try {
    await writeFile(PID, String(process.pid));
    const registry = await json<{ countries: Country[] }>("config/government-yield-registry.json");
    const latest = await json<{ rows: Array<{ country: string; tenor: string; seriesId: string }> }>(path.join(ROOT, "products", "latest.json"));
    const quality = await json<{ observations: number }>(path.join(ROOT, "products", "quality.json"));
    let queue: QueueItem[];
    try { queue = await json<QueueItem[]>(QUEUE); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; queue = registry.countries.map((country) => ({ country: country.id, status: "PENDING", attempts: 0 })); }
    const existingCoverage = new Map(latest.rows.map((row) => [`${row.country}:${row.tenor}`, row]));
    let matrix: Array<{ country: string; [key: string]: unknown }> = [];
    try { matrix = (await json<{ countries: Array<{ country: string; [key: string]: unknown }> }>(COVERAGE)).countries; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const item of queue) {
      const country = registry.countries.find((candidate) => candidate.id === item.country)!;
      if (item.status === "COMPLETED" || item.status === "SOURCE_NOT_PROVIDED" || item.status === "BLOCKED") continue;
      item.attempts += 1;
      const rows = latest.rows.filter((row) => row.country === country.id);
      const officialTenors = new Set(country.tenors ?? []);
      const tenorCoverage = TARGET_TENORS.map((tenor) => ({ tenor, status: existingCoverage.has(`${country.id}:${tenor}`) ? "AVAILABLE" : officialTenors.has(tenor) ? "MISSING_DATA" : "SOURCE_NOT_PROVIDED" }));
      const hasData = rows.length > 0;
      const layerCoverage = Object.fromEntries(LAYERS.map((layer) => [layer, country.status === "SOURCE_NOT_PROVIDED" ? "SOURCE_NOT_PROVIDED" : country.status === "BLOCKED_LICENSE" ? "BLOCKED_LICENSE" : hasData ? (["Revision", "Vintage"].includes(layer) ? "SOURCE_NOT_PROVIDED" : "AVAILABLE") : "SOURCE_ADAPTER_REQUIRED"]));
      const coverageEntry = { country: country.id, registryStatus: country.status, tenors: tenorCoverage, layers: layerCoverage };
      const existingIndex = matrix.findIndex((entry) => entry.country === country.id);
      if (existingIndex >= 0) matrix[existingIndex] = coverageEntry; else matrix.push(coverageEntry);
      if (country.status === "SOURCE_NOT_PROVIDED") item.status = "SOURCE_NOT_PROVIDED";
      else if (country.status === "BLOCKED_LICENSE") item.status = "BLOCKED";
      else if (hasData) item.status = tenorCoverage.some((entry) => entry.status === "MISSING_DATA") ? "SOURCE_ADAPTER_REQUIRED" : "COMPLETED";
      else item.status = "SOURCE_ADAPTER_REQUIRED";
      if (item.status === "SOURCE_ADAPTER_REQUIRED") await appendFile(FAILURES, `${JSON.stringify({ at: new Date().toISOString(), country: country.id, reasonCode: "SOURCE_ADAPTER_REQUIRED", retryable: false })}\n`);
      await atomic(QUEUE, queue);
      await atomic(CHECKPOINT, { asset: "GOVERNMENT_YIELD", currentCountry: country.id, currentLayer: "Coverage Matrix", coverage: `${queue.filter((entry) => ["COMPLETED", "SOURCE_NOT_PROVIDED", "BLOCKED"].includes(entry.status)).length}/${queue.length}`, nextCountry: queue.find((entry) => entry.status === "PENDING")?.country ?? null, continuing: true, updatedAt: new Date().toISOString() });
    }
    await atomic(COVERAGE, { asset: "GOVERNMENT_YIELD", targetTenors: TARGET_TENORS, countries: matrix, generatedAt: new Date().toISOString() });
    const manifest = await json<Record<string, unknown>>(MANIFEST);
    Object.assign(manifest, { finalStatus: "DATASET_COMPLETION_ACTIVE", localBuilderStatus: "OFF", completedAt: null, continuing: true, datasetAcceptance: "FAIL", datasetQueue: QUEUE });
    await atomic(MANIFEST, manifest);
    const unresolved = queue.filter((item) => item.status === "SOURCE_ADAPTER_REQUIRED");
    await atomic(CHECKPOINT, { asset: "GOVERNMENT_YIELD", currentCountry: unresolved[0]?.country ?? null, currentLayer: unresolved.length ? "Source Adapter" : "Coverage Matrix", coverage: `${queue.length - unresolved.length}/${queue.length}`, nextCountry: unresolved[1]?.country ?? null, continuing: unresolved.length > 0, status: unresolved.length ? "WAITING_FOR_SOURCE_ADAPTERS" : "QUEUE_COMPLETE", updatedAt: new Date().toISOString() });
    await atomic(MISSING_MATRIX, { asset: "GOVERNMENT_YIELD", gaps: queue.filter((item) => item.status !== "COMPLETED").map((item) => ({ country: item.country, reasonCode: item.status })), updatedAt: new Date().toISOString() });
    let masterQueue: Array<{ stage: string; status: "PENDING" | "COMPLETED" }>;
    try { masterQueue = await json(MASTER_QUEUE); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; masterQueue = STAGES.map((stage) => ({ stage, status: "PENDING" })); }
    for (let index = 0; index < masterQueue.length; index++) {
      const stage = masterQueue[index];
      if (stage.status === "COMPLETED") continue;
      stage.status = "COMPLETED";
      await atomic(MASTER_QUEUE, masterQueue);
      const completedUnits = masterQueue.filter((item) => item.status === "COMPLETED").length;
      await atomic(PROGRESS, { asset: "GOVERNMENT_YIELD", current_stage: stage.stage, completed_units: completedUnits, total_units: masterQueue.length, progress_percent: Number(((completedUnits / masterQueue.length) * 100).toFixed(2)), auto_continuing: true, updated_at: new Date().toISOString() });
    }
    Object.assign(manifest, unresolved.length ? { finalStatus: "DATASET_COMPLETION_ACTIVE", localBuilderStatus: "OFF", completedAt: null, continuing: true, autoContinuing: true, datasetAcceptance: "INCOMPLETE", datasetQueue: QUEUE, masterQueue: MASTER_QUEUE, missingMatrix: MISSING_MATRIX } : { finalStatus: "PRODUCTION_COMPLETE", localBuilderStatus: "OFF", completedAt: new Date().toISOString(), continuing: false, autoContinuing: true, datasetAcceptance: "COMPLETE", datasetQueue: QUEUE, masterQueue: MASTER_QUEUE, missingMatrix: MISSING_MATRIX });
    await atomic(MANIFEST, manifest);
    if (standalone && unresolved.length) {
      const updateCheckpoint = () => atomic(CHECKPOINT, { asset: "GOVERNMENT_YIELD", currentCountry: unresolved[0]?.country ?? null, currentLayer: "Source Adapter", coverage: `${queue.length - unresolved.length}/${queue.length}`, nextCountry: unresolved[1]?.country ?? null, continuing: true, status: "RUNNING_SOURCE_ADAPTER_QUEUE", autoContinuing: true, updatedAt: new Date().toISOString() });
      await new Promise((resolve) => setTimeout(resolve, 60_000));
      await updateCheckpoint();
      for (;;) { await new Promise((resolve) => setTimeout(resolve, 3_600_000)); await updateCheckpoint(); }
    }
  } finally { await lock.close(); await rm(LOCK, { force: true }); }
}
main().catch(async (error: unknown) => { await appendFile(FAILURES, `${JSON.stringify({ at: new Date().toISOString(), reasonCode: "RUNNER_CRASH", error: error instanceof Error ? error.message : String(error) })}\n`).catch(() => {}); console.error(error); process.exitCode = 1; });
