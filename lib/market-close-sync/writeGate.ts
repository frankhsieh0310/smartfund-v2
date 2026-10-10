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

// Task W6: diagnostic-only, logged into every run's details so a live run log can answer "did this
// invocation actually read the env var as exactly 'on', and which deployment was it running on" —
// the two questions that were otherwise unanswerable from outside after Task W5 saw two consecutive
// invocations report SHADOW right after MARKET_CLOSE_SYNC_WRITE=on was added and redeployed. Never
// logs the raw env value itself (nothing to hide here since it's either "on" or absent, but the
// point of this function is a boolean/categorical read, not an echo).
export type WriteEnvDiagnostic = {
  readExactlyOn: boolean; // isWriteEnabled()'s own result, restated for visibility in run log JSON
  envVarPresent: boolean; // true if MARKET_CLOSE_SYNC_WRITE is set to ANYTHING, even a near-miss value
  deploymentId: string | null; // Vercel's own VERCEL_DEPLOYMENT_ID for this invocation, if running on Vercel
  deploymentUrl: string | null; // VERCEL_URL — the deployment this specific invocation is executing on
};

export function writeEnvDiagnostic(): WriteEnvDiagnostic {
  return {
    readExactlyOn: isWriteEnabled(),
    envVarPresent: process.env.MARKET_CLOSE_SYNC_WRITE !== undefined,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
    deploymentUrl: process.env.VERCEL_URL ?? null,
  };
}
