// Task P: the ONLY place that decides whether market-close-sync is allowed to write anything at
// all. Default is OFF — anything other than the exact string "on" (unset, "true", "1", "On", a typo)
// keeps the pipeline in shadow mode, matching every prior task's behavior unchanged.

export function isWriteEnabled(): boolean {
  return process.env.MARKET_CLOSE_SYNC_WRITE === "on";
}

export type RunMode = "SHADOW" | "WRITE";

export function currentRunMode(): RunMode {
  return isWriteEnabled() ? "WRITE" : "SHADOW";
}
