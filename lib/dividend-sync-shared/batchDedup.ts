// Shared within-batch dedup for domestic-dividend-sync and offshore-dividend-sync writers. Root cause
// (confirmed live against SITCA's own source, 2026-10-13): SITCA's monthly table can list the same
// fund+exDate twice with IDENTICAL amount (payDate off by a day -- looks like an upstream republish),
// and separately, exDate is NOT always unique per fund -- two genuinely independent distribution events
// (different baseDate month, different payDate, different amount) can coincidentally share an exDate
// (confirmed for 88315292B/D, 2024-03). The existing SELECT-existing-then-filter dedup only catches
// candidates against rows ALREADY in the DB -- it does nothing for two colliding rows arriving in the
// SAME batch, which is exactly the SITCA-republish case. This module groups a batch by (fundId, exDate)
// before that DB check runs: same-amount groups collapse to one (keep the last -- the later position in
// SITCA's own listing order is the more-recently-published row), differing-amount groups are excluded
// entirely and reported as conflicts (no heuristic "pick the right one" -- both can be independently
// real, as 88315292B/D proved, so forcing a choice would silently write wrong data).
export type DedupKey = { fundId: string; exDate: string; amount: number };

export type DedupConflict = { fundId: string; exDate: string; amounts: number[]; count: number };

export type DedupResult<T> = {
  toWrite: T[];
  conflicts: DedupConflict[];
  duplicatesCollapsed: number;
};

export function dedupBatchByFundExDate<T>(candidates: T[], keyOf: (c: T) => DedupKey): DedupResult<T> {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const c of candidates) {
    const { fundId, exDate } = keyOf(c);
    const key = `${fundId}::${exDate}`;
    const arr = groups.get(key);
    if (arr) {
      arr.push(c);
    } else {
      groups.set(key, [c]);
      order.push(key);
    }
  }

  const toWrite: T[] = [];
  const conflicts: DedupConflict[] = [];
  let duplicatesCollapsed = 0;

  for (const key of order) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      toWrite.push(group[0]);
      continue;
    }
    const amounts = group.map((g) => keyOf(g).amount);
    const uniqueAmounts = [...new Set(amounts)];
    if (uniqueAmounts.length === 1) {
      toWrite.push(group[group.length - 1]);
      duplicatesCollapsed += group.length - 1;
    } else {
      const { fundId, exDate } = keyOf(group[0]);
      conflicts.push({ fundId, exDate, amounts: uniqueAmounts, count: group.length });
    }
  }

  return { toWrite, conflicts, duplicatesCollapsed };
}

// Postgres error code 42P10: "no unique or exclusion constraint matching the ON CONFLICT specification".
// Thrown when the ON CONFLICT target doesn't (yet) have a matching index -- expected until Stage 2's
// CREATE UNIQUE INDEX CONCURRENTLY lands. Callers fall back to a plain INSERT (no ON CONFLICT clause) so
// writes keep working correctly before that index exists, per the user's explicit requirement.
export function isMissingUniqueConstraintError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "42P10") return true;
  const msg = String((e as { message?: unknown } | null)?.message ?? e ?? "");
  return msg.includes("no unique or exclusion constraint matching the ON CONFLICT specification");
}
