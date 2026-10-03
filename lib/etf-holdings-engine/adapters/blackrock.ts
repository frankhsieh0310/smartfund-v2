// BlackRock (貝萊德) iShares Taiwan — official actual-holdings CSV export, plain HTTP GET, no headless
// browser, no cookie. Verified 2026-09-26:
//   /tw/products/{productId}/fund/1480664180144.ajax?fileType=csv&fileName={ticker}_holdings&dataType=fund
// returns the fund's full real holdings (confirmed: 57 rows for the Top-50 equity fund down to a cash/
// derivative adjustment line, 318 for the corporate-bond fund — not the smaller `?tab=top` top-10 JSON
// variant of the same endpoint, which must never be used as the daily source). Real share counts / par
// values match each fund's actual NAV/market-value scale directly — this is the only official holdings
// source for this issuer, no PCF/creation-basket exists to confuse it with, no scaling.
//
// Identity: productId per ticker is a one-time, low-frequency lookup from the official products-list
// screener page (https://www.blackrock.com/tw/products/products-list), never re-derived by daily
// ingestion and never guessed from a marketing page's own cross-linked `/tw/products/` anchors (that was
// the previous adapter's exact bug — it picked whichever such link came first in the DOM, which was
// sometimes a different fund entirely or a generic nav link, then waited forever for holdings text that
// would never appear on the wrong page).
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const PRODUCT_ID_MAP: Record<string, string> = {
  "009813": "345655", "009826": "351824", "00991B": "351827", "00985D": "349339",
};

function num(s: string | undefined): number {
  if (!s) return 0;
  return Number(s.replace(/[,%]/g, "").trim()) || 0;
}

/** Splits one CSV line into fields, respecting double-quoted values (which may themselves contain commas
 * inside — none observed here, but numbers are quoted, e.g. "470,506,221.09"). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (c === "," && !inQuotes) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export const BlackRockOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "BlackRock",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const productId = PRODUCT_ID_MAP[etfCode];
    if (!productId) throw new Error(`BLACKROCK_UNMAPPED_ETF_${etfCode} — not in the official products-list map, never guessed`);

    const url = `https://www.blackrock.com/tw/products/${productId}/fund/1480664180144.ajax?fileType=csv&fileName=${etfCode}_holdings&dataType=fund`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal });
    if (!r.ok) throw new Error(`BLACKROCK_HTTP_${r.status}_${etfCode}`);
    const text = await r.text();
    const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
    if (lines.length < 3) throw new Error(`BLACKROCK_NO_HOLDINGS_${etfCode} — CSV response too short`);

    // Line 0: 截至,"YYYY年M月D日" — the fund's own real holdings date, read fresh every call, never
    // computed locally and never assumed shared across ETFs.
    const dateMatch = lines[0].match(/截至,"?(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (!dateMatch) throw new Error(`BLACKROCK_NO_DATE_${etfCode} — CSV header changed, adapter needs re-verification`);
    const dataDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`;

    // Line 2 is the real column header (line 1 is a blank separator line); its shape differs by asset
    // class (bond CSVs add a "Par Value" column equity CSVs don't have), so columns are read by name,
    // never by a hardcoded position.
    const header = splitCsvLine(lines[2]).map((h) => h.trim());
    const colIdx = (name: string) => header.findIndex((h) => h === name);
    const tickerIdx = colIdx("Ticker");
    const nameIdx = colIdx("Name");
    const assetClassIdx = colIdx("Asset Class");
    const sharesIdx = colIdx("Shares");
    const parValueIdx = colIdx("Par Value"); // -1 when this fund's CSV has no bond columns at all
    const weightIdx = colIdx("Weight (%)");
    const exchangeIdx = colIdx("Exchange"); // -1 on fund CSVs that omit it (e.g. some bond funds)
    const maturityIdx = colIdx("Maturity"); // -1 on equity-only fund CSVs
    if (tickerIdx === -1 || sharesIdx === -1 || weightIdx === -1) {
      throw new Error(`BLACKROCK_CSV_HEADER_PARSE_FAILED_${etfCode} — expected columns missing, CSV shape changed`);
    }

    const positions: CanonicalPosition[] = [];
    for (const line of lines.slice(3)) {
      const cells = splitCsvLine(line);
      const rawCode = cells[tickerIdx]?.trim();
      if (!rawCode) continue;
      const assetClass = (cells[assetClassIdx] ?? "").trim();
      const weight = num(cells[weightIdx]);

      // The bare "Ticker" column is not a full security identity — three confirmed real collision
      // patterns, each disambiguated by a different official column, never by amount/weight:
      //  1. Equities: the same short ticker is genuinely reused by unrelated companies on different
      //     exchanges (e.g. "MRK" = Merck & Co on NYSE vs Merck KGaA on Xetra) -> qualify with Exchange.
      //  2. Bonds: a fund can hold several tranches of the same issuer's debt (different maturity/coupon)
      //     under one ticker (e.g. multiple "ABBV" AbbVie Inc. bonds) -> exchange is blank ("-") for these
      //     OTC bonds, so qualify with Maturity instead, which is unique per tranche.
      //  3. FX/cash: the same currency ticker covers both a cash balance and an FX forward/hedge line
      //     (e.g. "JPY CASH" vs "JPY/USD") -> qualify with Asset Class.
      const exchange = exchangeIdx !== -1 ? cells[exchangeIdx]?.trim() : "";
      const maturity = maturityIdx !== -1 ? cells[maturityIdx]?.trim() : "";
      const name = cells[nameIdx]?.trim() ?? "";
      // Confirmed: "PPL" alone covers several distinct subsidiary issuers (PPL Corporation, Louisville
      // Gas and Electric Company, Kentucky Utilities Co) that can share both ticker AND maturity — Name
      // is the one official field that still differs, so it's appended alongside maturity for bonds.
      const code =
        exchange && exchange !== "-" ? `${rawCode}:${exchange}`
        : maturity ? `${rawCode}:${maturity}:${name}`
        : assetClass ? `${rawCode}:${assetClass}`
        : rawCode;

      if (parValueIdx !== -1 && num(cells[parValueIdx]) !== 0) {
        // Official par value is the "Par Value" column; "Shares" and "Market Value" are never used as the
        // bond position amount.
        positions.push({
          securityCode: code, securityName: cells[nameIdx]?.trim() ?? "",
          positionType: "BOND", positionAmount: num(cells[parValueIdx]), positionUnit: "PAR_VALUE",
          weight, canonicalSecurityId: null,
        });
      } else if (assetClass.toLowerCase().includes("cash") || assetClass.includes("現金")) {
        positions.push({
          securityCode: code, securityName: cells[nameIdx]?.trim() ?? "",
          positionType: "OTHER", positionAmount: num(cells[sharesIdx]), positionUnit: "OTHER",
          weight, canonicalSecurityId: null,
        });
      } else {
        positions.push({
          securityCode: code, securityName: cells[nameIdx]?.trim() ?? "",
          positionType: "EQUITY", positionAmount: num(cells[sharesIdx]), positionUnit: "SHARES",
          weight, canonicalSecurityId: null,
        });
      }
    }
    if (!positions.length) throw new Error(`BLACKROCK_NO_HOLDINGS_${etfCode}_${dataDate}`);

    const hasBond = positions.some((p) => p.positionType === "BOND");
    const hasEquity = positions.some((p) => p.positionType === "EQUITY");
    return {
      etfCode,
      issuer: "BlackRock",
      assetType: hasBond && hasEquity ? "MULTI_ASSET" : hasBond ? "BOND" : hasEquity ? "EQUITY" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav: 0,
      outstandingUnits: 0,
      positions,
      source: "BLACKROCK_OFFICIAL_HOLDINGS_CSV",
      retrievedAt: new Date().toISOString(),
    };
  },
};
