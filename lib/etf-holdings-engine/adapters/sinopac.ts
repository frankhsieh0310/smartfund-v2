// SinoPac (永豐) Securities Investment Trust — official server-rendered PCF page. Verified 2026-09-24/25:
// GET https://sitc.sinopac.com/SinopacEtfs/Etfs/Pcf/{ticker} renders full holdings server-side (confirmed
// via plain HTTP fetch, no JS execution needed). Same URL pattern works unmodified for every SinoPac ETF,
// active or passive — only the ticker in the path changes. The page renders both a PC (".tab_sh-w") and a
// duplicate mobile (".tab_sh-m") copy of every table — only the PC copy is parsed, to avoid double-counting.
import * as cheerio from "cheerio";
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://sitc.sinopac.com";

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[,%]/g, "").replace(/^NT\$\s*/, "").trim()) || 0;
}

export const SinoPacOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "SinoPac",

  async fetchSnapshot(etfCode: string): Promise<CanonicalSnapshot> {
    const r = await fetch(`${BASE}/SinopacEtfs/Etfs/Pcf/${etfCode}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`SINOPAC_HTTP_${r.status}_${etfCode}`);
    const html = await r.text();
    const $ = cheerio.load(html);

    const dateMatch = $("body").text().match(/資料日期[：:]\s*(\d{4}\/\d{2}\/\d{2})/);
    if (!dateMatch) throw new Error(`SINOPAC_NO_DATE_${etfCode} — page markup changed, adapter needs re-verification`);
    const dataDate = dateMatch[1].replaceAll("/", "-");

    let fundNav = 0;
    let outstandingUnits = 0;
    $("table.tab_sh-w tbody tr").each((_, tr) => {
      const cells = $(tr).find("td").map((__, td) => $(td).text().trim()).get();
      if (cells.length !== 2) return;
      if (cells[0].includes("基金淨資產價值")) fundNav = num(cells[1]);
      if (cells[0].includes("基金在外流通單位數")) outstandingUnits = num(cells[1]);
    });

    const positions: CanonicalPosition[] = [];
    $(".cash_title-s").each((_, titleDiv) => {
      const section = $(titleDiv).text().trim();
      const isStock = section === "股票";
      const isFuture = section === "期貨";
      const isBond = section === "債券";
      if (!isStock && !isFuture && !isBond) return;

      const table = $(titleDiv).nextAll("table.tab_sh-w").first();
      table.find("tbody tr").each((__, tr) => {
        const cells = $(tr).find("td").map((___, td) => $(td).text().trim()).get();
        if (cells.length < 4) return;

        if (isStock) {
          positions.push({
            securityCode: cells[0], securityName: cells[1],
            positionType: "EQUITY", positionAmount: num(cells[2]), positionUnit: "SHARES",
            weight: num(cells[3]), canonicalSecurityId: null,
          });
        } else if (isFuture && cells.length >= 5) {
          positions.push({
            securityCode: cells[0], securityName: cells[1],
            positionType: "FUTURE", positionAmount: num(cells[3]), positionUnit: "CONTRACTS",
            weight: num(cells[4]), canonicalSecurityId: null,
          });
        } else if (isBond) {
          positions.push({
            securityCode: cells[0], securityName: cells[1],
            positionType: "BOND", positionAmount: num(cells[2]), positionUnit: "PAR_VALUE",
            weight: num(cells[3]), canonicalSecurityId: null,
          });
        }
      });
    });

    if (!positions.length) throw new Error(`SINOPAC_NO_HOLDINGS_${etfCode}_${dataDate}`);

    return {
      etfCode,
      issuer: "SinoPac",
      assetType: positions.some((p) => p.positionType === "EQUITY") ? "EQUITY" : positions.some((p) => p.positionType === "BOND") ? "BOND" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav,
      outstandingUnits,
      positions,
      source: "SINOPAC_OFFICIAL_PCF_PAGE",
      retrievedAt: new Date().toISOString(),
    };
  },
};
