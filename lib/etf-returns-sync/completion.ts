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

export function missingForToday(coreIds: string[], lastProcessedDate: LastProcessedDateMap, today: string): string[] {
  return coreIds.filter((id) => lastProcessedDate[id] !== today);
}
