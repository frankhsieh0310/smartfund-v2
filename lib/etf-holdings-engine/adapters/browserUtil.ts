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

/**
 * Runs fn(page) on a fresh page on the shared browser. If `signal` aborts before fn(page) settles,
 * the page is closed immediately — closing a Puppeteer page rejects any pending goto/waitForFunction/
 * evaluate on it right away, so the abandoned work doesn't keep running in the background. The shared
 * browser itself is never closed here (other callers may still be using it); only this one page is.
 * The abort listener is always removed in `finally`, whichever side wins the race.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36");

  if (signal?.aborted) {
    await page.close();
    throw new Error("ABORTED_BEFORE_START");
  }

  let onAbort: (() => void) | null = null;
  try {
    const work = fn(page);
    if (!signal) return await work;

    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("ABORTED"));
      signal.addEventListener("abort", onAbort);
    });
    try {
      return await Promise.race([work, aborted]);
    } catch (error) {
      // Whichever side lost the race, make sure the page actually stops: closing it rejects any
      // still-pending goto/waitForFunction/evaluate inside `work` immediately, instead of leaving an
      // orphaned navigation running on the shared browser. `work` itself is abandoned here (we're
      // already throwing) — swallow its eventual settlement so it never surfaces as an unhandled
      // rejection once the page-close forces it to reject too.
      work.catch(() => {});
      await page.close().catch(() => {});
      throw error;
    }
  } finally {
    if (onAbort) signal!.removeEventListener("abort", onAbort);
    // best-effort: if the race path above already closed the page, this is a harmless no-op (Puppeteer
    // tolerates closing an already-closed page); if fn(page) resolved normally, this is the real close.
    await page.close().catch(() => {});
  }
}

export async function closeSharedBrowser(): Promise<void> {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}
