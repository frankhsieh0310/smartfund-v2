// Workflow steps for the ingestion orchestration PoC.
//
// Each step is a retry/durability unit. It self-calls a deployed cloud ingestion endpoint with the
// project's own CRON_SECRET (read at runtime — no external secret sync). The endpoint owns the
// business cursor + idempotency, so re-running a step is safe.

const PRODUCTION_BASE =
  process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "https://smartfund-v2.vercel.app";

async function callCron(path: string): Promise<unknown> {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error("CRON_SECRET_MISSING");
  const res = await fetch(`${PRODUCTION_BASE}${path}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(290_000),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`CRON_HTTP_${res.status}:${JSON.stringify(body).slice(0, 240)}`);
  return body;
}

export async function runCronStep(label: string, path: string): Promise<unknown> {
  "use step";
  const started = Date.now();
  const body = await callCron(path);
  return { label, path, runtimeMs: Date.now() - started, body };
}

/**
 * Controlled transient-error step for the retry PoC (STEP 5). It fails the first time it is invoked
 * for a given `token` (before `token + 15s`), then succeeds on the SDK's automatic retry after
 * backoff. No external service is touched. `token` is passed from the workflow so the check is
 * stable across the durable replay of the orchestrator.
 */
export async function transientRetryStep(token: number): Promise<{ token: number; attemptAtMs: number; ok: true }> {
  "use step";
  const now = Date.now();
  if (now < token + 15_000) {
    const err = new Error("TRANSIENT_RETRY_PROBE");
    (err as Error & { retryable?: boolean }).retryable = true;
    throw err;
  }
  return { token, attemptAtMs: now, ok: true };
}
