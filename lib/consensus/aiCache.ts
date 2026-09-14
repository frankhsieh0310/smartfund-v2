// SmartMatch 共識雷達 — DB-backed AI extraction cache (Phase 2, STEP 3).
// Keyed by (content_hash, extraction_version, model). A statement whose text is unchanged is never
// re-sent to a model; NEEDS_REVIEW is cached too so a persistently bad item is not retried every run.

import type { CachePort, ClassifyOutcome } from "./extractionContract";

export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;

export function dbAiCache(query: QueryFn): CachePort {
  return {
    async get({ contentHash, version, model }) {
      const rows = await query<{ status: string; result: unknown; reason: string | null }>(
        `select status, result, reason from consensus_ai_cache
          where content_hash = $1 and extraction_version = $2 and model = $3 limit 1`,
        [contentHash, version, model],
      );
      const r = rows[0];
      if (!r) return null;
      if (r.status === "CLASSIFIED" && r.result) {
        return { status: "CLASSIFIED", model, version, contentHash, result: r.result as never } as ClassifyOutcome;
      }
      if (r.status === "REJECTED") return { status: "REJECTED", reason: r.reason ?? "cached", model, version, contentHash };
      return { status: "NEEDS_REVIEW", reason: r.reason ?? "cached", model, version, contentHash };
    },
    async put(value) {
      const result = value.status === "CLASSIFIED" ? JSON.stringify(value.result) : null;
      const reason = value.status === "CLASSIFIED" ? null : (value as { reason?: string }).reason ?? null;
      const usage = (value as { usage?: { promptTokens?: number; completionTokens?: number } }).usage;
      await query(
        `insert into consensus_ai_cache
           (content_hash, extraction_version, model, status, result, reason, prompt_tokens, completion_tokens)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
         on conflict (content_hash, extraction_version, model) do update set
           status = excluded.status, result = excluded.result, reason = excluded.reason,
           prompt_tokens = excluded.prompt_tokens, completion_tokens = excluded.completion_tokens`,
        [value.contentHash, value.version, value.model, value.status, result, reason,
         usage?.promptTokens ?? null, usage?.completionTokens ?? null],
      );
    },
  };
}
