import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type AssetRunState, writeAssetRuntimeStatus } from "./writeAssetRuntimeStatus.ts";

type MacroStatusUpdate = {
  CURRENT_PHASE: string;
  CURRENT_LAYER: string;
  CURRENT_TASK: string;
  CURRENT_COUNTRY?: string | null;
  CURRENT_INDICATOR?: string | null;
  CURRENT_SERIES?: string | null;
  CURRENT_SOURCE?: string | null;
  PROCESSED?: number;
  TOTAL?: number | null;
  COVERAGE?: string | null;
  RUN_STATE: AssetRunState;
  PROCESS_ID?: number | null;
  HEARTBEAT_AT?: string;
  LAST_PROGRESS_AT?: string | null;
  LAST_PROGRESS?: string | null;
  CHECKPOINT?: string | null;
  BLOCKER?: string | null;
  NEXT?: string | null;
  NEXT_RUN_AT?: string | null;
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
  CURRENT_COUNTRY_GAP?: string | null;
  CURRENT_SERIES_GAP?: string | null;
  GAPS_COMPLETED?: number | null;
  LAST_GAP_PROGRESS?: string | null;
  GAP_QUEUE_STATUS?: string | null;
  CONTINUING?: "YES" | "NO";
  progressChanged?: boolean;
};

type Previous = Partial<MacroStatusUpdate>;
const select = <T>(next: T | undefined, prior: T | undefined, fallback: T): T => next !== undefined ? next : prior !== undefined ? prior : fallback;

export async function writeMacroRuntimeStatus(update: MacroStatusUpdate): Promise<void> {
  const file = resolve(process.cwd(), "runtime-status", "macro.json");
  const previous: Previous = await readFile(file, "utf8").then(value => JSON.parse(value) as Previous).catch(() => ({} as Previous));
  await writeAssetRuntimeStatus({
    ASSET: "MACRO",
    CURRENT_PHASE: update.CURRENT_PHASE,
    CURRENT_LAYER: update.CURRENT_LAYER,
    CURRENT_TASK: update.CURRENT_TASK,
    CURRENT_MARKET: select(update.CURRENT_COUNTRY, previous.CURRENT_COUNTRY, null),
    CURRENT_INDEX_FAMILY: select(update.CURRENT_SERIES, previous.CURRENT_SERIES, null),
    CURRENT_COUNTRY: select(update.CURRENT_COUNTRY, previous.CURRENT_COUNTRY, null),
    CURRENT_INDICATOR: select(update.CURRENT_INDICATOR, previous.CURRENT_INDICATOR, null),
    CURRENT_SERIES: select(update.CURRENT_SERIES, previous.CURRENT_SERIES, null),
    CURRENT_SOURCE: select(update.CURRENT_SOURCE, previous.CURRENT_SOURCE, null),
    PROCESSED: select(update.PROCESSED, previous.PROCESSED, 0),
    TOTAL: select(update.TOTAL, previous.TOTAL, null),
    COVERAGE: select(update.COVERAGE, previous.COVERAGE, null),
    RUN_STATE: update.RUN_STATE,
    PROCESS_ID: select(update.PROCESS_ID, previous.PROCESS_ID, null),
    HEARTBEAT_AT: update.HEARTBEAT_AT,
    LAST_PROGRESS_AT: update.LAST_PROGRESS_AT,
    LAST_PROGRESS: update.LAST_PROGRESS,
    CHECKPOINT: select(update.CHECKPOINT, previous.CHECKPOINT, null),
    BLOCKER: select(update.BLOCKER, previous.BLOCKER, null),
    NEXT: select(update.NEXT, previous.NEXT, null),
    NEXT_RUN_AT: select(update.NEXT_RUN_AT, previous.NEXT_RUN_AT, null),
    QUOTE_STATUS: "NOT_READY",
    LATEST_RELEASE_STATUS: select(update.LATEST_RELEASE_STATUS, previous.LATEST_RELEASE_STATUS, null),
    VINTAGE_STATUS: select(update.VINTAGE_STATUS, previous.VINTAGE_STATUS, null),
    DEPTH_AUDIT_STATUS: select(update.DEPTH_AUDIT_STATUS, previous.DEPTH_AUDIT_STATUS, null),
    DEPTH_GAPS_TOTAL: select(update.DEPTH_GAPS_TOTAL, previous.DEPTH_GAPS_TOTAL, null),
    DEPTH_GAPS_P0: select(update.DEPTH_GAPS_P0, previous.DEPTH_GAPS_P0, null),
    DEPTH_GAPS_P1: select(update.DEPTH_GAPS_P1, previous.DEPTH_GAPS_P1, null),
    DEPTH_GAPS_P2: select(update.DEPTH_GAPS_P2, previous.DEPTH_GAPS_P2, null),
    DEPTH_GAPS_P3: select(update.DEPTH_GAPS_P3, previous.DEPTH_GAPS_P3, null),
    DETERMINISTIC_GAPS_TOTAL: select(update.DETERMINISTIC_GAPS_TOTAL, previous.DETERMINISTIC_GAPS_TOTAL, null),
    BLOCKED_GAPS_TOTAL: select(update.BLOCKED_GAPS_TOTAL, previous.BLOCKED_GAPS_TOTAL, null),
    CURRENT_GAP_ID: select(update.CURRENT_GAP_ID, previous.CURRENT_GAP_ID, null),
    CURRENT_GAP_DOMAIN: select(update.CURRENT_GAP_DOMAIN, previous.CURRENT_GAP_DOMAIN, null),
    CURRENT_COUNTRY_GAP: select(update.CURRENT_COUNTRY_GAP, previous.CURRENT_COUNTRY_GAP, null),
    CURRENT_SERIES_GAP: select(update.CURRENT_SERIES_GAP, previous.CURRENT_SERIES_GAP, null),
    GAPS_COMPLETED: select(update.GAPS_COMPLETED, previous.GAPS_COMPLETED, null),
    LAST_GAP_PROGRESS: select(update.LAST_GAP_PROGRESS, previous.LAST_GAP_PROGRESS, null),
    GAP_QUEUE_STATUS: select(update.GAP_QUEUE_STATUS, previous.GAP_QUEUE_STATUS, null),
    CONTINUING: select(update.CONTINUING, previous.CONTINUING, "YES"),
    progressChanged: update.progressChanged,
  });
}
