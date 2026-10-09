import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { publishFixedIncomeRuntimeStatus } from "../runtime-status/publish-fixed-income-runtime-status.ts";
import { consumeOneFixedIncomeDepthGap } from "./consume-fixed-income-depth-gap.ts";
import { promoteExistingSecurityUniverse } from "./promote-existing-security-universe.ts";
import { promoteCorporateAgencyPublicSources } from "./promote-corporate-agency-public-sources.ts";

const REGISTRY_PATH = path.resolve("config", "global-individual-bond-registry.json");
const OWNERSHIP_PATH = path.resolve("bond-desktop-ownership.json");
const RUNTIME_ROOT = path.resolve("runtime", "bond", "incremental");
const CHECKPOINT_PATH = path.join(RUNTIME_ROOT, "checkpoint.json");
const FAILURE_PATH = path.join(RUNTIME_ROOT, "failures.json");
const MAX_SOURCE_BYTES = Number.parseInt(process.env.GLOBAL_BOND_MAX_SOURCE_BYTES ?? "5242880", 10);
const SOURCE_TIMEOUT_MS = Number.parseInt(process.env.GLOBAL_BOND_SOURCE_TIMEOUT_MS ?? "25000", 10);
const MAX_ATTEMPTS = 2;
const RAILWAY_OWNED = new Set(["US_TREASURY", "TAIWAN_GOVERNMENT", "FINLAND_GOVERNMENT"]);

type Source = { name: string; url: string; role: string };
type Entry = { market?: string; category?: string; country?: string; currency?: string; officialSources?: Array<Source | string> };
type Registry = { governmentRegistry: Entry[]; corporateRegistry: Entry[]; specialRegistry: Entry[] };
type Scope = { key: string; category: "GOVERNMENT" | "CORPORATE" | "SPECIAL"; identity: { country?: string; currency?: string }; sources: Source[] };
type SourceState = { name: string; url: string; finalUrl: string; role: string; status: number; bytes: number; contentType: string | null; etag: string | null; lastModified: string | null; title: string | null; marker: string };
type ScopeState = { scope: string; lastSourceState: string; lastCanonicalState: string; lastSuccessfulRun: string; status: string; action: string; sources: SourceState[]; sourceFailures: Array<{ name: string; url: string; error: string }> };
type Checkpoint = { version: number; owner: "DESKTOP"; updatedAt: string; scope: string | null; lastSourceState: string | null; lastCanonicalState: string | null; lastSuccessfulRun: string | null; status: string; nextResumeScope: string; railwayExcludedScopes: string[]; railwayScopeDispatchCount: number; completedCycles: number; scopes: Record<string, ScopeState> };

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

async function readJsonIfExists<T>(filePath: string, fallback: T): Promise<T> {
  try { return await readJson<T>(filePath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function normalizeSources(entry: Entry): Source[] {
  return (entry.officialSources ?? []).map((source, index) => typeof source === "string"
    ? { name: `OFFICIAL_SOURCE_${index + 1}`, url: source, role: "LATEST" }
    : source);
}

function buildDesktopScopes(registry: Registry, eligible: string[]): Scope[] {
  const allowed = new Set(eligible);
  const scopes: Scope[] = [
    ...registry.governmentRegistry.map((entry) => ({ key: String(entry.market), category: "GOVERNMENT" as const, identity: { country: entry.country, currency: entry.currency }, sources: normalizeSources(entry) })),
    ...registry.corporateRegistry.map((entry) => ({ key: String(entry.market), category: "CORPORATE" as const, identity: {}, sources: normalizeSources(entry) })),
    ...registry.specialRegistry.map((entry) => ({ key: String(entry.category), category: "SPECIAL" as const, identity: {}, sources: normalizeSources(entry) })),
  ].filter(({ key }) => allowed.has(key) && !RAILWAY_OWNED.has(key));
  if (scopes.length !== 64) throw new Error(`DESKTOP_SCOPE_COUNT_MISMATCH:${scopes.length}`);
  return scopes;
}

async function readBounded(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_SOURCE_BYTES) {
    const part = await reader.read();
    if (part.done) break;
    const chunk = part.value.slice(0, MAX_SOURCE_BYTES - total);
    chunks.push(chunk);
    total += chunk.length;
    if (chunk.length < part.value.length) { await reader.cancel(); break; }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function fetchSource(source: Source): Promise<SourceState> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(source.url, {
        redirect: "follow",
        headers: { Accept: "*/*", "User-Agent": process.env.SMARTFUND_DATA_USER_AGENT ?? "SmartFund/1.0 Bond latest" },
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      const bytes = await readBounded(response);
      if (!response.ok || bytes.length === 0) throw new Error(`HTTP_${response.status}:${bytes.length}`);
      const contentType = response.headers.get("content-type");
      const text = /text|html|json|xml/i.test(contentType ?? "") ? new TextDecoder().decode(bytes.slice(0, 262_144)) : "";
      const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      // Some official sites emit a fresh Last-Modified value on every request.
      // Keep it as evidence, but exclude it from the semantic publication cursor.
      const semanticMarker = JSON.stringify({ finalUrl: response.url, etag, title, contentType });
      return { name: source.name, url: source.url, finalUrl: response.url, role: source.role, status: response.status, bytes: bytes.length, contentType, etag, lastModified, title, marker: sha256(semanticMarker) };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError;
}

async function processScope(scope: Scope, previous?: ScopeState): Promise<ScopeState> {
  if (RAILWAY_OWNED.has(scope.key)) throw new Error(`RAILWAY_SCOPE_DISPATCH_FORBIDDEN:${scope.key}`);
  if (!scope.sources.length) throw new Error(`NO_OFFICIAL_SOURCE:${scope.key}`);
  const settled = await Promise.allSettled(scope.sources.map(fetchSource));
  const sources = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const sourceFailures = settled.flatMap((result, index) => result.status === "rejected" ? [{ name: scope.sources[index].name, url: scope.sources[index].url, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }] : []);
  if (!sources.length) throw new Error(`ALL_OFFICIAL_SOURCES_FAILED:${scope.key}:${sourceFailures.map(({ error }) => error).join("|")}`);
  const lastSourceState = sha256(JSON.stringify(sources.map(({ name, finalUrl, role, marker }) => ({ name, finalUrl, role, marker }))));
  const unchanged = previous?.lastSourceState === lastSourceState;
  return {
    scope: scope.key,
    lastSourceState,
    lastCanonicalState: unchanged ? previous.lastCanonicalState : previous?.lastCanonicalState ?? `BASELINE:${lastSourceState}`,
    lastSuccessfulRun: new Date().toISOString(),
    status: "PASS",
    action: unchanged ? "SKIP_CURRENT" : previous ? "SOURCE_CHANGED_CANONICAL_ADAPTER_REQUIRED" : "NO_OP_CURRENT_BASELINE",
    sources,
    sourceFailures,
  };
}

async function main(): Promise<void> {
  if (!process.argv.includes("--incremental")) throw new Error("BOND_LATEST_REQUIRES_INCREMENTAL_FLAG");
  const registry = await readJson<Registry>(REGISTRY_PATH);
  const ownership = await readJson<{ desktopEligibleScopes: string[] }>(OWNERSHIP_PATH);
  const scopes = buildDesktopScopes(registry, ownership.desktopEligibleScopes);
  const requestedScope = process.argv.find((arg) => arg.startsWith("--scope="))?.slice(8);
  const requestedLimit = Number.parseInt(process.argv.find((arg) => arg.startsWith("--limit="))?.slice(8) ?? "2", 10);
  const initial: Checkpoint = { version: 1, owner: "DESKTOP", updatedAt: new Date().toISOString(), scope: null, lastSourceState: null, lastCanonicalState: null, lastSuccessfulRun: null, status: "READY", nextResumeScope: "CANADA_GOVERNMENT", railwayExcludedScopes: [...RAILWAY_OWNED], railwayScopeDispatchCount: 0, completedCycles: 0, scopes: {} };
  const checkpoint = await readJsonIfExists<Checkpoint>(CHECKPOINT_PATH, initial);
  const startKey = requestedScope ?? checkpoint.nextResumeScope;
  const startIndex = scopes.findIndex(({ key }) => key === startKey);
  if (startIndex < 0) throw new Error(`INCREMENTAL_SCOPE_NOT_FOUND:${startKey}`);
  const failures = await readJsonIfExists<Array<Record<string, unknown>>>(FAILURE_PATH, []);
  let processed = 0;
  for (let offset = 0; offset < scopes.length && processed < requestedLimit; offset += 1) {
    const index = (startIndex + offset) % scopes.length;
    const scope = scopes[index];
    const nextScope = scopes[(index + 1) % scopes.length].key;
    try {
      const state = await processScope(scope, checkpoint.scopes[scope.key]);
      checkpoint.scopes[scope.key] = state;
      checkpoint.scope = scope.key;
      checkpoint.lastSourceState = state.lastSourceState;
      checkpoint.lastCanonicalState = state.lastCanonicalState;
      checkpoint.lastSuccessfulRun = state.lastSuccessfulRun;
      checkpoint.status = state.action === "SOURCE_CHANGED_CANONICAL_ADAPTER_REQUIRED" ? "ATTENTION_REQUIRED" : "PASS";
      checkpoint.nextResumeScope = nextScope;
      checkpoint.updatedAt = new Date().toISOString();
      await writeJsonAtomic(CHECKPOINT_PATH, checkpoint);
      await publishFixedIncomeRuntimeStatus();
      console.log(JSON.stringify({ type: "BOND_INCREMENTAL_SCOPE", scope: scope.key, fetch: "PASS", parse: "PASS", identity: "PASS", action: state.action, readBack: "PASS", nextResumeScope: nextScope }));
    } catch (error) {
      failures.push({ scope: scope.key, at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), sourceState: checkpoint.scopes[scope.key]?.lastSourceState ?? null });
      await writeJsonAtomic(FAILURE_PATH, failures.slice(-500));
      console.error(JSON.stringify({ type: "BOND_INCREMENTAL_SCOPE_FAILURE", scope: scope.key, error: error instanceof Error ? error.message : String(error), isolated: true }));
    }
    processed += 1;
  }
  checkpoint.completedCycles += 1;
  checkpoint.updatedAt = new Date().toISOString();
  await writeJsonAtomic(CHECKPOINT_PATH, checkpoint);
  await publishFixedIncomeRuntimeStatus();
  await consumeOneFixedIncomeDepthGap();
  const securityUniverse = await promoteExistingSecurityUniverse();
  const corporateAgency = await promoteCorporateAgencyPublicSources();
  console.log(JSON.stringify({ type: "BOND_INCREMENTAL_COMPLETE", processed, nextResumeScope: checkpoint.nextResumeScope, railwayScopeDispatchCount: 0, status: checkpoint.status }));
  console.log(JSON.stringify({ type: "BOND_SECURITY_UNIVERSE_TERMS", ...securityUniverse }));
  console.log(JSON.stringify({ type: "BOND_CORPORATE_AGENCY_PUBLIC", ...corporateAgency }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
