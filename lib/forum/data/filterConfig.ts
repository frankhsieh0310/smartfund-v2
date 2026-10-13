// Loads the forum content-filter configuration. Production config path is still TBD (see
// docs/specs/paid-member-forum-spec.md § 5 / § 12) — for now this reads the reviewed draft directly,
// which is explicitly NOT meant to be the permanent arrangement. Swap this for whatever storage the
// user approves (e.g. a DB table so it's hot-reloadable without a deploy) once that decision is made.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FilterConfig, StockDirectory } from "../filter/types";

let cachedConfig: FilterConfig | null = null;

export function loadFilterConfig(): FilterConfig {
  if (!cachedConfig) {
    const raw = readFileSync(join(process.cwd(), "docs/specs/forum-filter-terms.draft.json"), "utf-8");
    cachedConfig = JSON.parse(raw) as FilterConfig;
  }
  return cachedConfig;
}

/**
 * Stock code/name directory used by the stock-trading-advice rule. No real-time directory exists yet
 * (pending decision — see spec § 12); this is an intentionally small placeholder so the rule has
 * *something* to match against rather than silently matching nothing.
 */
export function loadStockDirectory(): StockDirectory {
  return { codes: [], names: [] };
}
