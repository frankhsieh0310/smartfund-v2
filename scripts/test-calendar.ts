import assert from "node:assert/strict";
import { monthRange, parseCalendarParams } from "../lib/calendar/eventsService";

assert.deepEqual(monthRange("2026-09"), { start: "2026-09-01", end: "2026-10-01" });
assert.deepEqual(monthRange("2026-12"), { start: "2026-12-01", end: "2027-01-01" });
assert.equal(monthRange("2026-13"), null);
assert.equal(monthRange("26-9"), null);

const ok = parseCalendarParams("2026-09", "ETF:a:P,FUND:b:W,ETF:a:W");
assert.ok(!("error" in ok));
if (!("error" in ok)) {
  assert.equal(ok.items.length, 2);
  assert.deepEqual(ok.items[0].scopes, ["PORTFOLIO", "WATCHLIST"]); // same product in both -> both scopes, one item
}
assert.ok("error" in parseCalendarParams(null, "ETF:a:P"));
assert.ok("error" in parseCalendarParams("2026-09", "STOCK:a:P"));
assert.ok("error" in parseCalendarParams("2026-09", "ETF:a:X")); // scope required: no implicit "everything"
assert.ok(!("error" in parseCalendarParams("2026-09", ""))); // empty scope list is allowed -> no events
console.log("calendar tests passed");
