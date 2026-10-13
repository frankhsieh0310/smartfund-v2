// Fubon Securities Investment Trust — official server-rendered PCF page. Verified 2026-09-24/25:
// GET https://websys.fsit.com.tw/FubonETF/Fund/Assets.aspx?stkId={ticker} renders full holdings
// server-side (confirmed via plain HTTP fetch, no JS execution needed). Same URL pattern works
// unmodified for every Fubon ETF, active or passive — only the stkId query param changes.
import * as cheerio from "cheerio";
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://websys.fsit.com.tw";

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[,%]/g, "").trim()) || 0;
}

export const FubonOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "Fubon",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const r = await fetch(`${BASE}/FubonETF/Fund/Assets.aspx?stkId=${etfCode}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal });
    if (!r.ok) throw new Error(`FUBON_HTTP_${r.status}_${etfCode}`);
    const html = await r.text();
    const $ = cheerio.load(html);

    const dateMatch = $("body").text().match(/資料日期[：:]\s*(\d{4}\/\d{2}\/\d{2})/);
    if (!dateMatch) throw new Error(`FUBON_NO_DATE_${etfCode} — page markup changed, adapter needs re-verification`);
    const dataDate = dateMatch[1].replaceAll("/", "-");

    let fundNav = 0;
    let outstandingUnits = 0;
    $("li").each((_, li) => {
      const label = $(li).find("p").eq(0).text().trim();
      const value = $(li).find("p").eq(1).text().trim();
      if (label.includes("基金淨資產")) fundNav = num(value);
      if (label.includes("基金在外流通單位數")) outstandingUnits = num(value);
    });

    const positions: CanonicalPosition[] = [];
    $("h6").each((_, h6) => {
      const section = $(h6).text().trim();
      const isStock = section === "股票";
      const isFuture = section === "期貨";
      const isBond = section === "債券";
      if (!isStock && !isFuture && !isBond) return;

      const table = $(h6).next().find("table").first();
      table.find("tbody tr").each((__, tr) => {
        const cells = $(tr).find("td").map((___, td) => $(td).text().trim()).get();
        if (cells.length < 4) return;
        if (cells[0].includes("合計")) return;

        if (isStock) {
          positions.push({
            securityCode: cells[0], securityName: cells[1],
            positionType: "EQUITY", positionAmount: num(cells[2]), positionUnit: "SHARES",
            weight: num(cells[4] ?? cells[3]), canonicalSecurityId: null,
          });
        } else if (isFuture) {
          positions.push({
            securityCode: cells[0], securityName: cells[1],
            positionType: "FUTURE", positionAmount: num(cells[2]), positionUnit: "CONTRACTS",
            weight: num(cells[4] ?? cells[3]), canonicalSecurityId: null,
          });
        } else if (isBond) {
          positions.push({
            securityCode: cells[0], securityName: cells[1],
            positionType: "BOND", positionAmount: num(cells[2]), positionUnit: "PAR_VALUE",
            weight: num(cells[4] ?? cells[3]), canonicalSecurityId: null,
          });
        }
      });
    });

    if (!positions.length) throw new Error(`FUBON_NO_HOLDINGS_${etfCode}_${dataDate}`);

    return {
      etfCode,
      issuer: "Fubon",
      assetType: positions.some((p) => p.positionType === "EQUITY") ? "EQUITY" : positions.some((p) => p.positionType === "BOND") ? "BOND" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav,
      outstandingUnits,
      positions,
      source: "FUBON_OFFICIAL_PCF_PAGE",
      retrievedAt: new Date().toISOString(),
    };
  },
};
