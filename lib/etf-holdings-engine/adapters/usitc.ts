// Union (聯邦) Securities Investment Trust — official 申購買回清單/基金成分股 page, plain HTTP GET,
// server-rendered HTML, no headless browser, no cookie, no UA spoofing.
// VERIFIED 2026-11-05: the official page (https://www.usitc.com.tw/CustCenter/BuyBackList, reached from
// the site's own "申購買回清單" menu link) accepts `FundNo=<ticker>` directly as a query param — the
// ticker itself is the dropdown's own option value, never a separate internal id. The "基金成分股" tab
// is client-side show/hide only (no separate fetch): every row is already present in the single GET
// response's HTML, confirmed by counting <td data-title="股票代號"> cells (51 for a 50-constituent
// index fund — the extra one is a header artifact, not a missing row). Each fund's own fund-level note
// (e.g. the general fund page) exposes only a monthly PDF report — THIS page is the only official
// machine-parseable daily holdings source found for this issuer.
import * as cheerio from "cheerio";
import type { CanonicalPosition, CanonicalSnapshot, OfficialPcfAdapter } from "../types.ts";

const BASE = "https://www.usitc.com.tw/CustCenter/BuyBackList";

// This issuer's page accepts the market ticker directly as FundNo — no separate internal id exists,
// unlike every other adapter in this engine. The map still exists (rather than hardcoding the ticker
// into the URL inline) so the "which tickers does this adapter cover" question stays answerable the
// same way as every other adapter, and so an issuer that later DOES introduce an internal id only needs
// this one map updated.
export const FUND_ID_MAP: Record<string, string> = {
  "009804": "009804", "009825": "009825",
};

function num(s: string | undefined | null): number {
  if (!s) return 0;
  return Number(s.replace(/[^0-9.-]/g, "")) || 0;
}

export const UsitcOfficialPcfAdapter: OfficialPcfAdapter = {
  issuer: "USITC",

  async fetchSnapshot(etfCode: string, _date?: string, signal?: AbortSignal): Promise<CanonicalSnapshot> {
    const fundNo = FUND_ID_MAP[etfCode];
    if (!fundNo) throw new Error(`USITC_UNMAPPED_ETF_${etfCode} — not in the official FundNo map, never guessed`);

    const res = await fetch(`${BASE}?FundNo=${fundNo}`, { signal });
    if (!res.ok) throw new Error(`USITC_HTTP_${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    // "基金成分股" tab's own stepTitle/table blocks. Each asset-category table is introduced by its own
    // <h3>股票投資比例</h3> / <h3>債券投資比例</h3> / <h3>期貨投資比例</h3> heading, but NOT as that
    // table's direct parent/sibling — the actual markup is
    //   <div class="stepTitle"><h3>股票投資比例</h3></div><h3></h3><div class="stepTitle"><table>...
    // i.e. the table sits inside the NEXT .stepTitle div after an empty filler <h3>. Select by heading
    // text, then walk forward to the next .stepTitle sibling's own table, rather than assuming adjacency
    // — category order/presence varies by fund (e.g. 009825 has no bond/futures table at all).
    let dataDate: string | null = null;
    const dateMatch = /資料日期[：:]\s*(\d{4}-\d{2}-\d{2})/.exec(html);
    if (dateMatch) dataDate = dateMatch[1];
    if (!dataDate) throw new Error(`USITC_NO_DATA_DATE_${etfCode}`);

    const positions: CanonicalPosition[] = [];
    $("h3").each((_, h3el) => {
      const heading = $(h3el).text().trim();
      if (!["股票投資比例", "債券投資比例", "期貨投資比例"].includes(heading)) return;
      const headingBlock = $(h3el).parent(".stepTitle");
      const table = headingBlock.nextAll(".stepTitle").first().find("table").first();
      if (heading === "股票投資比例") {
        table.find("tr").each((__, tr) => {
          const code = $(tr).find('td[data-title="股票代號"]').text().trim();
          const name = $(tr).find('td[data-title="股票名稱"]').text().trim();
          const shares = $(tr).find('td[data-title="股數"]').text().trim();
          const weight = $(tr).find('td[data-title="權重"]').text().trim();
          if (!code) return;
          positions.push({
            securityCode: code, securityName: name, positionType: "EQUITY",
            positionAmount: num(shares), positionUnit: "SHARES", weight: num(weight),
            canonicalSecurityId: null,
          });
        });
      } else if (heading === "債券投資比例") {
        table.find("tr").each((__, tr) => {
          const code = $(tr).find('td[data-title="債券代號"]').text().trim();
          const name = $(tr).find('td[data-title="債券名稱"]').text().trim();
          const par = $(tr).find('td[data-title="面額"]').text().trim();
          const weight = $(tr).find('td[data-title="權重"]').text().trim();
          if (!code) return;
          positions.push({
            securityCode: code, securityName: name, positionType: "BOND",
            positionAmount: num(par), positionUnit: "PAR_VALUE", weight: num(weight),
            canonicalSecurityId: null,
          });
        });
      } else if (heading === "期貨投資比例") {
        table.find("tr").each((__, tr) => {
          const code = $(tr).find('td[data-title="期貨代碼"]').text().trim();
          const name = $(tr).find('td[data-title="期貨名稱"]').text().trim();
          const lots = $(tr).find('td[data-title="口數"]').text().trim();
          const weight = $(tr).find('td[data-title="權重"]').text().trim();
          if (!code) return;
          positions.push({
            securityCode: code, securityName: name, positionType: "FUTURE",
            positionAmount: num(lots), positionUnit: "CONTRACTS", weight: num(weight),
            canonicalSecurityId: null,
          });
        });
      }
    });
    if (!positions.length) throw new Error(`USITC_NO_HOLDINGS_${etfCode}`);

    // 基金資產 block (same tab) carries NAV/units, each in its own data-title cell.
    const fundNav = num($('td[data-title="基金每單位淨值"]').first().text());
    const outstandingUnits = num($('td[data-title="基金在外流通單位數"]').first().text());

    const hasBond = positions.some((p) => p.positionType === "BOND");
    return {
      etfCode,
      issuer: "USITC",
      assetType: hasBond ? "MULTI_ASSET" : "EQUITY",
      dataDate,
      announcementDate: dataDate,
      fundNav,
      outstandingUnits,
      positions,
      source: "USITC_OFFICIAL_BUYBACKLIST",
      retrievedAt: new Date().toISOString(),
    };
  },
};
