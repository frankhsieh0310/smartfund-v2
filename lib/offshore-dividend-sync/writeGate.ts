export function isWriteEnabled(): boolean {
  return process.env.OFFSHORE_DIVIDEND_SYNC_WRITE === "on";
}

export function currentRunMode(): "WRITE" | "SHADOW" {
  return isWriteEnabled() ? "WRITE" : "SHADOW";
}
