import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type Source = { id: string; enabled?: boolean; sourceState?: string; blockedReason?: string; mode: string; timezone: string; events: string[]; method: string; conditionalRequest: boolean };
const root = process.cwd();
const runtime = path.join(root, "runtime", "commodity");
const configPath = path.join(root, "config", "commodity-production-events.json");
const registryPath = path.join(root, "config", "commodity-official-source-registry.json");
const statePath = path.join(runtime, "event-engine-state.json");
const eventQueuePath = path.join(runtime, "production-event-queue.jsonl");
const progressPath = path.join(root, "runtime", "progress.json");
const lockPath = path.join(runtime, "event-engine.lock");
const pidPath = path.join(runtime, "runner.pid.json");
const planOnly = process.argv.includes("--plan");
const now = () => new Date();
const iso = (date: Date) => date.toISOString();
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
async function atomic(file: string, value: unknown) { const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, json(value)); await rm(file, { force: true }); await writeFile(file, await readFile(temp)); await rm(temp, { force: true }); }

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(date: Date, zone: string) {
  let formatter = formatters.get(zone);
  if (!formatter) { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); formatters.set(zone, formatter); }
  const values = formatter.formatToParts(date);
  return Object.fromEntries(values.map((part) => [part.type, part.value]));
}
function matches(date: Date, source: Source, rule: string) {
  const p = parts(date, source.timezone), hhmm = `${p.hour}:${p.minute}`, weekday = p.weekday.toUpperCase().slice(0, 3);
  if (rule.startsWith("HOURLY")) return p.minute === rule.slice(-2);
  if (rule.startsWith("DAILY ")) return hhmm === rule.slice(6);
  if (rule.startsWith("WEEKDAY ")) return !["SAT", "SUN"].includes(weekday) && hhmm === rule.slice(8);
  if (/^(MON|TUE|WED|THU|FRI|SAT|SUN) /.test(rule)) return weekday === rule.slice(0, 3) && hhmm === rule.slice(4);
  if (rule.startsWith("MONTHLY ")) { const [, day, time] = rule.split(" "); return Number(p.day) === Number(day) && hhmm === time; }
  return `${p.year}-${p.month}-${p.day} ${hhmm}` === rule;
}
function nextEvent(source: Source, from: Date) {
  const cursor = new Date(from); cursor.setUTCSeconds(0, 0); cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  const limit = 370 * 24 * 60;
  for (let i = 0; i < limit; i++, cursor.setUTCMinutes(cursor.getUTCMinutes() + 1)) if (source.events.some((rule) => matches(cursor, source, rule))) return new Date(cursor);
  throw new Error(`NO_NEXT_EVENT:${source.id}`);
}

await mkdir(runtime, { recursive: true });
let lock;
try { lock = await open(lockPath, "wx"); }
catch (error) {
  let existing: { pid?: number } = {}; try { existing = JSON.parse(await readFile(lockPath, "utf8")); } catch {}
  let alive = false; if (existing.pid) try { process.kill(existing.pid, 0); alive = true; } catch {}
  if (alive) throw error;
  await rm(lockPath, { force: true }); lock = await open(lockPath, "wx");
}
await lock.writeFile(json({ pid: process.pid, startedAt: iso(now()) }));
try {
  const config = JSON.parse(await readFile(configPath, "utf8")) as { sources: Source[] };
  const activeSources = config.sources.filter((source) => source.enabled !== false);
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as { sources: Array<{ id: string; api?: string | null; bulkFile?: string | null; metadataEndpoint?: string | null }> };
  const references = new Map(registry.sources.map((source) => [source.id, source.bulkFile ?? source.api ?? source.metadataEndpoint ?? null]));
  if (planOnly) {
    const calculatedAt = now();
    const schedule = activeSources.map((source) => ({ sourceId: source.id, mode: source.mode, nextRun: iso(nextEvent(source, calculatedAt)) })).sort((a, b) => a.nextRun.localeCompare(b.nextRun));
    console.log(JSON.stringify({ status: "PLAN_VALID", activeSources: schedule.length, blockedSources: config.sources.length - activeSources.length, next: schedule[0] }));
    process.exitCode = 0;
  } else {
  await atomic(pidPath, { pid: process.pid, command: "node --experimental-strip-types scripts/data/commodity/run-production-event-engine.ts", status: "RUNNING", startedAt: iso(now()) });
  for (;;) {
    const calculatedAt = now();
    const schedule = activeSources.map((source) => ({ source, next: nextEvent(source, calculatedAt) })).sort((a, b) => +a.next - +b.next);
    const first = schedule[0];
    await atomic(statePath, { status: "WAITING_SOURCE_EVENT", current: first.source.id, nextRun: iso(first.next), schedule: schedule.map(({ source, next }) => ({ sourceId: source.id, mode: source.mode, nextRun: iso(next) })), updatedAt: iso(calculatedAt) });
    await atomic(progressPath, { asset: "GLOBAL_COMMODITY", status: "RUNNING", current_layer: "L18_PRODUCTION_EVENT_ENGINE", current_country: null, current_source: first.source.id, coverage: { registered_sources: config.sources.length, scheduled_sources: schedule.length, blocked_sources: config.sources.length - schedule.length }, rows: 0, updated_at: iso(calculatedAt), eta: iso(first.next) });
    const delay = Math.max(0, +first.next - Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 2_147_000_000)));
    if (Date.now() + 1000 < +first.next) continue;
    const due = schedule.filter((item) => +item.next <= Date.now() + 1000);
    for (const item of due) await appendFile(eventQueuePath, `${JSON.stringify({ eventId: `${item.source.id}:${iso(item.next)}`, source: item.source.id, sourceId: item.source.id, scope: item.source.id === "WORLD_BANK_PINK_SHEET" ? "COMMODITY_SPOT" : "COMMODITY_METADATA_EVENT_SCHEDULING", eventType: item.source.mode, mode: item.source.mode, scheduledAt: iso(item.next), sourceReference: references.get(item.source.id), status: "READY", conditionalRequest: item.source.conditionalRequest, productionOnly: true, historical: false, createdAt: iso(now()) })}\n`);
  }
  }
} finally {
  await lock.close(); await rm(lockPath, { force: true });
}
