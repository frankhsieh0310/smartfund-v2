export function isWriteEnabled(): boolean {
  return process.env.DOMESTIC_DIVIDEND_SYNC_WRITE === "on";
}

export function currentRunMode(): "WRITE" | "SHADOW" {
  return isWriteEnabled() ? "WRITE" : "SHADOW";
}
