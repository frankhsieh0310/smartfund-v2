import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

type Row = {
  country: string; seriesId: string; tenor: string; observationDate: string; value: number;
  unit: string; curveType: string; source: string; sourceUrl: string; fetchedAt: string;
  publicationDate: string | null; revisionStatus: string; parserVersion: string; qualityStatus: string;
};
type ScopeId = "US_TREASURY_CURVE" | "ECB_EURO_AREA_CURVE" | "BOE_UK_CURVE" | "MOF_JAPAN_CURVE";
type ScopeState = {
  scope: ScopeId; lastSourceObservation: string | null; lastCanonicalObservation: string | null;
  lastSuccessfulRun: string | null; lastAttempt?: string; status: string; nextScope: ScopeId | null; action?: string;
};

const ROOT = path.resolve(process.env.GOVERNMENT_YIELD_RUNTIME_ROOT ?? path.join("runtime", "government-yield"));
const INCREMENTAL = path.join(ROOT, "incremental");
const CHECKPOINT = path.join(INCREMENTAL, "checkpoint.json");
const FAILURES = path.join(INCREMENTAL, "failure-queue.jsonl");
const LATEST = path.join(ROOT, "products", "latest.json");
const SCOPES: ScopeId[] = ["US_TREASURY_CURVE", "ECB_EURO_AREA_CURVE", "BOE_UK_CURVE", "MOF_JAPAN_CURVE"];
const requested = process.argv.find((arg) => arg.startsWith("--scope="))?.split("=")[1] as ScopeId | undefined;
const force = process.argv.includes("--force");
const frequencyHours: Record<ScopeId, number> = {
  US_TREASURY_CURVE: 6, ECB_EURO_AREA_CURVE: 6, BOE_UK_CURVE: 12, MOF_JAPAN_CURVE: 12,
};
const adapter: Record<ScopeId, string> = {
  US_TREASURY_CURVE: "capture-us-treasury-official.ts",
  ECB_EURO_AREA_CURVE: "capture-ecb-official.ts",
  BOE_UK_CURVE: "capture-boe-official.ts",
  MOF_JAPAN_CURVE: "capture-japan-mof-official.ts",
};

async function json<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")); }
async function atomic(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}
function runScript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", path.resolve("scripts", "data", "government-yield", script)], {
      cwd: process.cwd(), env: { ...process.env, GOVERNMENT_YIELD_RUNTIME_ROOT: ROOT, GOVERNMENT_YIELD_US_START_YEAR: String(new Date().getUTCFullYear()) }, stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`ADAPTER_EXIT_${code}`)));
  });
}
async function runAdapter(scope: ScopeId): Promise<void> {
  await runScript(adapter[scope]);
  if (scope === "BOE_UK_CURVE") await runScript("normalize-boe-official.ts");
}
async function sourceRows(scope: ScopeId): Promise<Row[]> {
  const files = scope === "US_TREASURY_CURVE"
    ? [path.join(ROOT, "us-treasury", "normalized", `${new Date().getUTCFullYear()}-nominal.json`), path.join(ROOT, "us-treasury", "normalized", `${new Date().getUTCFullYear()}-real.json`)]
    : scope === "ECB_EURO_AREA_CURVE"
      ? (await import("node:fs/promises")).readdir(path.join(ROOT, "ecb-euro-area", "normalized")).then((names) => names.filter((name) => name.endsWith(".json")).map((name) => path.join(ROOT, "ecb-euro-area", "normalized", name)))
      : scope === "MOF_JAPAN_CURVE" ? [path.join(ROOT, "japan-mof", "normalized", "observations.json")]
        : scope === "BOE_UK_CURVE" ? [path.join(ROOT, "bank-of-england", "normalized", "observations.json")] : [];
  const rows: Row[] = [];
  for (const file of await files) {
    const document = await json<{ rows: Row[] }>(file);
    for (const row of document.rows) rows.push(row);
  }
  const latest = new Map<string, Row>();
  for (const row of rows) if (!latest.has(row.seriesId) || row.observationDate > latest.get(row.seriesId)!.observationDate) latest.set(row.seriesId, row);
  return [...latest.values()];
}
async function main(): Promise<void> {
  await mkdir(INCREMENTAL, { recursive: true });
  let checkpoint: { updatedAt: string | null; scopes: Partial<Record<ScopeId, ScopeState>> } = { updatedAt: null, scopes: {} };
  try { checkpoint = await json(CHECKPOINT); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const selected = requested ? [requested] : SCOPES;
  for (const [index, scope] of selected.entries()) {
    const prior = checkpoint.scopes[scope];
    const nextScope = selected[index + 1] ?? null;
    const lastAttempt = prior?.lastAttempt ?? prior?.lastSuccessfulRun;
    if (!force && lastAttempt && Date.now() - Date.parse(lastAttempt) < frequencyHours[scope] * 3_600_000) {
      checkpoint.scopes[scope] = { ...prior, status: prior.status.startsWith("FAILED") ? "FAILED_ISOLATED_BACKOFF" : "SKIP_CURRENT", action: prior.status.startsWith("FAILED") ? "BOUNDED_RETRY_BACKOFF" : "SKIP_CURRENT", nextScope };
      checkpoint.updatedAt = new Date().toISOString(); await atomic(CHECKPOINT, checkpoint); continue;
    }
    try {
      await runAdapter(scope);
      const rows = await sourceRows(scope);
      if (!rows.length) throw new Error(scope === "BOE_UK_CURVE" ? "SOURCE_ADAPTER_PARSE_PENDING" : "PARSE_FAILURE:NO_OBSERVATIONS");
      const document = await json<{ generatedAt: string; rows: Row[] }>(LATEST);
      const byIdentity = new Map(document.rows.map((row) => [row.seriesId, row]));
      let writes = 0;
      for (const row of rows) {
        const current = byIdentity.get(row.seriesId);
        if (!current || row.observationDate > current.observationDate || (row.observationDate === current.observationDate && row.value !== current.value)) { byIdentity.set(row.seriesId, row); writes++; }
      }
      if (writes) await atomic(LATEST, { generatedAt: new Date().toISOString(), rows: [...byIdentity.values()].sort((a, b) => a.seriesId.localeCompare(b.seriesId)) });
      const readBack = await json<{ rows: Row[] }>(LATEST);
      if (!rows.every((row) => readBack.rows.some((saved) => saved.seriesId === row.seriesId && saved.observationDate >= row.observationDate))) throw new Error("CANONICAL_READ_BACK_FAILED");
      const lastSource = rows.map((row) => row.observationDate).sort().at(-1)!;
      const canonical = readBack.rows.filter((row) => rows.some((source) => source.seriesId === row.seriesId)).map((row) => row.observationDate).sort().at(-1) ?? null;
      const successfulAt = new Date().toISOString();
      checkpoint.scopes[scope] = { scope, lastSourceObservation: lastSource, lastCanonicalObservation: canonical, lastSuccessfulRun: successfulAt, lastAttempt: successfulAt, status: writes ? "CURRENT" : "HEALTHY_WAITING", nextScope, action: writes ? "CANONICAL_WRITE" : "NO_OP_CURRENT" };
      checkpoint.updatedAt = new Date().toISOString(); await atomic(CHECKPOINT, checkpoint);
      console.log(JSON.stringify({ scope, fetch: "PASS", parse: "PASS", identity: "PASS", action: writes ? "CANONICAL_WRITE" : "NO_OP_CURRENT", readBack: "PASS", observation: lastSource, series: rows.length }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendFile(FAILURES, `${JSON.stringify({ at: new Date().toISOString(), scope, source: adapter[scope], observation: prior?.lastSourceObservation ?? null, error: message })}\n`);
      checkpoint.scopes[scope] = { scope, lastSourceObservation: prior?.lastSourceObservation ?? null, lastCanonicalObservation: prior?.lastCanonicalObservation ?? null, lastSuccessfulRun: prior?.lastSuccessfulRun ?? null, lastAttempt: new Date().toISOString(), status: "FAILED_ISOLATED", nextScope };
      checkpoint.updatedAt = new Date().toISOString(); await atomic(CHECKPOINT, checkpoint);
      console.error(JSON.stringify({ scope, status: "FAILED_ISOLATED", error: message }));
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
