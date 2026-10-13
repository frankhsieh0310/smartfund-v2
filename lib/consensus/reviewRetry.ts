// SmartMatch 共識雷達 — deterministic retry eligibility for NEEDS_REVIEW events (Phase 4, STEP 2).
//
// Uses the existing columns: extraction_status='NEEDS_REVIEW' + needs_review_reason (free text) +
// extraction_version. No schema rename.
//
//   RETRYABLE      : never attempted, gateway billing/verification, 429/5xx/timeout, transient,
//                    schema-invalid (retry once when model / extraction_version has advanced)
//   NOT RETRYABLE  : attribution conflict, manual reject, source removed / invalid, hard schema
//                    reject after the extraction_version already matches current

import { EXTRACTION_VERSION } from "./extractionContract";

const BILLING = /credit card|customer_verification|customer verification|billing|payment method|insufficient (funds|credit)|verification required/i;
const TRANSIENT = /\b(429|rate.?limit|5\d\d|server error|timeout|timed out|etimedout|econnreset|econnrefused|fetch failed|network|temporarily|unavailable|no valid object|no json|model produced no)/i;
const SCHEMA = /schema:|invalid schema|schema invalid|zod/i;
const HARD = /attribution|multiple (attributed|qualifying|named) speaker|manual[_ ]?reject|source (removed|invalid|deleted)|rejected by reviewer|not a market/i;

export type RetryVerdict = "RETRYABLE" | "NOT_RETRYABLE";

export function isRetryableReview(reason: string | null | undefined, eventExtractionVersion?: string | null): RetryVerdict {
  const r = (reason ?? "").trim();
  if (!r) return "RETRYABLE"; // stored without a reason == never classified
  if (HARD.test(r)) return "NOT_RETRYABLE";
  if (BILLING.test(r) || TRANSIENT.test(r)) return "RETRYABLE";
  if (SCHEMA.test(r)) {
    // only worth another shot once the extraction contract / model has moved on
    return eventExtractionVersion && eventExtractionVersion === EXTRACTION_VERSION ? "NOT_RETRYABLE" : "RETRYABLE";
  }
  // unknown reason -> treat as transient and let the batch cap bound the cost
  return "RETRYABLE";
}

// SQL predicate mirror (for counting the backlog without pulling every row into JS).
export const RETRYABLE_SQL = `(
  needs_review_reason is null
  or needs_review_reason = ''
  or (
    needs_review_reason !~* 'attribution|multiple (attributed|qualifying|named) speaker|manual[_ ]?reject|source (removed|invalid|deleted)|rejected by reviewer|not a market'
    and (
      needs_review_reason ~* 'credit card|customer_verification|customer verification|billing|payment method|verification required|429|rate.?limit|5[0-9][0-9]|server error|timeout|timed out|etimedout|econnreset|econnrefused|fetch failed|network|temporarily|unavailable|no valid object|no json|model produced no'
      or (needs_review_reason ~* 'schema:|invalid schema|schema invalid|zod' and coalesce(extraction_version,'') <> $EXV$)
      or needs_review_reason !~* 'schema:|invalid schema|schema invalid|zod'
    )
  )
)`;

export function retryableSql(): string {
  return RETRYABLE_SQL.replace("$EXV$", `'${EXTRACTION_VERSION}'`);
}
