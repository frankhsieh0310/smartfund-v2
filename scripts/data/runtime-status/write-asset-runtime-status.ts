import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type AssetRunState = "RUNNING" | "SCHEDULED_WAIT" | "BLOCKED" | "STALLED" | "UNEXPECTED_STOP" | "COMPLETE";
export type AssetRuntimeStatus = Record<string, unknown> & { ASSET: string; RUN_STATE: AssetRunState };

const sleep = (ms: number) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const windowsBusy = (error: unknown) => error instanceof Error && ["EPERM", "EACCES", "EBUSY"].includes(String((error as NodeJS.ErrnoException).code));
async function retryRename(from: string, to: string) {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await rename(from, to); return; } catch (error) {
      last = error;
      if (!windowsBusy(error)) throw error;
      await sleep(25 * (attempt + 1));
    }
  }
  throw last;
}

const statusPath = (asset: string) => resolve("runtime-status", `${asset.toLowerCase().replaceAll("_", "-")}.json`);

export async function writeAssetRuntimeStatus(asset: string, patch: Partial<AssetRuntimeStatus>) {
  const file = statusPath(asset);
  const prior = await readFile(file, "utf8").then((value) => JSON.parse(value)).catch(() => ({}));
  const status = {
    ASSET: asset.toUpperCase(), CURRENT_PHASE: null, CURRENT_LAYER: null, CURRENT_TASK: null,
    CURRENT_MARKET: null, CURRENT_SOURCE: null, PROCESSED: 0, TOTAL: null, COVERAGE: null,
    RUN_STATE: "SCHEDULED_WAIT", PROCESS_ID: null, HEARTBEAT_AT: null, LAST_PROGRESS_AT: null,
    LAST_PROGRESS: null, CHECKPOINT: null, BLOCKER: null, NEXT: null, NEXT_RUN_AT: null,
    NAV_STATUS: null, HOLDINGS_STATUS: null, QUOTE_STATUS: "NOT_APPLICABLE", CONTINUING: "YES",
    ...prior, ...patch, ASSET: asset.toUpperCase(),
  };
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${file}.${process.pid}.${Date.now()}.bak`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  try { await retryRename(temporary, file); } catch (error) {
    if (!windowsBusy(error)) throw error;
    let moved = false;
    try {
      await retryRename(file, backup); moved = true;
      await retryRename(temporary, file);
      await rm(backup, { force: true });
    } catch (replacementError) {
      if (moved) await retryRename(backup, file).catch(() => undefined);
      throw replacementError;
    }
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  return status;
}
