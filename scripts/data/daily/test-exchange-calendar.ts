import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dispatchAt,
  isTradingDate,
  latestClosedTradingDate,
  loadExchangeCalendarRegistry,
  marketClock,
} from "./exchange-calendar.ts";

async function main(): Promise<void> {
  const registry = await loadExchangeCalendarRegistry();
  const raw = JSON.parse(await readFile(join(process.cwd(), "config", "production-yahoo-daily-jobs.json"), "utf8")) as Record<string, unknown>;
  assert.equal(registry.jobs.length, 16);
  assert.equal(new Set(registry.jobs.map((job) => job.id)).size, 16);
  assert.ok(registry.jobs.every((job) => job.schedulerEnabled));
  assert.ok(registry.jobs.every((job) => job.timezone.includes("/")));
  assert.ok(registry.jobs.every((job) => job.providerProbeSymbols.length >= 1));
  assert.ok(registry.jobs.some((job) => job.market === "Spain" && job.id === "spain-yahoo-daily"));
  assert.ok(!JSON.stringify(raw).includes("GLOBAL_EX_TW"));
  assert.ok(!JSON.stringify(raw).includes("primaryTime"));
  assert.ok(!JSON.stringify(raw).includes("retryTime"));
  assert.ok(!/priority|marketCap|volume|userInterest|etfExposure/i.test(JSON.stringify(raw)));
  assert.equal(registry.maxConcurrentMarketJobs, 3);
  assert.equal(registry.maxNewMarketJobsPerDispatch, 3);

  const nasdaq = registry.jobs.find((job) => job.market === "NASDAQ")!;
  assert.equal(marketClock("Asia/Taipei", dispatchAt(nasdaq, "2026-07-31")).time, "05:00");
  assert.equal(marketClock("Asia/Taipei", dispatchAt(nasdaq, "2026-01-02")).time, "06:00");
  assert.equal(isTradingDate(nasdaq, "2026-07-03"), false);
  assert.equal(latestClosedTradingDate(nasdaq, new Date("2026-07-04T12:00:00Z")), "2026-07-02");

  const hongKong = registry.jobs.find((job) => job.market === "Hong Kong")!;
  assert.equal(marketClock("Asia/Taipei", dispatchAt(hongKong, "2026-12-24")).time, "12:55");

  const unitedKingdom = registry.jobs.find((job) => job.market === "United Kingdom")!;
  assert.notEqual(
    marketClock("Asia/Taipei", dispatchAt(unitedKingdom, "2026-07-31")).time,
    marketClock("Asia/Taipei", dispatchAt(unitedKingdom, "2026-01-02")).time,
  );

  console.log(JSON.stringify({
    status: "PASS",
    markets: registry.jobs.length,
    spain: "PASS",
    noGlobalJob: "PASS",
    noPriorityFilter: "PASS",
    boundedConcurrentDispatch: "PASS",
    ianaDstConversion: "PASS",
    holidayAndHalfDay: "PASS",
  }, null, 2));
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
