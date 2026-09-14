// SmartMatch 共識雷達 — AI Gateway health probe + state (Phase 4, STEP 3).
//
// One cheap probe per workflow cycle. State is kept in consensus_meta (key 'ai_health') so a
// cycle that ran a probe <PROBE_TTL_MIN ago just reads it instead of hammering the Gateway again.
//
//   READY            -> classification + backlog drain may proceed
//   BILLING_BLOCKED  -> customer_verification_required (needs a payment method on the Vercel team)
//   RATE_LIMITED     -> 429 from the Gateway
//   ERROR            -> other transient failure
//   UNKNOWN          -> no credential configured / never probed

import { generateText, gateway } from "ai";
import { DEFAULT_EXTRACTION_MODEL } from "./extractionContract";

export type AiGatewayStatus = "READY" | "BILLING_BLOCKED" | "RATE_LIMITED" | "ERROR" | "UNKNOWN";
export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;

export type AiHealthState = {
  status: AiGatewayStatus;
  detail: string | null;
  probed_at: string | null;
  last_success_at: string | null;
};

const PROBE_TTL_MIN = 25;

export async function readAiHealth(query: QueryFn): Promise<AiHealthState> {
  const rows = await query<{ value: AiHealthState }>(
    `select value from consensus_meta where key = 'ai_health' limit 1`, [],
  );
  return (
    rows[0]?.value ?? { status: "UNKNOWN", detail: null, probed_at: null, last_success_at: null }
  );
}

async function writeAiHealth(query: QueryFn, next: AiHealthState): Promise<void> {
  await query(
    `insert into consensus_meta (key, value, updated_at) values ('ai_health', $1::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(next)],
  );
}

function classifyGatewayError(msg: string): AiGatewayStatus {
  if (/credit card|customer_verification|customer verification|billing|payment method|verification required/i.test(msg)) return "BILLING_BLOCKED";
  if (/\b429\b|rate.?limit|too many requests/i.test(msg)) return "RATE_LIMITED";
  return "ERROR";
}

// Runs an actual ~1-token generation. Cheap; only invoked once per cycle (see maybeProbe).
export async function probeAiGateway(): Promise<{ status: AiGatewayStatus; detail: string | null }> {
  if (!process.env.VERCEL_OIDC_TOKEN && !process.env.AI_GATEWAY_API_KEY) {
    return { status: "UNKNOWN", detail: "no AI Gateway credential (VERCEL_OIDC_TOKEN / AI_GATEWAY_API_KEY)" };
  }
  try {
    const { text } = await generateText({
      model: gateway(DEFAULT_EXTRACTION_MODEL),
      prompt: "Reply with the single word: ok",
      maxOutputTokens: 5,
      temperature: 0,
    });
    return text.toLowerCase().includes("ok")
      ? { status: "READY", detail: null }
      : { status: "READY", detail: `unexpected probe reply: ${text.slice(0, 40)}` };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    return { status: classifyGatewayError(msg), detail: msg.slice(0, 240) };
  }
}

// Read cached state; re-probe only if stale or forced. Persists the new state.
export async function maybeProbe(query: QueryFn, opts: { force?: boolean } = {}): Promise<AiHealthState> {
  const current = await readAiHealth(query);
  const ageMin = current.probed_at ? (Date.now() - Date.parse(current.probed_at)) / 60_000 : Infinity;
  if (!opts.force && ageMin < PROBE_TTL_MIN && current.status !== "UNKNOWN") return current;

  const probe = await probeAiGateway();
  const nowIso = new Date().toISOString();
  const next: AiHealthState = {
    status: probe.status,
    detail: probe.detail,
    probed_at: nowIso,
    last_success_at: probe.status === "READY" ? nowIso : current.last_success_at,
  };
  await writeAiHealth(query, next);
  return next;
}

// Count of successful model calls made today (each classify writes a consensus_ai_cache row).
export async function aiCallsToday(query: QueryFn): Promise<number> {
  const rows = await query<{ c: number }>(
    `select count(*)::int c from consensus_ai_cache where created_at >= date_trunc('day', now())`, [],
  );
  return Number(rows[0]?.c ?? 0);
}
