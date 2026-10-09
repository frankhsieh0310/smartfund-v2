// Monthly FundClear (境外基金資訊觀測站) offshore-fund statistics ingestion.
// MUST go through the real browser flow — official page, official JS, official invisible
// reCAPTCHA, normal form clicks — never a bare HTTP replay (verified separately: replaying the
// POST body directly gets 403 "Google驗證失敗"). Bounded: ONE statisticsType (基金規模資訊 — its
// response already carries subscription/redemption/net-subscription/domestic-holding/fund-size/
// ratio/statutory-max in one shot, so a second statisticsType would be a redundant query) across
// the official 顯示區間 pages, once, for the latest period only. No retry loop, no history backfill.
//
// DOM behavior (confirmed by direct inspection, not guessed): after clicking 查詢 the search form
// COLLAPSES and the 顯示區間 range buttons are removed from the DOM entirely, replaced by a summary
// bar with a "展開搜尋條件"/"收起搜尋條件" toggle (a plain <div>, not a <button>). Selections persist
// across expand/collapse. So every page after the first must re-expand the form before the next
// range button exists to click — this (not reCAPTCHA, not the API) was the actual stuck point in
// the prior run.
import { chromium } from "playwright";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

const PAGE_URL = "https://www.fundclear.com.tw/data-and-statistics/market-comprehensive-statistics?type=offshore";
const API_PATH = "/api/marketing-statistics/offshore/query";
const STAT_TYPE = "基金規模資訊";
const EXPAND_TEXT = "展開搜尋條件";
const MAX_PAGES = 15; // safety cap; actual stop condition is "no more range buttons found"
const ACTION_TIMEOUT_MS = 10_000;
const RESPONSE_TIMEOUT_MS = 15_000;
const GLOBAL_HARD_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, per instruction

type FundClearRow = {
  fundCode: string; fundName: string; warnStr?: string; fundType?: string;
  subscriptionAmount?: string; redemptionAmount?: string; netSubscriptionAmount?: string;
  domesticHoldingAmount?: string; fundSize?: string; domesticHoldingRatio?: number; statutoryMaximum?: string;
};

async function run() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });
    await page.waitForTimeout(1000);
    await page.getByRole("button", { name: STAT_TYPE, exact: true }).click({ timeout: ACTION_TIMEOUT_MS });
    await page.waitForTimeout(300);

    const merged = new Map<string, FundClearRow>();
    let latestPeriod: string | null = null;
    let unit: string | null = null;
    const visitedRanges = new Set<string>();
    let reachedEnd = false;
    let parseFailures = 0;

    for (let i = 0; i < MAX_PAGES; i++) {
      // Range buttons only exist while the form is expanded; after the first submit it's
      // collapsed, so re-expand before reading the live set of range buttons from the DOM.
      if (i > 0) {
        const expandToggle = page.getByText(EXPAND_TEXT, { exact: true });
        if ((await expandToggle.count()) === 0) { reachedEnd = true; break; } // nothing left to expand
        await expandToggle.click({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForTimeout(300);
      }
      // The range buttons exist in the DOM with fully valid CSS (confirmed by direct inspection)
      // well below the initial scroll position — waiting for Playwright's "visible" state timed
      // out regardless of budget (10s and 20s both failed identically), so instead of waiting for
      // visibility, just confirm existence via count() and actively scroll the target into view.
      const rangeButtons = page.locator("button").filter({ hasText: /^第\d+~\d+$/ });
      const count = await rangeButtons.count();
      if (count === 0) {
        // Zero range buttons before any page has ever succeeded is NOT "no more pages" — it means
        // the UI never became ready (hydration timing, wrong state, etc). Only a later page coming
        // back empty after at least one real success is a legitimate reachedEnd.
        if (visitedRanges.size === 0) throw new Error("INITIAL_UI_NOT_READY: no range buttons found before any successful page");
        reachedEnd = true; break;
      }
      const labels: string[] = [];
      for (let j = 0; j < count; j++) labels.push((await rangeButtons.nth(j).innerText()).trim());
      const nextLabel = labels.find((l) => !visitedRanges.has(l));
      if (!nextLabel) { reachedEnd = true; break; }
      visitedRanges.add(nextLabel);

      const targetButton = page.getByRole("button", { name: nextLabel, exact: true });
      await targetButton.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      await targetButton.click({ timeout: ACTION_TIMEOUT_MS });
      await page.waitForTimeout(200);
      const [response] = await Promise.all([
        page.waitForResponse((r) => r.url().includes(API_PATH) && r.request().method() === "POST", { timeout: RESPONSE_TIMEOUT_MS }),
        page.getByRole("button", { name: "查詢", exact: true }).click({ timeout: ACTION_TIMEOUT_MS }),
      ]);
      if (response.status() !== 200) throw new Error(`HTTP_${response.status()}_on_${nextLabel}`);
      const json = await response.json();
      latestPeriod = json.queryDate ?? latestPeriod;
      unit = json.unit ?? unit;
      const funds = (json.funds ?? []) as FundClearRow[];
      if (!Array.isArray(json.funds)) parseFailures++;
      for (const f of funds) {
        const existing = merged.get(f.fundCode) ?? ({} as FundClearRow);
        merged.set(f.fundCode, { ...existing, ...f });
      }
      await page.waitForTimeout(700);
    }

    return { merged, latestPeriod, unit, pagesOrRangesFetched: visitedRanges.size, reachedEnd, parseFailures };
  } finally {
    await browser.close();
  }
}

async function main() {
  const started = Date.now();
  const timeoutGuard = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("GLOBAL_HARD_TIMEOUT_EXCEEDED")), GLOBAL_HARD_TIMEOUT_MS));

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await Promise.race([run(), timeoutGuard]);
  } catch (e) {
    console.log(JSON.stringify({
      status: "ABORT_NO_WRITE", reason: e instanceof Error ? e.message : String(e),
      runDurationSeconds: Math.round((Date.now() - started) / 1000),
    }));
    process.exit(1);
  }

  const { merged, latestPeriod, unit, pagesOrRangesFetched, reachedEnd, parseFailures } = result;
  if (!latestPeriod || merged.size === 0) {
    console.log(JSON.stringify({
      status: "ABORT_NO_WRITE", reason: "no data captured", pagesOrRangesFetched, reachedEnd,
      runDurationSeconds: Math.round((Date.now() - started) / 1000),
    }));
    process.exit(1);
  }

  const rows = Array.from(merged.values());
  const numOrNull = (v?: string) => (v == null ? null : Number(v.replace(/,/g, "")));

  const c = new Client({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL });
  let mapped = 0;
  try {
    await c.connect();
    await c.query(`
      CREATE TABLE IF NOT EXISTS fundclear_offshore_statistics (
        id uuid PRIMARY KEY,
        fund_id text REFERENCES funds(id) ON DELETE SET NULL,
        source_fund_code text NOT NULL,
        source_fund_name text NOT NULL,
        mapping_status text NOT NULL CHECK (mapping_status IN ('MAPPED','UNMAPPED')),
        observation_period text NOT NULL,
        subscription_amount numeric,
        redemption_amount numeric,
        net_subscription_amount numeric,
        domestic_holding_amount numeric,
        fund_size numeric,
        domestic_holding_ratio numeric,
        statutory_maximum numeric,
        currency_unit text,
        fund_type text,
        warn_str text,
        source text NOT NULL DEFAULT 'FUNDCLEAR_OFFICIAL',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source_fund_code, observation_period)
      )`);

    await c.query("BEGIN");
    await c.query(`DELETE FROM fundclear_offshore_statistics WHERE observation_period = $1`, [latestPeriod]);
    for (const r of rows) {
      const match = await c.query<{ id: string }>(
        `SELECT id FROM funds WHERE name = $1 AND is_active = true LIMIT 1`, [r.fundName],
      );
      const fundId = match.rows[0]?.id ?? null;
      if (fundId) mapped++;
      await c.query(
        `INSERT INTO fundclear_offshore_statistics
           (id, fund_id, source_fund_code, source_fund_name, mapping_status, observation_period,
            subscription_amount, redemption_amount, net_subscription_amount, domestic_holding_amount,
            fund_size, domestic_holding_ratio, statutory_maximum, currency_unit, fund_type, warn_str, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'FUNDCLEAR_OFFICIAL')`,
        [randomUUID(), fundId, r.fundCode, r.fundName, fundId ? "MAPPED" : "UNMAPPED", latestPeriod,
          numOrNull(r.subscriptionAmount), numOrNull(r.redemptionAmount), numOrNull(r.netSubscriptionAmount),
          numOrNull(r.domesticHoldingAmount), numOrNull(r.fundSize), r.domesticHoldingRatio ?? null,
          numOrNull(r.statutoryMaximum), unit, r.fundType ?? null, r.warnStr ?? null],
      );
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.log(JSON.stringify({
      status: "ABORT_NO_WRITE", reason: `db failure: ${e instanceof Error ? e.message : String(e)}`,
      runDurationSeconds: Math.round((Date.now() - started) / 1000),
    }));
    await c.end().catch(() => {});
    process.exit(1);
  }
  await c.end();

  console.log(JSON.stringify({
    status: "DONE", latestPeriod, pagesOrRangesFetched, reachedEnd, parseFailures,
    totalSourceRows: rows.length, mappedRows: mapped, unmappedRows: rows.length - mapped,
    mappingPercent: ((mapped / rows.length) * 100).toFixed(1),
    runDurationSeconds: Math.round((Date.now() - started) / 1000),
  }));
  process.exit(0);
}
main();
