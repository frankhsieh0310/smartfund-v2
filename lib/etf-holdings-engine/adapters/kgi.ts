// KGI (凱基) Securities Investment Trust — official actual-holdings endpoint, plain HTTP POST, no headless
// browser, no cookie. Verified 2026-09-25: https://www.kgifund.com.tw/Fund/RedemptionVC (POST,
// form-urlencoded `fundID=<FundID>&queryDate=`) returns the full holdings composition server-rendered in
// one response, keyed by KGI's internal FundID (not the market ticker). Unlike Cathay/Yuanta, KGI's own
// figures here are ALREADY the fund's actual total position — confirmed by cross-checking 00915: this
// endpoint's 聯電(2303) = 8,994,000 shares is an EXACT match to the fund's separate "持股比重" actual-
// holdings tab, and bond face values (00777B) are only consistent with real total holdings, not a
// 500,000-unit creation basket (basket-scaled would exceed the fund's total NAV by >2x, which is
// impossible). So this adapter uses every returned quantity/face-value as-is — never scaled, never
// derived.
import * as cheerio from "cheerio";
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.kgifund.com.tw";

// market ticker -> official internal FundID. Captured verbatim from the official RedemptionList page's
// own <select> dropdowns (股票型/平衡型/債券型ETF, 6+2+10=18, one-time read 2026-09-25) and cross-verified
// against /Fund/Detail?fundID=X's own "ShortName (ticker)" heading for every entry. Never guessed. Not
// re-discovered at runtime — re-derive from the same two official pages if the issuer adds/removes an ETF.
const FUND_ID_MAP: Record<string, string> = {
  "00407A": "J024", "009816": "J023", "00952": "J020", "00938": "J017", "00926": "J016", "00915": "J015",
  "00981T": "J022", "00980T": "J021",
  "00950B": "J019", "00945B": "J018", "00890B": "J014", "00841B": "J009", "00840B": "J007", "00779B": "J006",
  "00778B": "J005", "00777B": "J004", "00750B": "J003", "00749B": "J002",
};

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[,%]/g, "").replace(/^TWD\$/, "").trim()) || 0;
}

export const KgiOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "KGI",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const fundID = FUND_ID_MAP[etfCode];
    if (!fundID) throw new Error(`KGI_UNMAPPED_ETF_${etfCode} — not in the official FundID map, never guessed`);

    const r = await fetch(`${BASE}/Fund/RedemptionVC`, {
      method: "POST",
      headers: { "User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded" },
      body: `fundID=${fundID}&queryDate=`,
      signal,
    });
    if (!r.ok) throw new Error(`KGI_HTTP_${r.status}_${etfCode}`);
    const html = await r.text();
    const $ = cheerio.load(html);

    const bodyText = $.root().text();
    // The real holdings date sits next to "每受益權單位淨資產價值" as "(YYYY/MM/DD)" — the page-header
    // "現金申購買回清單公告" date is a forward query/settlement date, never the actual holdings date.
    const dateMatch = bodyText.match(/\((\d{4}\/\d{2}\/\d{2})\)每受益權單位淨資產價值/);
    if (!dateMatch) throw new Error(`KGI_NO_DATE_${etfCode} — page markup changed, adapter needs re-verification`);
    const dataDate = dateMatch[1].replaceAll("/", "-");

    const navMatch = bodyText.match(/基金淨資產價值\(元\)\s*TWD\$([\d,]+)/);
    const unitsMatch = bodyText.match(/已發行受益權單位總數\s*([\d,]+)/);

    const positions: CanonicalPosition[] = [];

    // 股票 / 期貨: standard <table> markup, one table per h4.redemption-rest__sub-title section.
    $("h4.redemption-rest__sub-title").each((_, h4) => {
      const label = $(h4).text().trim();
      if (label !== "股票" && label !== "期貨") return;
      const table = $(h4).parent().find("table").first();
      table.find("tbody tr").each((__, tr) => {
        const cells = $(tr).find("td").map((___, td) => $(td).text().trim()).get();
        if (cells.length < 4) return;
        const code = cells[0];
        if (!code) return;
        if (label === "股票") {
          positions.push({
            securityCode: code, securityName: cells[1] ?? "",
            positionType: "EQUITY", positionAmount: num(cells[2]), positionUnit: "SHARES",
            weight: num(cells[3]), canonicalSecurityId: null,
          });
        } else {
          positions.push({
            securityCode: code, securityName: cells[1] ?? "",
            positionType: "FUTURE", positionAmount: num(cells[2]), positionUnit: "CONTRACTS",
            weight: num(cells[3]), canonicalSecurityId: null,
          });
        }
      });
    });

    // 債劵: a <ul class="js-bond-list"><li><span>...</span></li> list, not a <table>.
    $("ul.js-bond-list li[name=content]").each((_, li) => {
      const cells = $(li).find("span").map((__, s) => $(s).text().trim()).get();
      if (cells.length < 5) return;
      const code = cells[0];
      if (!code) return;
      positions.push({
        securityCode: code, securityName: cells[1] ?? "",
        // Official par value ("面額") is cells[2]; market value ("市值") is cells[3] and is never used as
        // the position amount — bond par value must never be converted to a share-like unit.
        positionType: "BOND", positionAmount: num(cells[2]), positionUnit: "PAR_VALUE",
        weight: num(cells[4]), canonicalSecurityId: null,
      });
    });

    if (!positions.length) throw new Error(`KGI_NO_HOLDINGS_${etfCode}_${dataDate}`);

    return {
      etfCode,
      issuer: "KGI",
      assetType:
        positions.some((p) => p.positionType === "EQUITY") && positions.some((p) => p.positionType === "BOND") ? "MULTI_ASSET" :
        positions.some((p) => p.positionType === "BOND") ? "BOND" :
        positions.some((p) => p.positionType === "EQUITY") ? "EQUITY" : "OTHER",
      dataDate,
      announcementDate: dataDate,
      fundNav: num(navMatch?.[1]),
      outstandingUnits: num(unitsMatch?.[1]),
      positions,
      source: "KGI_OFFICIAL_ACTUAL_HOLDINGS_API",
      retrievedAt: new Date().toISOString(),
    };
  },
};
