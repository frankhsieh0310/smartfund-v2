// Focused, bounded, READ-ONLY diagnosis: get through the FIRST FundClear query only, using
// explicit DOM-state waits (never blind sleep), to find why the headless run saw 0 range buttons
// in 4s when the same flow passed in a headed/interactive browser. No pagination, no DB write.
import { chromium } from "playwright";

const PAGE_URL = "https://www.fundclear.com.tw/data-and-statistics/market-comprehensive-statistics?type=offshore";
const API_PATH = "/api/marketing-statistics/offshore/query";
const ACTION_TIMEOUT_MS = 10_000;
const RANGE_BUTTON_EXIST_TIMEOUT_MS = 15_000;
const RESPONSE_TIMEOUT_MS = 15_000;
const GLOBAL_TIMEOUT_MS = 2 * 60 * 1000;

async function run() {
  const steps: Record<string, unknown> = {};
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });
    steps.pageLoaded = true;

    // Explicit condition: wait for the 基金規模資訊 button to be visible (Angular hydration done),
    // not a fixed sleep.
    const sizeBtn = page.getByRole("button", { name: "基金規模資訊", exact: true });
    await sizeBtn.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    steps.sizeButtonVisible = true;
    steps.sizeButtonEnabled = await sizeBtn.isEnabled();

    await sizeBtn.click({ timeout: ACTION_TIMEOUT_MS });
    steps.sizeButtonClicked = true;

    // Range buttons exist with fully valid CSS well below the initial scroll position — waiting
    // for Playwright's "visible" state timed out at both 10s and 20s. Wait for DOM existence only
    // ("attached", not "visible") with a bounded 15s budget; resolves immediately once present.
    const rangeButtons = page.locator("button").filter({ hasText: /^第\d+~\d+$/ });
    const rangeWaitStarted = Date.now();
    await rangeButtons.first().waitFor({ state: "attached", timeout: RANGE_BUTTON_EXIST_TIMEOUT_MS });
    steps.rangeButtonsAppearedAfterSeconds = Math.round((Date.now() - rangeWaitStarted) / 1000 * 10) / 10;
    steps.rangeButtonsCount = await rangeButtons.count();
    steps.rangeButtonsFound = true;

    const first10 = page.getByRole("button", { name: "第1~10", exact: true });
    await first10.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    steps.first10ScrolledIntoView = true;
    const alreadySelected = (await first10.getAttribute("class"))?.includes("selected") ?? false;
    steps.firstRangeAlreadySelected = alreadySelected;
    if (!alreadySelected) await first10.click({ timeout: ACTION_TIMEOUT_MS });
    steps.firstRangeClicked = true;

    const queryBtn = page.getByRole("button", { name: "查詢", exact: true });
    await queryBtn.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    steps.queryButtonVisible = true;

    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes(API_PATH) && r.request().method() === "POST", { timeout: RESPONSE_TIMEOUT_MS }),
      queryBtn.click({ timeout: ACTION_TIMEOUT_MS }),
    ]);
    steps.apiStatus = response.status();
    const json = await response.json();
    steps.realJsonReturned = Array.isArray(json.funds);
    steps.latestPeriod = json.queryDate ?? null;
    steps.firstPageRows = Array.isArray(json.funds) ? json.funds.length : 0;

    return { ok: true, steps };
  } catch (e) {
    return { ok: false, steps, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await browser.close();
  }
}

async function main() {
  const started = Date.now();
  const timeoutGuard = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("GLOBAL_TIMEOUT_EXCEEDED")), GLOBAL_TIMEOUT_MS));
  try {
    const result = await Promise.race([run(), timeoutGuard]);
    console.log(JSON.stringify({ ...result, runDurationSeconds: Math.round((Date.now() - started) / 1000) }));
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e), runDurationSeconds: Math.round((Date.now() - started) / 1000) }));
    process.exit(1);
  }
}
main();
