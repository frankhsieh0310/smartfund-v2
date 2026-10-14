// Task X5 Part 2a: completion used to be DB-truth — "has etf_performances got a row dated today for
// this etf" — but that breaks once date-alignment (app/api/cron/etf-returns-sync/route.ts's
// resolveWriteDate) starts writing onto an EARLIER date than today to merge with cloud-etf-price's
// row: an etf aligned to, say, 10/9 would never show a row dated "today" and would be re-fetched
// from Yahoo every single day forever, never advancing — exactly the "排程卡住" failure the user
// flagged. Fixed by decoupling "which date did we write the row at" (display concern) from "did we
// successfully process this etf today" (scheduling concern): the latter is its own map, set only
// when a write actually happens, so shadow mode (which writes nothing) still behaves as before —
// never "done".
export type LastProcessedDateMap = Record<string, string>;

// Task X7: a mid-day deploy that fixes the return calculation (e.g. the 2026-10-14 Yahoo奇摩
// navReturn switch) does NOT retroactively redo etfs already marked "done for today" -- they'd sit
// on the pre-fix value until the date rolls over, even though the fix is already live. Tracks which
// deployment (VERCEL_DEPLOYMENT_ID, see writeGate.ts's writeEnvDiagnostic) actually produced each
// etf's "done for today" write; a version mismatch forces reprocessing today regardless of date,
// self-healing within one invocation of a deploy instead of waiting for tomorrow.
export type LastProcessedVersionMap = Record<string, string>;

export function missingForToday(
  coreIds: string[],
  lastProcessedDate: LastProcessedDateMap,
  today: string,
  lastProcessedVersion: LastProcessedVersionMap = {},
  currentVersion: string | null = null,
): string[] {
  return coreIds.filter((id) => {
    if (lastProcessedDate[id] !== today) return true;
    // currentVersion is null when VERCEL_DEPLOYMENT_ID isn't set (e.g. local dev) -- version check
    // is skipped entirely rather than treating "no signal" as "always stale".
    if (currentVersion !== null && lastProcessedVersion[id] !== currentVersion) return true;
    return false;
  });
}
