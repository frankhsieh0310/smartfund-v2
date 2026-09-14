import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type AssetRunState = "RUNNING" | "SCHEDULED_WAIT" | "BLOCKED" | "STALLED" | "UNEXPECTED_STOP" | "COMPLETE";
export type AssetQuoteStatus = "NOT_READY" | "READY" | "BUILDING" | "PRODUCTION";

export type AssetRuntimeStatus = {
  ASSET: string;
  CURRENT_PHASE: string | null;
  CURRENT_LAYER: string | null;
  CURRENT_TASK: string | null;
  CURRENT_COMMODITY?: string | null;
  CURRENT_CATEGORY?: string | null;
  CURRENT_MARKET: string | null;
  CURRENT_PAIR?: string | null;
  CURRENT_ASSET?: string | null;
  CURRENT_CHAIN?: string | null;
  CURRENT_BASE_CURRENCY?: string | null;
  CURRENT_QUOTE_CURRENCY?: string | null;
  CURRENT_INDEX_FAMILY: string | null;
  CURRENT_EXCHANGE?: string | null;
  CURRENT_CONTRACT_FAMILY?: string | null;
  PROCESSED: number;
  TOTAL: number | null;
  COVERAGE: string | null;
  RUN_STATE: AssetRunState;
  PROCESS_ID: number | null;
  HEARTBEAT_AT: string;
  LAST_PROGRESS_AT: string | null;
  LAST_PROGRESS: string | null;
  CHECKPOINT: string | null;
  CURRENT_SOURCE: string | null;
  SOURCE?: string | null;
  BLOCKER: string | null;
  NEXT: string | null;
  NEXT_RUN_AT: string | null;
  QUOTE_STATUS: AssetQuoteStatus;
  PRICE_STATUS?: string | null;
  DERIVATIVES_STATUS?: string | null;
  ONCHAIN_STATUS?: string | null;
  FUNDAMENTAL_STATUS?: string | null;
  CONTINUING: "YES" | "NO";
  CURRENT_COUNTRY?: string | null;
  CURRENT_INDICATOR?: string | null;
  CURRENT_SERIES?: string | null;
  LATEST_RELEASE_STATUS?: string | null;
  VINTAGE_STATUS?: string | null;
  DEPTH_AUDIT_STATUS?: string | null;
  DEPTH_GAPS_TOTAL?: number | null;
  DEPTH_GAPS_P0?: number | null;
  DEPTH_GAPS_P1?: number | null;
  DEPTH_GAPS_P2?: number | null;
  DEPTH_GAPS_P3?: number | null;
  DETERMINISTIC_GAPS_TOTAL?: number | null;
  BLOCKED_GAPS_TOTAL?: number | null;
  CURRENT_GAP_ID?: string | null;
  CURRENT_GAP_DOMAIN?: string | null;
  CURRENT_GAP_STATE?: string | null;
  CURRENT_EXCHANGE_GAP?: string | null;
  CURRENT_CONTRACT_FAMILY_GAP?: string | null;
  CURRENT_COUNTRY_GAP?: string | null;
  CURRENT_SERIES_GAP?: string | null;
  GAPS_COMPLETED?: number | null;
  LAST_GAP_PROGRESS?: string | null;
  GAP_QUEUE_STATUS?: string | null;
  WAITING_DEPENDENCIES?: number;
  BLOCKED_GAPS?: number;
  DB_POOL_STATUS?: string | null;
  DB_POOL_STATUS?: string | null;
  POSITIONING_RECOVERY_STATUS?: string | null;
};

type StatusUpdate = Omit<AssetRuntimeStatus, "HEARTBEAT_AT" | "LAST_PROGRESS_AT" | "LAST_PROGRESS" | "CURRENT_INDEX_FAMILY" | "CURRENT_SOURCE"> & {
  HEARTBEAT_AT?: string;
  LAST_PROGRESS_AT?: string | null;
  LAST_PROGRESS?: string | null;
  CURRENT_INDEX_FAMILY?: string | null;
  CURRENT_SOURCE?: string | null;
  progressChanged?: boolean;
};

export async function writeAssetRuntimeStatus(update: StatusUpdate): Promise<void> {
  const file = resolve(process.cwd(), "runtime-status", `${update.ASSET.toLowerCase().replaceAll("_", "-")}.json`);
  const previous = await readFile(file, "utf8").then(value => JSON.parse(value) as AssetRuntimeStatus).catch(() => null);
  const heartbeatAt = update.HEARTBEAT_AT ?? new Date().toISOString();
  const progressChanged = update.progressChanged === true;
  const status: AssetRuntimeStatus = {
    ...previous,
    ...update,
    CURRENT_INDEX_FAMILY: update.CURRENT_INDEX_FAMILY ?? null,
    CURRENT_PAIR: update.CURRENT_PAIR ?? null,
    CURRENT_ASSET: update.CURRENT_ASSET ?? null,
    CURRENT_CHAIN: update.CURRENT_CHAIN ?? null,
    CURRENT_COMMODITY: update.CURRENT_COMMODITY ?? null,
    CURRENT_CATEGORY: update.CURRENT_CATEGORY ?? null,
    CURRENT_BASE_CURRENCY: update.CURRENT_BASE_CURRENCY ?? null,
    CURRENT_QUOTE_CURRENCY: update.CURRENT_QUOTE_CURRENCY ?? null,
    CURRENT_EXCHANGE: update.CURRENT_EXCHANGE ?? null,
    CURRENT_CONTRACT_FAMILY: update.CURRENT_CONTRACT_FAMILY ?? null,
    CURRENT_SOURCE: update.CURRENT_SOURCE ?? update.SOURCE ?? null,
    PRICE_STATUS: update.PRICE_STATUS ?? null,
    DERIVATIVES_STATUS: update.DERIVATIVES_STATUS ?? null,
    ONCHAIN_STATUS: update.ONCHAIN_STATUS ?? null,
    FUNDAMENTAL_STATUS: update.FUNDAMENTAL_STATUS ?? null,
    DEPTH_AUDIT_STATUS: update.DEPTH_AUDIT_STATUS ?? null,
    DEPTH_GAPS_TOTAL: update.DEPTH_GAPS_TOTAL ?? null,
    DEPTH_GAPS_P0: update.DEPTH_GAPS_P0 ?? null,
    DEPTH_GAPS_P1: update.DEPTH_GAPS_P1 ?? null,
    DEPTH_GAPS_P2: update.DEPTH_GAPS_P2 ?? null,
    DEPTH_GAPS_P3: update.DEPTH_GAPS_P3 ?? null,
    DETERMINISTIC_GAPS_TOTAL: update.DETERMINISTIC_GAPS_TOTAL ?? null,
    BLOCKED_GAPS_TOTAL: update.BLOCKED_GAPS_TOTAL ?? null,
    CURRENT_GAP_ID: update.CURRENT_GAP_ID ?? null,
    CURRENT_GAP_DOMAIN: update.CURRENT_GAP_DOMAIN ?? null,
    GAPS_COMPLETED: update.GAPS_COMPLETED ?? null,
    LAST_GAP_PROGRESS: update.LAST_GAP_PROGRESS ?? null,
    GAP_QUEUE_STATUS: update.GAP_QUEUE_STATUS ?? null,
    HEARTBEAT_AT: heartbeatAt,
    LAST_PROGRESS_AT: progressChanged ? (update.LAST_PROGRESS_AT ?? heartbeatAt) : (previous?.LAST_PROGRESS_AT ?? update.LAST_PROGRESS_AT ?? null),
    LAST_PROGRESS: progressChanged ? (update.LAST_PROGRESS ?? null) : (previous?.LAST_PROGRESS ?? update.LAST_PROGRESS ?? null),
  };
  delete (status as AssetRuntimeStatus & { progressChanged?: boolean }).progressChanged;
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`);
  await rename(temporary, file);
}
