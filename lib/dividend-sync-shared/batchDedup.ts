// Shared within-batch dedup for domestic-dividend-sync and offshore-dividend-sync writers. Root cause
// (confirmed live against SITCA's own source, 2026-10-13): SITCA's monthly table can list the same
// fund+recordDate(基準日)+exDate twice with IDENTICAL amount (payDate off by a day -- looks like an
// upstream republish). The existing SELECT-existing-then-filter dedup only catches candidates against
// rows ALREADY in the DB -- it does nothing for two colliding rows arriving in the SAME batch, which is
// exactly that case. This module groups a batch by (fundId, recordDate, exDate) before that DB check
// runs: same-key/same-amount groups collapse to one (keep the last -- the later position in SITCA's own
// listing order is the more-recently-published row), same-key/different-amount groups are excluded
// entirely and reported as conflicts (no heuristic "pick the right one").
//
// 2026-10-13 CORRECTION: the key was originally (fundId, exDate) only, on the assumption that exDate is
// unique per fund. It is NOT -- confirmed live for 88315292B/D (2024-03): two genuinely independent
// distribution events (different recordDate/baseDate month, different payDate, different amount) can
// coincidentally share the SAME exDate. Grouping by (fundId, exDate) alone misfiled that pair as a
// "conflict" and would have blocked both from writing, and the Stage-2 unique index would have
// permanently rejected the second one. recordDate (基準日, SITCA's own reporting-period anchor) is part
// of the key SITCA itself treats as distinguishing two distributions, so it must be part of ours too --
// confirmed via a live DB recheck that record_date is 0% NULL for both affected sources, so no COALESCE
// is needed.
export type DedupKey = { fundId: string; recordDate: string; exDate: string; amount: number };

export type DedupConflict = { fundId: string; recordDate: string; exDate: string; amounts: number[]; count: number };

export type DedupResult<T> = {
  toWrite: T[];
  conflicts: DedupConflict[];
  duplicatesCollapsed: number;
};

export function dedupBatchByFundRecordExDate<T>(candidates: T[], keyOf: (c: T) => DedupKey): DedupResult<T> {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const c of candidates) {
    const { fundId, recordDate, exDate } = keyOf(c);
    const key = `${fundId}::${recordDate}::${exDate}`;
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
      const { fundId, recordDate, exDate } = keyOf(group[0]);
      conflicts.push({ fundId, recordDate, exDate, amounts: uniqueAmounts, count: group.length });
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
