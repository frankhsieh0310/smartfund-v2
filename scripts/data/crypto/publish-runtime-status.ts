import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { writeAssetRuntimeStatus, type AssetRunState } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";

const root = process.cwd();
const readJson = async <T>(file: string, fallback: T) => readFile(file, "utf8").then(text => JSON.parse(text.replace(/^\uFEFF/, "")) as T).catch(() => fallback);

async function main() {
  const manifest = await readJson<{ pid?: number; status?: string; stage?: string; nextRunAt?: string; consecutiveFailures?: number; lastCycleFinishedAt?: string }>(resolve(root, "runtime/crypto/completion-manifest.json"), {});
  const heartbeat = await readJson<{ pid?: number; status?: string; stage?: string; heartbeatAt?: string; nextRunAt?: string }>(resolve(root, "runtime/crypto/heartbeat.json"), {});
  const previous = await readJson<{ LAST_PROGRESS?: string; LAST_PROGRESS_AT?: string; BLOCKER?: string | null }>(resolve(root, "runtime-status/crypto.json"), {});
  const requested = process.argv.find(value => value.startsWith("--state="))?.slice(8) as AssetRunState | undefined;
  const requestedBlocker = process.argv.find(value => value.startsWith("--blocker="))?.slice(10) ?? null;
  const runState: AssetRunState = requested ?? (heartbeat.status === "RUNNING" ? "RUNNING" : manifest.nextRunAt ? "SCHEDULED_WAIT" : "UNEXPECTED_STOP");
  await writeAssetRuntimeStatus({
    ASSET: "CRYPTO", CURRENT_PHASE: "CONTINUOUS_COMPLETION", CURRENT_LAYER: runState === "RUNNING" ? "Scheduler" : "Scheduler Wait", CURRENT_TASK: "Scheduler",
    CURRENT_MARKET: null, CURRENT_ASSET: null, CURRENT_PAIR: null, CURRENT_EXCHANGE: null, CURRENT_CHAIN: null, CURRENT_SOURCE: "EXISTING_CRYPTO_PIPELINE",
    PROCESSED: 0, TOTAL: null, COVERAGE: null, RUN_STATE: runState, PROCESS_ID: heartbeat.pid ?? manifest.pid ?? null, HEARTBEAT_AT: heartbeat.heartbeatAt,
    LAST_PROGRESS_AT: previous.LAST_PROGRESS_AT ?? manifest.lastCycleFinishedAt ?? null, LAST_PROGRESS: previous.LAST_PROGRESS ?? null, CHECKPOINT: heartbeat.stage ?? manifest.stage ?? null,
    BLOCKER: runState === "RUNNING" ? null : requestedBlocker ?? previous.BLOCKER ?? null, NEXT: "Resume existing checkpointed Crypto completion queue", NEXT_RUN_AT: heartbeat.nextRunAt ?? manifest.nextRunAt ?? null,
    PRICE_STATUS: "PRODUCTION", DERIVATIVES_STATUS: "BUILDING", ONCHAIN_STATUS: "AUTO_CONTINUING", QUOTE_STATUS: "NOT_READY", CONTINUING: "YES", progressChanged: false,
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
