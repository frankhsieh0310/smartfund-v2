// Canonical diff key for holdings that carry no security id / code. Different disclosure sources spell
// the same issuer differently ("TransDigm" vs "TransDigm, Inc. 7.125%"), which made two periods share no
// keys. Applied ONLY when the key would otherwise be the raw holding name.

const CORPORATE_TOKENS = new Set([
  "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "llc", "plc", "lp",
  "sa", "ag", "nv", "holdings", "holding", "group",
]);

export function normalizeHoldingName(name: string): string {
  const tokens = name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+\d+(?:\.\d+)?\s*%.*$/, "") // trailing coupon, e.g. " 5.375%"
    .replace(/[.,;:()'"\/]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && CORPORATE_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ") || name.trim().toLowerCase();
}

/** Keeps id-based keys untouched; name-derived keys (key === name) are normalized. */
export function canonicalHoldingKey(key: string, name: string): string {
  return key === name ? `name:${normalizeHoldingName(name)}` : key;
}

/** Collapses rows sharing a canonical key (several bonds of one issuer) by summing weight. */
export function mergeByCanonicalKey<T extends { key: string; name: string; weightPct: number }>(rows: T[]): T[] {
  const out = new Map<string, T>();
  for (const r of rows) {
    const key = canonicalHoldingKey(r.key, r.name);
    const cur = out.get(key);
    out.set(key, cur ? { ...cur, weightPct: cur.weightPct + r.weightPct } : { ...r, key });
  }
  return [...out.values()];
}

/**
 * Re-keys a product's positions on the normalized holding NAME and merges same-name rows inside that one
 * product (e.g. two share classes of one issuer). Lets ticker-keyed ETFs and name-keyed funds be
 * aggregated together without a product ever appearing as its own overlap partner.
 */
export function rekeyByNormalizedName<T extends { name: string; weightPct: number }>(holdings: T[]): Array<{ key: string; name: string; weightPct: number }> {
  const byName = new Map<string, { key: string; name: string; weightPct: number }>();
  for (const h of holdings) {
    const key = normalizeHoldingName(h.name);
    const cur = byName.get(key);
    if (cur) cur.weightPct += h.weightPct;
    else byName.set(key, { key, name: h.name, weightPct: h.weightPct });
  }
  return [...byName.values()];
}
