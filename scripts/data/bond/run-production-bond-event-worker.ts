import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

type EventType =
  | "SECURITY_DISCOVERED"
  | "ISSUANCE_UPDATED"
  | "AUCTION_ANNOUNCED"
  | "AUCTION_RESULT_PUBLISHED"
  | "LIFECYCLE_UPDATED"
  | "OFFICIAL_OBSERVATION_PUBLISHED"
  | "LATEST_MARKET_OBSERVATION_PUBLISHED";
type BondEvent = {
  eventId: string;
  asset: "BOND";
  category: "GOVERNMENT" | "CORPORATE" | "SPECIAL";
  market: string;
  source: string;
  type: EventType;
  occurredAt: string;
  sourceDocumentId?: string;
};
type Strategy = { asset: "BOND"; category: BondEvent["category"]; market: string; source: string; events: EventType[]; handler: string | null; enabled: boolean; blockedReason?: string };
type StrategyConfig = { version: number; mode: "EVENT_DRIVEN"; polling: false; defaultPolicy: "DENY"; strategies: Strategy[] };
type EventRecord = { event: BondEvent; status: "RUNNING" | "PASS" | "FAILED" | "REJECTED"; startedAt: string; completedAt?: string; exitCode?: number; error?: string };

const ROOT = process.cwd();
const CONFIG_PATH = path.resolve(process.env.BOND_EVENT_STRATEGY_PATH ?? path.join("config", "bond-production-event-strategies.json"));
const RUNTIME_ROOT = path.resolve(process.env.BOND_EVENT_RUNTIME_ROOT ?? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH ?? "runtime", "bond", "production-event-worker"));
const CHECKPOINT_PATH = path.join(RUNTIME_ROOT, "checkpoint.json");
const FAILURE_QUEUE_PATH = path.join(RUNTIME_ROOT, "failure-queue.json");
const PROGRESS_PATH = path.join(ROOT, "runtime", "bond", "progress.json");
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const MAX_BODY_BYTES = 64 * 1024;
const activeMarkets = new Set<string>();

const now = () => new Date().toISOString();
async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T; }
async function readJsonOr<T>(file: string, fallback: T): Promise<T> { try { return await readJson<T>(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; } }
async function writeJsonAtomic(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); const temporary = `${file}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temporary, file); }
function digest(value: string) { return createHash("sha256").update(value).digest(); }
function authorized(request: IncomingMessage): boolean {
  const expected = process.env.BOND_EVENT_TOKEN;
  if (!expected) return false;
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = digest(expected); const right = digest(supplied);
  return timingSafeEqual(left, right);
}
function validateEvent(value: unknown): BondEvent {
  if (!value || typeof value !== "object") throw new Error("BOND_EVENT_OBJECT_REQUIRED");
  const event = value as Record<string, unknown>;
  for (const field of ["eventId", "asset", "category", "market", "source", "type", "occurredAt"]) if (typeof event[field] !== "string" || !event[field]) throw new Error(`BOND_EVENT_FIELD_REQUIRED:${field}`);
  if (event.asset !== "BOND") throw new Error("BOND_EVENT_ASSET_SCOPE_VIOLATION");
  if (!Number.isFinite(Date.parse(String(event.occurredAt)))) throw new Error("BOND_EVENT_OCCURRED_AT_INVALID");
  return event as BondEvent;
}
function strategyFor(config: StrategyConfig, event: BondEvent): Strategy {
  const strategy = config.strategies.find((item) => item.asset === event.asset && item.category === event.category && item.market === event.market && item.source === event.source && item.events.includes(event.type));
  if (!strategy) throw new Error("BOND_EVENT_STRATEGY_NOT_FOUND");
  if (!strategy.enabled || !strategy.handler) throw new Error(`BOND_EVENT_STRATEGY_DISABLED:${strategy.blockedReason ?? "HANDLER_UNAVAILABLE"}`);
  return strategy;
}
async function runHandler(strategy: Strategy, event: BondEvent): Promise<number> {
  if (activeMarkets.has(event.market)) throw new Error(`BOND_EVENT_MARKET_WRITER_ACTIVE:${event.market}`);
  activeMarkets.add(event.market);
  try {
    const args = ["--experimental-strip-types", strategy.handler!, `--event=${event.type}`, `--event-id=${event.eventId}`, `--event-at=${event.occurredAt}`];
    const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, BOND_EVENT_MARKET: event.market, BOND_EVENT_SOURCE: event.source }, stdio: "inherit" });
    return await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
  } finally { activeMarkets.delete(event.market); }
}
async function dispatch(config: StrategyConfig, event: BondEvent): Promise<EventRecord> {
  const checkpoint = await readJsonOr<Record<string, EventRecord>>(CHECKPOINT_PATH, {});
  if (checkpoint[event.eventId]?.status === "PASS") return checkpoint[event.eventId];
  const strategy = strategyFor(config, event);
  const record: EventRecord = { event, status: "RUNNING", startedAt: now() };
  checkpoint[event.eventId] = record; await writeJsonAtomic(CHECKPOINT_PATH, checkpoint);
  try {
    const exitCode = await runHandler(strategy, event);
    record.status = exitCode === 0 ? "PASS" : "FAILED"; record.exitCode = exitCode; record.completedAt = now();
    checkpoint[event.eventId] = record; await writeJsonAtomic(CHECKPOINT_PATH, checkpoint);
    await writeJsonAtomic(PROGRESS_PATH, { asset: "BOND", status: record.status === "PASS" ? "RUNNING" : "CRASH", current_layer: event.type, current_country: event.market, coverage: { event_id: event.eventId, source: event.source }, rows: 0, updated_at: now(), eta: null });
    if (exitCode !== 0) { const queue = await readJsonOr<EventRecord[]>(FAILURE_QUEUE_PATH, []); queue.push(record); await writeJsonAtomic(FAILURE_QUEUE_PATH, queue.slice(-1000)); }
    return record;
  } catch (error) {
    record.status = "FAILED"; record.error = error instanceof Error ? error.message : String(error); record.completedAt = now(); checkpoint[event.eventId] = record;
    await writeJsonAtomic(CHECKPOINT_PATH, checkpoint); const queue = await readJsonOr<EventRecord[]>(FAILURE_QUEUE_PATH, []); queue.push(record); await writeJsonAtomic(FAILURE_QUEUE_PATH, queue.slice(-1000));
    await writeJsonAtomic(PROGRESS_PATH, { asset: "BOND", status: "CRASH", current_layer: event.type, current_country: event.market, coverage: { event_id: event.eventId, source: event.source }, rows: 0, updated_at: now(), eta: null, error: record.error });
    throw error;
  }
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { const buffer = Buffer.from(chunk); bytes += buffer.length; if (bytes > MAX_BODY_BYTES) throw new Error("BOND_EVENT_BODY_TOO_LARGE"); chunks.push(buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function respond(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { "content-type": "application/json" }); response.end(`${JSON.stringify(value)}\n`); }

async function main() {
  const config = await readJson<StrategyConfig>(CONFIG_PATH);
  if (config.mode !== "EVENT_DRIVEN" || config.polling !== false || config.defaultPolicy !== "DENY") throw new Error("BOND_EVENT_STRATEGY_CONFIG_INVALID");
  if (process.argv.includes("--dry-run")) {
    const enabled = config.strategies.filter((item) => item.enabled && item.handler);
    console.log(JSON.stringify({ status: "PASS", mode: config.mode, polling: config.polling, enabledStrategies: enabled.length, disabledStrategies: config.strategies.length - enabled.length, historicalWrites: 0 }, null, 2));
    return;
  }
  if (!process.env.BOND_EVENT_TOKEN) throw new Error("BOND_EVENT_TOKEN_REQUIRED");
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return respond(response, 200, { status: "PASS", mode: "EVENT_DRIVEN", polling: false, activeMarkets: [...activeMarkets] });
    if (request.method !== "POST" || request.url !== "/bond-events") return respond(response, 404, { error: "NOT_FOUND" });
    if (!authorized(request)) return respond(response, 401, { error: "UNAUTHORIZED" });
    try { const event = validateEvent(await readBody(request)); const result = await dispatch(config, event); return respond(response, result.status === "PASS" ? 200 : 500, result); }
    catch (error) { return respond(response, 422, { error: error instanceof Error ? error.message : String(error) }); }
  });
  server.listen(PORT, "0.0.0.0", () => console.log(JSON.stringify({ status: "ONLINE", mode: "EVENT_DRIVEN", polling: false, port: PORT })));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
