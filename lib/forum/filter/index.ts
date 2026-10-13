import type { FilterConfig, FilterVerdict, StockDirectory } from "./types.ts";
import { runAllRules } from "./rules.ts";

export type { FilterConfig, FilterVerdict, FilterReason, FilterAction, FilterCategory, StockDirectory } from "./types.ts";
export { normalizeText, normalizeForLinks } from "./normalize.ts";

/**
 * Runs the forum content filter against a post/edit body and returns a verdict.
 * BLOCK must reject the write entirely; NOTIFY must still let the write through but alert an admin
 * (see spec section 5/6 — same-user repeat-NOTIFY-or-BLOCK-attempt thresholds are enforced by the
 * caller using FilterConfig's thresholds, not by this function).
 */
export function runForumFilter(
  rawText: string,
  config: FilterConfig,
  directory: StockDirectory,
): FilterVerdict {
  const reasons = runAllRules(rawText, config, directory);

  if (reasons.some((r) => r.action === "BLOCK")) {
    return { action: "BLOCK", reasons: reasons.filter((r) => r.action === "BLOCK") };
  }
  if (reasons.length > 0) {
    return { action: "NOTIFY", reasons };
  }
  return { action: "ALLOW", reasons: [] };
}
