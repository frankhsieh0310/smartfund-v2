export function isWriteEnabled(): boolean {
  return process.env.OFFSHORE_NAV_SYNC_WRITE === "on";
}
export function currentRunMode(): "SHADOW" | "WRITE" {
  return isWriteEnabled() ? "WRITE" : "SHADOW";
}
