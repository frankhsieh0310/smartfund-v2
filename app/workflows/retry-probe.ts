// Retry PoC workflow (STEP 5). Runs the controlled transient-error step once; the SDK auto-retries
// it after backoff and it then succeeds. Produces step_created -> step_started -> step_retrying ->
// step_completed in the Workflow observability trace. Touches no external service.

import { transientRetryStep } from "./ingestion-steps";

export async function retryProbeWorkflow() {
  "use workflow";
  const token = Date.now();
  const result = await transientRetryStep(token);
  return { token, result, completedAt: new Date().toISOString() };
}
