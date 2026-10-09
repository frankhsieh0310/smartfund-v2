import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type Job = { id: string; source: string; state: string; route: string; url?: string; dataset?: string };
const root = process.cwd();
const runtime = path.join(root, "runtime", "commodity", "faostat");
const lockPath = path.join(runtime, "single-writer.lock");
const checkpointPath = path.join(runtime, "checkpoint.json");
const heartbeatPath = path.join(runtime, "heartbeat.json");
const once = process.argv.includes("--once");
const cadenceMs = 24 * 60 * 60_000;
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function atomic(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`); await rename(temporary, file); }

async function cycle() {
  const routing = JSON.parse(await readFile(path.join(root, "config", "commodity-official-completion-routing.json"), "utf8")) as { jobs: Job[] };
  const jobs = routing.jobs.filter((job) => job.source === "FAO" && job.route === "BULK_ZIP_CSV" && job.url);
  const results: Array<Record<string, unknown>> = [];
  for (const job of jobs) {
    try {
      const response = await fetch(job.url!, { headers: { Range: "bytes=0-0", "user-agent": "SmartFund-Commodity-FAOSTAT/1.0" }, signal: AbortSignal.timeout(30_000) });
      results.push({ job: job.id, dataset: job.dataset, status: response.status, routeReady: response.ok || response.status === 206 });
    } catch (error) {
      results.push({ job: job.id, dataset: job.dataset, status: null, routeReady: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const ready = results.length > 0 && results.every((result) => result.routeReady === true);
  const updatedAt = now();
  const nextRunAt = new Date(Date.now() + cadenceMs).toISOString();
  const state = ready ? "PRODUCTION_READY" : "SOURCE_BLOCKED";
  const checkpoint = { owner: "COMMODITY_FAOSTAT", pid: process.pid, state, datasets: results, adapter: "run-official-completion-router.ts", parser: "EXISTING_BULK_ZIP_CSV", checkpointActive: true, updatedAt, nextRunAt };
  await atomic(checkpointPath, checkpoint);
  await atomic(heartbeatPath, { ...checkpoint, heartbeatAt: updatedAt, cadence: "DAILY_SOURCE_ROUTE_VERIFICATION" });
}

async function main() {
  if (Number(process.env.MAX_DB_CONCURRENCY ?? "1") !== 1) throw new Error("MAX_DB_CONCURRENCY_MUST_EQUAL_1");
  await mkdir(runtime, { recursive: true });
  const lock = await open(lockPath, "wx");
  await lock.writeFile(`${JSON.stringify({ pid: process.pid, owner: "COMMODITY_FAOSTAT", startedAt: now() })}\n`);
  try { do { await cycle(); if (!once) await sleep(cadenceMs); } while (!once); }
  finally { await lock.close(); await rm(lockPath, { force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
