// Shared headless-browser helper for issuer adapters whose official PCF page is client-rendered (SPA) and
// has no plain-fetchable JSON/HTML source. Used only to automate the EXACT official page a human would
// use — never a third-party source — for issuers where a raw HTTP fetch cannot see the rendered data.
//
// `puppeteer`'s own bundled Chrome download is a desktop-sized binary that isn't present in Vercel's
// serverless function bundle (and wouldn't run there even if it were — missing shared libs on the
// Lambda-based runtime). On Vercel, launch `puppeteer-core` against `@sparticuz/chromium`'s
// serverless-packaged Chromium instead; everywhere else (local dev), keep using full `puppeteer`'s own
// Chrome exactly as before. Same API either way — nothing about how adapters call withPage() changes.
import type { Browser, Page } from "puppeteer-core";

let sharedBrowser: Browser | null = null;

async function launchBrowser(): Promise<Browser> {
  if (process.env.VERCEL) {
    const chromium = (await import("@sparticuz/chromium")).default;
    const puppeteerCore = await import("puppeteer-core");
    return puppeteerCore.launch({
      headless: true,
      args: chromium.args,
      executablePath: await chromium.executablePath(),
    });
  }
  const puppeteer = (await import("puppeteer")).default;
  return puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] }) as unknown as Promise<Browser>;
}

async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser) {
    sharedBrowser = await launchBrowser();
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
