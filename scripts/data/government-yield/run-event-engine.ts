import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

type Source = {
  id: string; country: string; enabled: boolean; release_method: string; release_calendar_url: string | null;
  release_timezone: string; supports_dst: boolean; supports_streaming: boolean; supports_webhook: boolean;
  supports_api: boolean; supports_csv: boolean; supports_xml: boolean; supports_json: boolean; supports_rss: boolean;
  supports_manual_download: boolean; release_detection_strategy: string; calendar_refresh_strategy: string;
  calendar_discovery_url: string; calendar_rediscovery_interval_seconds: number; minimal_poll_interval_seconds: number;
  official_release_discovered_at: string | null; next_release_time: string | null; last_release_time: string | null;
  last_successful_update: string | null; script: string; args: string[];
};
type SourceState = Pick<Source, "official_release_discovered_at" | "next_release_time" | "last_release_time" | "last_successful_update"> & { last_calendar_check: string | null; last_attempt: string | null };
const ROOT = path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield"));
const STATE_ROOT = path.join(ROOT, "event-engine");
const LOCK = path.join(STATE_ROOT, "engine.lock");
const CHECKPOINT = path.join(STATE_ROOT, "checkpoint.json");
const HEARTBEAT = path.join(STATE_ROOT, "heartbeat.json");
const FAILURES = path.join(STATE_ROOT, "failure-queue.jsonl");
const MANIFEST = path.join(STATE_ROOT, "completion-manifest.json");
const SOURCE_STATE = path.join(STATE_ROOT, "source-state.json");
const dryRun = process.argv.includes("--dry-run");

async function atomic(file: string, value: unknown): Promise<void> { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`); await rename(temp, file); }
async function run(script: string, args: string[]): Promise<void> { await new Promise<void>((resolve, reject) => { const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], { cwd: process.cwd(), stdio: "inherit", env: { ...process.env, GOVERNMENT_YIELD_RUNTIME_ROOT: ROOT } }); child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${script}:EXIT_${code}`))); }); }
function initialState(source: Source): SourceState { return { official_release_discovered_at: source.official_release_discovered_at, next_release_time: source.next_release_time, last_release_time: source.last_release_time, last_successful_update: source.last_successful_update, last_calendar_check: null, last_attempt: null }; }
function fallbackNext(source: Source, state: SourceState, now: Date): Date { const anchor = state.last_attempt ?? state.last_successful_update; return anchor ? new Date(new Date(anchor).getTime() + source.minimal_poll_interval_seconds * 1000) : now; }
function calendarTimes(text: string, now: Date): Date[] { const matches = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g) ?? []; return matches.map((value) => new Date(value)).filter((value) => Number.isFinite(value.getTime()) && value > now).sort((a, b) => a.getTime() - b.getTime()); }
async function discoverNext(source: Source, state: SourceState, now: Date): Promise<Date> {
  if (source.release_calendar_url) {
    try {
      const response = await fetch(source.release_calendar_url, { headers: { Accept: "application/json, application/rss+xml, text/calendar, text/plain", "User-Agent": "SmartFund Government Yield Official Calendar Engine/1.0" }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`CALENDAR_HTTP_${response.status}`);
      const next = calendarTimes(await response.text(), now)[0];
      state.last_calendar_check = now.toISOString();
      if (next) { state.official_release_discovered_at = now.toISOString(); state.next_release_time = next.toISOString(); return next; }
    } catch (error) { await appendFile(FAILURES, `${JSON.stringify({ at: now.toISOString(), sourceId: source.id, stage: "CALENDAR_DISCOVERY", retryable: true, error: error instanceof Error ? error.message : String(error) })}\n`); }
  }
  const next = fallbackNext(source, state, now);
  state.next_release_time = next.toISOString();
  return next;
}
async function execute(source: Source): Promise<void> { let lastError = ""; for (let attempt = 1; attempt <= 2; attempt++) { try { await run(source.script, source.args); await run("scripts/data/government-yield/build-official-products.ts", []); return; } catch (error) { lastError = error instanceof Error ? error.message : String(error); await appendFile(FAILURES, `${JSON.stringify({ at: new Date().toISOString(), sourceId: source.id, stage: "SOURCE_UPDATE", attempt, retryable: attempt < 2, error: lastError })}\n`); } } throw new Error(`${source.id}:${lastError}`); }

async function main(): Promise<void> {
  await mkdir(STATE_ROOT, { recursive: true });
  const metadata = JSON.parse(await readFile("config/government-yield-source-metadata.json", "utf8")) as { scheduler: string; sources: Source[]; market_yield: unknown };
  const sources = metadata.sources.filter((source) => source.enabled);
  let persisted: Record<string, SourceState> = {};
  try { persisted = JSON.parse(await readFile(SOURCE_STATE, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const source of sources) persisted[source.id] ??= initialState(source);
  const now = new Date();
  const upcoming = await Promise.all(sources.map(async (source) => ({ source, at: await discoverNext(source, persisted[source.id], now) })));
  if (dryRun) { console.log(JSON.stringify({ status: "DRY_RUN_PASS", scheduler: metadata.scheduler, market_yield: metadata.market_yield, schedule: upcoming.map(({ source, at }) => ({ sourceId: source.id, strategy: source.release_calendar_url ? "OFFICIAL_CALENDAR" : source.release_detection_strategy, nextRunAt: at.toISOString() })) }, null, 2)); return; }
  let lock;
  try { lock = await open(LOCK, "wx"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, owner: "railway-government-yield-official", startedAt: now.toISOString() })}\n`);
    for (;;) {
      const discovered = await Promise.all(sources.map(async (source) => ({ source, at: await discoverNext(source, persisted[source.id], new Date()) })));
      discovered.sort((a, b) => a.at.getTime() - b.at.getTime());
      const event = discovered[0];
      await atomic(SOURCE_STATE, persisted);
      await atomic(CHECKPOINT, { scheduler: metadata.scheduler, status: "SLEEPING_UNTIL_OFFICIAL_RELEASE_OR_MINIMAL_POLL", sourceId: event.source.id, nextRunAt: event.at.toISOString(), resume: true, updatedAt: new Date().toISOString() });
      await atomic(HEARTBEAT, { status: "IDLE", pid: process.pid, nextRunAt: event.at.toISOString(), updatedAt: new Date().toISOString() });
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, event.at.getTime() - Date.now())));
      const state = persisted[event.source.id]; state.last_attempt = new Date().toISOString(); state.next_release_time = null;
      try { await execute(event.source); state.last_successful_update = new Date().toISOString(); state.last_release_time = state.last_successful_update; await atomic(MANIFEST, { asset: "GOVERNMENT_YIELD", sourceId: event.source.id, status: "SOURCE_UPDATE_COMPLETED", completedAt: state.last_successful_update }); }
      catch (error) { await atomic(MANIFEST, { asset: "GOVERNMENT_YIELD", sourceId: event.source.id, status: "SOURCE_UPDATE_COMPLETED_WITH_GAP", error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() }); }
      await atomic(SOURCE_STATE, persisted);
    }
  } finally { await lock.close(); await rm(LOCK, { force: true }); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack ?? error.message : error); process.exitCode = 1; });
