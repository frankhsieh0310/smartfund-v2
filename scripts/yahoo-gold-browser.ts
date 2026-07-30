import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { importYahooGoldCsv } from "./import-yahoo-gold-csv.ts";

type CsvKind = "financials-annual" | "financials-quarterly" | "balance-sheet" | "cash-flow" | "valuation";
type Checkpoint = { completed: string[]; failed: Array<{ symbol: string; kind: CsvKind; error: string; at: string }>; updatedAt: string };

const root = process.cwd();
const profilePath = join(root, "runtime", "yahoo-gold-profile");
const rawRoot = join(root, "data", "yahoo-gold", "raw");
const checkpointPath = join(root, "runtime", "yahoo-gold-checkpoint.json");
const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, "").split("="); return [key, rest.join("=") || "true"]; }));
const symbols = (args.get("symbols") ?? "AAPL,2330.TW").split(",").map((value) => value.trim()).filter(Boolean);
const loginOnly = args.has("login");
const resume = args.has("resume");
const allKinds: CsvKind[] = ["financials-annual", "financials-quarterly", "balance-sheet", "cash-flow", "valuation"];

function targetUrl(symbol: string, kind: CsvKind): string {
  const base = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
  if (kind.startsWith("financials")) return `${base}/financials/`;
  if (kind === "balance-sheet") return `${base}/balance-sheet/`;
  if (kind === "cash-flow") return `${base}/cash-flow/`;
  return `${base}/key-statistics/`;
}

function safeSymbol(symbol: string): string { return symbol.replace(/[^A-Za-z0-9._-]/g, "_"); }

async function pauseForLogin(page: Page, message: string): Promise<void> {
  await page.goto("https://finance.yahoo.com/", { waitUntil: "domcontentloaded" });
  console.log(JSON.stringify({ status: "MANUAL_LOGIN_WAITING", message, profilePath }));
  const terminal = createInterface({ input, output });
  await terminal.question("Complete Yahoo Gold login in the visible browser, then press Enter: ");
  terminal.close();
}

async function signedIn(page: Page): Promise<boolean> {
  const signIn = page.getByRole("link", { name: "Sign in" });
  return (await signIn.count()) === 0;
}

async function selectFrequency(page: Page, kind: CsvKind): Promise<void> {
  if (kind !== "financials-quarterly") return;
  const quarterly = page.getByText("Quarterly", { exact: true });
  if (await quarterly.count() === 1) await quarterly.click();
}

async function downloadCsv(page: Page, symbol: string, kind: CsvKind): Promise<string> {
  await page.goto(targetUrl(symbol, kind), { waitUntil: "domcontentloaded" });
  if (!(await signedIn(page))) await pauseForLogin(page, "Yahoo session expired or is not signed in.");
  await selectFrequency(page, kind);
  const button = page.getByRole("button", { name: "Download" });
  const link = page.locator("a[download]");
  const buttonCount = await button.count();
  const linkCount = await link.count();
  if (buttonCount + linkCount !== 1) throw new Error(`DOWNLOAD_CONTROL_NOT_UNIQUE:${kind}:buttons=${buttonCount}:links=${linkCount}`);
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  if (buttonCount === 1) await button.click(); else await link.click();
  const download = await downloadPromise;
  const directory = join(rawRoot, safeSymbol(symbol));
  await mkdir(directory, { recursive: true });
  const filename = `${safeSymbol(symbol)}_${kind}.csv`;
  const destination = join(directory, filename);
  await download.saveAs(destination);
  return destination;
}

async function loadCheckpoint(): Promise<Checkpoint> {
  try { return JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint; }
  catch { return { completed: [], failed: [], updatedAt: new Date(0).toISOString() }; }
}

async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  await mkdir(join(root, "runtime"), { recursive: true });
  checkpoint.updatedAt = new Date().toISOString();
  await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
}

async function main() {
  await mkdir(profilePath, { recursive: true });
  const context: BrowserContext = await chromium.launchPersistentContext(profilePath, { headless: false, acceptDownloads: true });
  const page = context.pages()[0] ?? await context.newPage();
  try {
    await page.goto("https://finance.yahoo.com/", { waitUntil: "domcontentloaded" });
    if (loginOnly || !(await signedIn(page))) await pauseForLogin(page, "First use requires manual Yahoo Gold login.");
    const verified = await signedIn(page);
    if (!verified) throw new Error("GOLD_LOGIN_NOT_VERIFIED");
    console.log(JSON.stringify({ status: "GOLD_SESSION_READY", profilePath }));
    if (loginOnly) return;
    const checkpoint = await loadCheckpoint();
    for (const symbol of symbols) for (const kind of allKinds) {
      const key = `${symbol}:${kind}`;
      if (resume && checkpoint.completed.includes(key)) continue;
      try {
        const file = await downloadCsv(page, symbol, kind);
        const imported = await importYahooGoldCsv(file, symbol);
        checkpoint.completed.push(key);
        await saveCheckpoint(checkpoint);
        console.log(JSON.stringify({ status: "IMPORTED", symbol, kind, ...imported }));
      } catch (error) {
        checkpoint.failed.push({ symbol, kind, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
        await saveCheckpoint(checkpoint);
        console.error(JSON.stringify({ status: "FAILED", symbol, kind, error: error instanceof Error ? error.message : String(error) }));
      }
      await page.waitForTimeout(1200 + Math.floor(Math.random() * 1300));
    }
  } finally {
    await context.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
