// AllianceBernstein (聯博) Taiwan — official per-fund product page. Verified 2026-09-24/26: the shared
// aggregator PCF page (etfs/pcf.html) has a broken React widget (confirmed reproducible AxiosError 404),
// but each fund's own dedicated product page is real. For 00984D (2026-09-26) the actual backing transport
// behind that page was found and confirmed: a plain JSON API on webapi.alliancebernstein.com, keyed by the
// fund's own ISIN — no headless browser needed at all for this one. 00404A/00980D remain on the original
// Puppeteer table-scrape of the rendered product page (both already confirmed working; left untouched).
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";
import { withPage } from "./browserUtil.ts";

const PRODUCT_URL: Record<string, string> = {
  "00404A": "https://www.abfunds.com.tw/zh-tw/etf/active/equities/abitl-taiwan-momentum-equity-premium-income-50-active-etf.-.TW00000404A5.html",
  "00980D": "https://www.abfunds.com.tw/zh-tw/etf/active/fixed-income/abitl-ig-corp-income-active-etf.-.TW00000980D8.html",
};

// market ticker -> official ISIN, used as the JSON-API key. Confirmed via the official product page's own
// nav menu (https://www.abfunds.com.tw/zh-tw/funds/etf/active/fixed-income/....-.TW00000984D0.html), never
// guessed.
const ISIN_MAP: Record<string, string> = {
  "00984D": "TW00000984D0",
};

type HoldingRow = { holding: string; holdingCode: string; holdingPerc: string; holdingShares: number; holdingValue: number };
type HoldingSection = { asOfDate: string; holdingCategory: string; isAllocation: boolean; holdings: HoldingRow[] };
type HoldingsResponse = { domesticHoldings?: HoldingSection[]; foreignHoldings?: HoldingSection[] };

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[,%]/g, "").trim()) || 0;
}

function mdyToIso(mdy: string): string {
  const [m, d, y] = mdy.split("/");
  return `${y}-${m}-${d}`;
}

async function fetchViaJsonApi(etfCode: string, isin: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
  // Omitting the `date` query param returns the same (latest) response as passing today's resolved date
  // explicitly — confirmed identical — so the official source resolves "latest" itself; never computed
  // locally.
  const r = await fetch(`https://webapi.alliancebernstein.com/v2/funds/tw/zh-tw/investor/${isin}/holdings`, { signal });
  if (!r.ok) throw new Error(`AB_HTTP_${r.status}_${etfCode}`);
  const j: HoldingsResponse = await r.json();
  const sections = [...(j.domesticHoldings ?? []), ...(j.foreignHoldings ?? [])];
  if (!sections.length) throw new Error(`AB_NO_HOLDINGS_${etfCode}`);

  const positions: CanonicalPosition[] = [];
  for (const section of sections) {
    if (!section.isAllocation) continue; // non-allocation sections are stats/characteristics, not positions
    for (const row of section.holdings) {
      if (section.holdingCategory === "holdings-section-bond") {
        positions.push({
          securityCode: row.holdingCode, securityName: row.holding,
          // Official par value is `holdingShares` (misleadingly named); `holdingValue` (market value) is
          // never used as the bond position amount.
          positionType: "BOND", positionAmount: row.holdingShares, positionUnit: "PAR_VALUE",
          weight: num(row.holdingPerc), canonicalSecurityId: null,
        });
      } else if (section.holdingCategory === "holdings-section-futures") {
        positions.push({
          securityCode: row.holdingCode || row.holding, securityName: row.holding,
          positionType: "FUTURE", positionAmount: row.holdingShares, positionUnit: "CONTRACTS",
          weight: num(row.holdingPerc), canonicalSecurityId: null,
        });
      } else if (section.holdingCategory === "holdings-section-equity") {
        positions.push({
          securityCode: row.holdingCode, securityName: row.holding,
          positionType: "EQUITY", positionAmount: row.holdingShares, positionUnit: "SHARES",
          weight: num(row.holdingPerc), canonicalSecurityId: null,
        });
      } else {
        positions.push({
          securityCode: row.holdingCode || row.holding, securityName: row.holding,
          positionType: "OTHER", positionAmount: row.holdingShares, positionUnit: "OTHER",
          weight: num(row.holdingPerc), canonicalSecurityId: null,
        });
      }
    }
  }
  if (!positions.length) throw new Error(`AB_NO_HOLDINGS_${etfCode}`);

  const firstDate = sections[0]?.asOfDate;
  if (!firstDate) throw new Error(`AB_NO_DATE_${etfCode} — official asOfDate missing, response shape changed`);
  const dataDate = mdyToIso(firstDate);

  const hasBond = positions.some((p) => p.positionType === "BOND");
  const hasEquity = positions.some((p) => p.positionType === "EQUITY");
  return {
    etfCode,
    issuer: "AB",
    assetType: hasBond && hasEquity ? "MULTI_ASSET" : hasBond ? "BOND" : hasEquity ? "EQUITY" : "OTHER",
    dataDate,
    announcementDate: dataDate,
    fundNav: 0,
    outstandingUnits: 0,
    positions,
    source: "AB_OFFICIAL_HOLDINGS_API",
    retrievedAt: new Date().toISOString(),
  };
}

export const AbOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "AB",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const isin = ISIN_MAP[etfCode];
    if (isin) return fetchViaJsonApi(etfCode, isin, signal);

    const url = PRODUCT_URL[etfCode];
    if (!url) throw new Error(`AB_UNMAPPED_ETF_${etfCode} — no confirmed official product URL, never guessed`);

    return withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
      await page.waitForFunction(() => document.body.innerText.includes("基金資產"), { timeout: 20000 });
      await new Promise((r) => setTimeout(r, 1000));

      const bodyText = await page.evaluate(() => document.body.innerText);
      const dateMatch = bodyText.match(/資料日期[：:]\s*(\d{4}\/\d{2}\/\d{2})/);
      if (!dateMatch) throw new Error(`AB_NO_DATE_${etfCode} — page markup changed, adapter needs re-verification`);
      const dataDate = dateMatch[1].replaceAll("/", "-");

      const rows = await page.$$eval("table tr", (trs) =>
        trs.map((tr) => Array.from(tr.querySelectorAll("td, th")).map((c) => (c.textContent ?? "").trim())),
      );

      const isBondFund = etfCode.endsWith("D");
      const positions: CanonicalPosition[] = [];
      for (const cells of rows) {
        if (cells.length < 4) continue;
        const codeCell = cells[0];
        const looksLikeCode = /^[A-Za-z0-9]{2,15}(\s[A-Z]{2})?$/.test(codeCell);
        if (!looksLikeCode) continue;
        const numeric = cells.slice(2).filter((c) => /^[\d,.\-]+%?$/.test(c));
        if (numeric.length < 2) continue;
        positions.push({
          securityCode: codeCell, securityName: cells[1],
          positionType: isBondFund ? "BOND" : "EQUITY",
          positionAmount: num(numeric[0]),
          positionUnit: isBondFund ? "PAR_VALUE" : "SHARES",
          weight: num(numeric[numeric.length - 1]),
          canonicalSecurityId: null,
        });
      }
      if (!positions.length) throw new Error(`AB_NO_HOLDINGS_${etfCode}_${dataDate}`);

      const navMatch = bodyText.match(/市值\s*\n?\s*權重/);
      return {
        etfCode,
        issuer: "AB",
        assetType: isBondFund ? "BOND" : "EQUITY",
        dataDate,
        announcementDate: dataDate,
        fundNav: 0,
        outstandingUnits: 0,
        positions,
        source: "AB_OFFICIAL_PRODUCT_PAGE",
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  },
};
