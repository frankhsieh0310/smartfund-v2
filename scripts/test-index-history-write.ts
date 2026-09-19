import assert from "node:assert/strict";
import { buildCandleUpsertStatements, CANDLE_INSERT_CHUNK, dedupeByTimestamp, hasBudgetForIndex, type HistoryCandle } from "../lib/cron/indexHistoryWrite";

const ctx = { indexId: "shenzhen-b-share", timezone: "Asia/Shanghai", currency: "CNY", symbol: "399108.SZ" };
const candle = (day: number, close = 100 + day, volume: number | null = 1000): HistoryCandle => ({
  timestamp: new Date(Date.UTC(2026, 0, 1 + day, 1, 30, 0)), open: close - 1, high: close + 1, low: close - 2, close, volume,
});

// ---- chunking: 242 candles (399108.SZ first backfill) -> a single statement, not 242 round trips
const backfill = Array.from({ length: 242 }, (_, i) => candle(i));
const one = buildCandleUpsertStatements(ctx, backfill);
assert.equal(one.length, 1);
assert.equal(CANDLE_INSERT_CHUNK, 250);
// larger sets split into ceil(n / chunk) statements
assert.equal(buildCandleUpsertStatements(ctx, Array.from({ length: 501 }, (_, i) => candle(i))).length, 3);
assert.equal(buildCandleUpsertStatements(ctx, []).length, 0);

// ---- placeholders and params line up exactly (4 shared + 6 per row), highest placeholder == params.length
const { sql, params } = one[0];
assert.equal(params.length, 4 + 6 * 242);
const maxPlaceholder = Math.max(...[...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
assert.equal(maxPlaceholder, params.length);
assert.equal((sql.match(/\(\$1::text,'1d'/g) ?? []).length, 242);

// ---- conflict semantics identical to the old upsert: same PK target, updates ONLY open/high/low/close/volume
assert.match(sql, /ON CONFLICT \(index_id, "interval", "timestamp", source\) DO UPDATE SET open = EXCLUDED\.open, high = EXCLUDED\.high, low = EXCLUDED\.low, close = EXCLUDED\.close, volume = EXCLUDED\.volume$/);
assert.ok(!/DO UPDATE SET[^]*(timezone|currency|source_url|completeness|quality_status|ingested_at)/.test(sql.split("DO UPDATE SET")[1]));
// create-only constants match the old `create` block
for (const lit of ["'REGULAR'", "'YAHOO_CHART'", "'SOURCE_REPORTED'", "'PASS'", "'SUPPLEMENTAL'", "'UNVERIFIED'", "'SUPPLEMENTAL_UNVERIFIED'"]) assert.ok(sql.includes(lit), lit);

// ---- data content is unchanged: shared params, UTC wall-clock timestamp, number -> same digits, null volume stays null
assert.deepEqual(params.slice(0, 4), ["shenzhen-b-share", "Asia/Shanghai", "CNY", "https://query1.finance.yahoo.com/v8/finance/chart/399108.SZ"]);
assert.equal(params[4], "2026-01-01T01:30:00.000"); // no zone suffix -> timestamp(3) without tz keeps the UTC clock time
const odd = buildCandleUpsertStatements(ctx, [{ timestamp: new Date(Date.UTC(2026, 8, 18, 7, 0, 25)), open: 3245.123456789, high: 3300.5, low: 3200, close: 3250.1, volume: null }]);
assert.deepEqual(odd[0].params.slice(4), ["2026-09-18T07:00:25.000", "3245.123456789", "3300.5", "3200", "3250.1", null]);

// ---- duplicate timestamps inside one batch: last wins (matches sequential upserts) and never trips "cannot affect row a second time"
const dup = dedupeByTimestamp([candle(1, 10), candle(2, 20), candle(1, 11)]);
assert.equal(dup.length, 2);
assert.equal(dup.find((c) => c.timestamp.getTime() === candle(1).timestamp.getTime())!.close, 11);
assert.equal(buildCandleUpsertStatements(ctx, [candle(1, 10), candle(1, 11)])[0].params.length, 4 + 6);

// ---- runtime budget: never START an index the remaining time cannot finish
const deadline = 1_000_000;
assert.equal(hasBudgetForIndex(deadline - 31_000, deadline, 30_000), true);
assert.equal(hasBudgetForIndex(deadline - 30_000, deadline, 30_000), true); // exactly enough
assert.equal(hasBudgetForIndex(deadline - 29_999, deadline, 30_000), false);
assert.equal(hasBudgetForIndex(deadline + 1, deadline, 30_000), false);
assert.equal(hasBudgetForIndex(5, undefined, 30_000), true); // no deadline supplied (other callers) -> unchanged behaviour
console.log("index-history-write tests passed");
