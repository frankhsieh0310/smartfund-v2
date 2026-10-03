// J.P. Morgan Asset Management Taiwan — official per-fund product page, headless-browser automated.
// Verified 2026-09-24: am.jpmorgan.com is a client-rendered site with no plain-fetchable holdings source
// and no server-side ticker->URL directory this adapter can enumerate; only the two ETFs already
// confirmed this round (00401A, 00989A — the full JPMorgan universe, both active; no passive JPMorgan
// ETF currently exists in the TWSE/TPEx registry) are known-good. Any other ticker is a real, honest
// blocker rather than a guessed URL.
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";
import { withPage } from "./browserUtil.ts";

const PRODUCT_URL: Record<string, string> = {
  "00401A": "https://am.jpmorgan.com/tw/zh/asset-management/twetf/products/jpmorgan-taiwan-taiwan-equity-high-income-active-etf-tw00000401a1",
  "00989A": "https://am.jpmorgan.com/tw/zh/asset-management/twetf/products/jpmorgan-taiwan-u-s-tech-leaders-active-etf-tw00000989a5",
};

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[,%]/g, "").trim()) || 0;
}

export const JpmorganOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "JPMorgan",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const url = PRODUCT_URL[etfCode];
    if (!url) throw new Error(`JPMORGAN_UNMAPPED_ETF_${etfCode} — no confirmed official product URL, never guessed`);

    return withPage(async (page) => {
      await page.goto(`${url}#/pcf`, { waitUntil: "networkidle0", timeout: 30000 });
      await page.waitForFunction(() => document.body.innerText.includes("申購買回清單公告"), { timeout: 15000 });

      const bodyText = await page.evaluate(() => document.body.innerText);
      const dateMatch = bodyText.match(/公告日期[：:]\s*(\d{4}\/\d{2}\/\d{2})/);
      if (!dateMatch) throw new Error(`JPMORGAN_NO_DATE_${etfCode} — page markup changed, adapter needs re-verification`);
      const announcementDate = dateMatch[1].replaceAll("/", "-");

      const navMatch = bodyText.match(/基金淨資產價值\(元\)\s*\n?\s*([\d,]+)/);
      const unitsMatch = bodyText.match(/已發行受益權單位總數\s*\n?\s*([\d,]+)/);

      // Confirmed live 2026-09-26: by the time networkidle0 fires, am.jpmorgan.com's own client-side
      // render has mounted the entire holdings section (stock + product + cash tables) TWICE, with the
      // second copy's outerHTML byte-for-byte identical to the first (a page-side rendering bug, not a
      // real second snapshot). Deduping table ELEMENTS by exact outerHTML equality — before flattening to
      // rows — removes exactly that duplicate mount; two tables with different real content (even if a
      // security code happened to coincide) would never match on full outerHTML and would both survive.
      const rows = await page.evaluate(() => {
        const tables = Array.from(document.querySelectorAll("table"));
        const seenHtml = new Set<string>();
        const uniqueTables = tables.filter((t) => {
          if (seenHtml.has(t.outerHTML)) return false;
          seenHtml.add(t.outerHTML);
          return true;
        });
        return uniqueTables.flatMap((t) => Array.from(t.querySelectorAll("tr"))).map((tr) =>
          Array.from(tr.querySelectorAll("td, th")).map((c) => (c.textContent ?? "").trim()),
        );
      });

      const positions: CanonicalPosition[] = [];
      for (const cells of rows) {
        if (cells.length < 4) continue;
        if (!/^[A-Za-z0-9]{2,10}$/.test(cells[0])) continue;
        const numeric = cells.slice(1).filter((c) => /^[\d,.\-]+%?$/.test(c));
        if (numeric.length < 2) continue;
        positions.push({
          securityCode: cells[0], securityName: cells[1],
          positionType: "EQUITY", positionAmount: num(numeric[0]), positionUnit: "SHARES",
          weight: num(numeric[numeric.length - 1]), canonicalSecurityId: null,
        });
      }
      if (!positions.length) throw new Error(`JPMORGAN_NO_HOLDINGS_${etfCode}_${announcementDate}`);

      return {
        etfCode,
        issuer: "JPMorgan",
        assetType: "EQUITY",
        dataDate: announcementDate,
        announcementDate,
        fundNav: num(navMatch?.[1]),
        outstandingUnits: num(unitsMatch?.[1]),
        positions,
        source: "JPMORGAN_OFFICIAL_PCF_PAGE",
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  },
};
