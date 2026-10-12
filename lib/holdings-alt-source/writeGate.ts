// Same shadow-mode-by-default convention as domestic-dividend-sync/offshore-dividend-sync: writes
// nothing unless the exact env var is "on". Default is read-only/dry-run, matching this task's
// "預設影子模式、需要寫入開關才會寫入" requirement.
export function isWriteEnabled(): boolean {
  return process.env.HOLDINGS_ALT_SOURCE_WRITE === "on";
}

export function currentRunMode(): "WRITE" | "SHADOW" {
  return isWriteEnabled() ? "WRITE" : "SHADOW";
}
