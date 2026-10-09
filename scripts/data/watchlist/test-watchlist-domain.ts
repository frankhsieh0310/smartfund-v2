import assert from "node:assert/strict";
import { dedupeKey, evaluateThreshold, rollingExtreme, rollingReference } from "./watchlist-domain.ts";

const now = new Date("2026-08-10T00:00:00Z");
const crossed = evaluateThreshold({ kind: "CROSSES_ABOVE", threshold: 100, previous: 99, current: 101, priorState: "BELOW", now });
assert.equal(crossed.triggered, true);
assert.equal(evaluateThreshold({ kind: "CROSSES_ABOVE", threshold: 100, previous: 101, current: 102, priorState: "ABOVE", now }).triggered, false);
assert.equal(evaluateThreshold({ kind: "ABOVE", threshold: 100, previous: 101, current: 102, priorState: "ABOVE", now }).triggered, false);
assert.equal(evaluateThreshold({ kind: "CROSSES_ABOVE", threshold: 100, previous: 99, current: 101, priorState: "BELOW", cooldownUntil: new Date("2026-08-10T00:01:00Z"), now }).suppressed, true);
assert.equal(evaluateThreshold({ kind: "CROSSES_ABOVE", threshold: 100, previous: 101, current: 99, priorState: "ABOVE", now }).rearmed, true);
assert.equal(dedupeKey("r", "v1", "o1", null, "BELOW>ABOVE"), dedupeKey("r", "v1", "o1", null, "BELOW>ABOVE"));
const history = [{ observedAt: new Date("2026-08-01Z"), value: 90 }, { observedAt: new Date("2026-08-05Z"), value: 110 }];
assert.equal(rollingReference(history, new Date("2026-08-03Z"))?.value, 90);
assert.equal(rollingExtreme(history, new Date("2026-08-01Z"), new Date("2026-08-10Z"), "HIGH"), 110);
console.log(JSON.stringify({ status: "PASS", tests: 8, statefulCrossing: "PASS", cooldown: "PASS", rearm: "PASS", dedupe: "PASS", rollingWindow: "PASS" }));
