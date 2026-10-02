// Shared headless-browser helper for issuer adapters whose official PCF page is client-rendered (SPA) and
// has no plain-fetchable JSON/HTML source. Used only to automate the EXACT official page a human would
// use — never a third-party source — for issuers where a raw HTTP fetch cannot see the rendered data.
import puppeteer, { type Browser, type Page } from "puppeteer";

let sharedBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  }
  return sharedBrowser;
}

export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");
  try {
    return await fn(page);
  } finally {
    await page.close();
  }
}

export async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}
