// Taishin (+ former Shin Kong) Investment Trust — official server-rendered PCF page. Verified 2026-09-24/25:
// GET https://www.tsit.com.tw/ETF/Home/Pcf/{ticker} renders full holdings server-side (confirmed via
// plain HTTP fetch, no JS execution needed). Same URL pattern works unmodified for every Taishin ETF,
// active or passive — only the ticker in the path changes.
import * as cheerio from "cheerio";
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.tsit.com.tw";

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[,%]/g, "").replace(/^TWD\s*/, "").trim()) || 0;
}

export const TaishinOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "Taishin",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const r = await fetch(`${BASE}/ETF/Home/Pcf/${etfCode}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal });
    if (!r.ok) throw new Error(`TAISHIN_HTTP_${r.status}_${etfCode}`);
    const html = await r.text();
    const $ = cheerio.load(html);

    const dataDate = $("#DATA_DATE").attr("value");
    if (!dataDate) throw new Error(`TAISHIN_NO_DATE_${etfCode} — page markup changed, adapter needs re-verification`);

    let fundNav = 0;
    let outstandingUnits = 0;
    $(".listNo tr").each((_, tr) => {
      const label = $(tr).find("th").text().trim();
      const value = $(tr).find("td").text().trim();
      if (label.includes("基金淨資產價值")) fundNav = num(value);
      if (label.includes("已發行受益權單位總數")) outstandingUnits = num(value);
    });

    const positions: CanonicalPosition[] = [];
    $(".fund_card").each((_, card) => {
      const header = $(card).find(".card-header").text().replace(/\s+/g, "");
      const isStock = header.includes("股票");
      const isFuture = header.includes("期貨");
      const isBond = header.includes("債券");
      if (!isStock && !isFuture && !isBond) return;

      $(card)
        .find("table tbody tr")
        .each((__, tr) => {
          const cells = $(tr).find("td").map((___, td) => $(td).text().trim()).get();
          if (cells.length < 3) return;
          if (cells[0].includes("合計")) return;

          if (isStock && cells.length >= 4) {
            positions.push({
              securityCode: cells[0].replace(/\s*TT$/, ""), securityName: cells[1],
              positionType: "EQUITY", positionAmount: num(cells[2]), positionUnit: "SHARES",
              weight: num(cells[3]), canonicalSecurityId: null,
            });
          } else if (isFuture && cells.length >= 5) {
            positions.push({
              securityCode: cells[0], securityName: cells[1],
              positionType: "FUTURE", positionAmount: num(cells[3]), positionUnit: "CONTRACTS",
              weight: num(cells[4]), canonicalSecurityId: null,
            });
          } else if (isBond && cells.length >= 5) {
            // Bond cards have 5 columns (代號/名稱/面額/市值/權重%) — one more than stock/future cards.
            // cells[3] is 市值 (market value, a TWD amount, never used as weight); the real weight is
            // cells[4]. Confirmed 2026-09-26 against the official page's own column headers.
            positions.push({
              securityCode: cells[0], securityName: cells[1],
              positionType: "BOND", positionAmount: num(cells[2]), positionUnit: "PAR_VALUE",
              weight: num(cells[4]), canonicalSecurityId: null,
            });
          }
        });
    });

    if (!positions.length) throw new Error(`TAISHIN_NO_HOLDINGS_${etfCode}_${dataDate}`);

    return {
      etfCode,
      issuer: "Taishin",
      assetType: positions.some((p) => p.positionType === "EQUITY") ? "EQUITY" : positions.some((p) => p.positionType === "BOND") ? "BOND" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav,
      outstandingUnits,
      positions,
      source: "TAISHIN_OFFICIAL_PCF_PAGE",
      retrievedAt: new Date().toISOString(),
    };
  },
};
