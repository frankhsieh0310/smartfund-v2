import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { orchestratorStates, type OrchestratorState } from "../../../lib/data-platform/orchestrator/types.ts";

const root = process.cwd();
const debug = join(root, "debug", "data-009-orchestrator");
const config = JSON.parse(await readFile(join(root, "config", "data-orchestrator.json"), "utf8")) as { providers: Array<{ id: string; provider: string; assetType: string; mode: OrchestratorState; dailyJob: string; requiresEnv?: string[] }> };
const dailyRoot = join(root, "debug", "data-008-daily");
const readJson = async <T>(path: string): Promise<T | null> => readFile(path, "utf8").then((text) => JSON.parse(text) as T).catch(() => null);

type DailyLedger = { status?: string; lastSuccessAt?: string; healthScore?: number; retryCount?: number; recoveryCount?: number; completedAt?: string; lastError?: string };

const providers = await Promise.all(config.providers.map(async (item) => {
  const ledger = await readJson<DailyLedger>(join(dailyRoot, item.dailyJob, "daily-ledger.json"));
  const missing = item.requiresEnv?.filter((name) => !process.env[name]) ?? [];
  let state = item.mode;
  let blockReason: string | null = null;
  if (missing.length) { state = "MANUAL_ACTION_REQUIRED"; blockReason = missing.join(", "); }
  else if (ledger?.status === "COMPLETED" && item.mode === "DAILY_ACTIVE") state = "DAILY_ACTIVE";
  else if (ledger?.status === "FAILED") state = "RETRY_PENDING";
  return { ...item, state, blockReason, lastAttempt: ledger?.completedAt ?? null, lastSuccess: ledger?.lastSuccessAt ?? null, healthScore: ledger?.healthScore ?? null, retryCount: ledger?.retryCount ?? 0, recoveryCount: ledger?.recoveryCount ?? 0 };
}));

const summary = Object.fromEntries(orchestratorStates.map((state) => [state, providers.filter((provider) => provider.state === state).length]));
const output = { generatedAt: new Date().toISOString(), host: hostname(), providers, summary };
await mkdir(debug, { recursive: true });
await Promise.all([
  writeFile(join(debug, "orchestrator-status.json"), `${JSON.stringify(output, null, 2)}\n`),
  writeFile(join(debug, "orchestrator-status.md"), `# Data Orchestrator\n\n| Asset | Provider | State | Last Success | Health | Block reason |\n| --- | --- | --- | --- | ---: | --- |\n${providers.map((provider) => `| ${provider.assetType} | ${provider.provider} | ${provider.state} | ${provider.lastSuccess ?? "—"} | ${provider.healthScore ?? "—"} | ${provider.blockReason ?? "—"} |`).join("\n")}\n\n## Summary\n\n${Object.entries(summary).map(([state, count]) => `- ${state}: ${count}`).join("\n")}\n`),
]);
console.log(JSON.stringify(output, null, 2));
