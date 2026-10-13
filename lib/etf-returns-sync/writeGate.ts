// Task X: same pattern as lib/market-close-sync/writeGate.ts — default OFF, only the exact string
// "on" opens it, a near-miss value never falls open. A separate env var from market-close-sync's
// MARKET_CLOSE_SYNC_WRITE since this is a fully independent pipeline.

export function isWriteEnabled(): boolean {
  return process.env.ETF_RETURNS_SYNC_WRITE === "on";
}

export type RunMode = "SHADOW" | "WRITE";

export function currentRunMode(): RunMode {
  return isWriteEnabled() ? "WRITE" : "SHADOW";
}

export type WriteEnvDiagnostic = {
  readExactlyOn: boolean;
  envVarPresent: boolean;
  deploymentId: string | null;
  deploymentUrl: string | null;
};

export function writeEnvDiagnostic(): WriteEnvDiagnostic {
  return {
    readExactlyOn: isWriteEnabled(),
    envVarPresent: process.env.ETF_RETURNS_SYNC_WRITE !== undefined,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    deploymentUrl: process.env.VERCEL_URL ?? null,
  };
}
