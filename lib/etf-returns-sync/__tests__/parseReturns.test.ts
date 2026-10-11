import assert from "node:assert/strict";
import { parseTrailingReturns } from "../parseReturns.ts";

function test(name: string, fn: () => Promise<void> | void) {
  const p = Promise.resolve().then(fn);
  p.then(
    () => console.log(`PASS: ${name}`),
    (e) => { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; },
  );
  return p;
}

const wrap = (raw: number, fmt: string) => ({ raw, fmt });

(async () => {
  test("asOfDate epoch (raw 0) -> every period null, even if a period has a non-zero raw value", () => {
    const result = {
      fundPerformance: {
        trailingReturns: {
          asOfDate: wrap(0, "1970-01-01"),
          ytd: wrap(0, "0.00%"),
          oneMonth: wrap(0.05, "5.00%"), // should NOT leak through — asOfDate=epoch wins
          oneYear: wrap(0, "0.00%"),
          threeYear: wrap(0, "0.00%"),
        },
      },
    };
    const r = parseTrailingReturns(result);
    assert.deepEqual(r, { r1d: null, r1m: null, r3m: null, r6m: null, rytd: null, r1y: null, r3y: null, r5y: null });
  });

  test("real asOfDate + a period's own raw===0 -> that period null, others pass through (LQDM shape)", () => {
    const result = {
      fundPerformance: {
        trailingReturns: {
          asOfDate: wrap(1791504000, "2026-10-09"),
          ytd: wrap(0, "0.00%"), // placeholder -> null
          oneMonth: wrap(-0.0295191, "-2.95%"), // real -> -2.95
          threeMonth: wrap(-0.041104797, "-4.11%"), // real -> -4.11
          oneYear: wrap(0, "0.00%"), // placeholder -> null
          threeYear: wrap(0, "0.00%"), // placeholder -> null
          fiveYear: wrap(0, "0.00%"), // placeholder -> null
        },
      },
    };
    const r = parseTrailingReturns(result);
    assert.equal(r.rytd, null);
    assert.ok(Math.abs((r.r1m as number) - -2.95191) < 1e-6);
    assert.ok(Math.abs((r.r3m as number) - -4.1104797) < 1e-6);
    assert.equal(r.r1y, null);
    assert.equal(r.r3y, null);
    assert.equal(r.r5y, null);
  });

  test("missing trailingReturns entirely -> every period null, no throw", () => {
    const r = parseTrailingReturns({});
    assert.deepEqual(r, { r1d: null, r1m: null, r3m: null, r6m: null, rytd: null, r1y: null, r3y: null, r5y: null });
  });

  test("a genuine small non-zero fraction still scales to percent units (unchanged behavior)", () => {
    const result = {
      fundPerformance: {
        trailingReturns: {
          asOfDate: wrap(1791504000, "2026-10-09"),
          oneYear: wrap(0.1563, "15.63%"),
        },
      },
    };
    const r = parseTrailingReturns(result);
    assert.ok(Math.abs((r.r1y as number) - 15.63) < 1e-6);
  });
})();
