import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";


const OUTPUT_DIR = path.join(__dirname, "..", "review-output");
const BASE_URL = "http://localhost:3000";

const PAGES = [
  { name: "home",    path: "/",        waitFor: "h1" },
  { name: "etf",     path: "/etf",     waitFor: "main" },
  { name: "funds",   path: "/funds",   waitFor: "main" },
  { name: "markets", path: "/markets", waitFor: "main" },
  { name: "compare", path: "/compare", waitFor: "main" },
  { name: "quiz",    path: "/quiz",    waitFor: "main" },
  { name: "report",  path: "/report",  waitFor: "main" },
];

async function run() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log("SmartMatch Review Mode");
  console.log("Output:", OUTPUT_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  for (const page_def of PAGES) {
    const url = `${BASE_URL}${page_def.path}`;
    const outputPath = path.join(OUTPUT_DIR, `${page_def.name}.png`);
    process.stdout.write(`截圖 ${page_def.name} ... `);
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForSelector(page_def.waitFor, { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.screenshot({ path: outputPath, fullPage: true });
      await page.close();
      console.log("完成");
    } catch (err) {
      console.log("失敗:", err.message.split("\n")[0]);
    }
  }

  await browser.close();
  console.log("全部完成，截圖在 review-output/ 資料夾");
}

run().catch(err => {
  console.error("錯誤:", err.message);
  process.exit(1);
});