import * as cheerio from "cheerio";
import type { ChainStage } from "./types.ts";

export const TPEX_INDUSTRY_CHAIN_SOURCE = "TPEx Industry Chain Information Platform";
export const TPEX_INDUSTRY_CHAIN_BASE_URL = "https://ic.tpex.org.tw";

export type TpexIndustryRef = { sourceId: string; name: string; sourceReference: string };
export type TpexNode = { sourceId: string; name: string; stage: ChainStage };
export type TpexMembership = {
  nodeSourceId: string;
  companyName: string;
  officialTicker: string | null;
  officialReference: string;
  marketCategory: string | null;
};
export type TpexIndustryDocument = {
  industry: TpexIndustryRef;
  nodes: TpexNode[];
  memberships: TpexMembership[];
};

const clean = (value: string) => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const stageOf = (label: string): ChainStage =>
  label.includes("上游") ? "UPSTREAM" : label.includes("中游") ? "MIDSTREAM" : label.includes("下游") ? "DOWNSTREAM" : "UNSPECIFIED";

export function parseTpexIndustryIndex(html: string): TpexIndustryRef[] {
  const $ = cheerio.load(html);
  const found = new Map<string, TpexIndustryRef>();
  $("a[href*='introduce.php?ic='], [onclick*='introduce.php?ic=']").each((_index, element) => {
    const raw = $(element).attr("href") ?? $(element).attr("onclick") ?? "";
    const match = raw.match(/[?&]ic=([A-Za-z0-9]+)/);
    if (!match) return;
    const sourceId = match[1].toUpperCase();
    const name = clean($(element).text()).replace(/^◈\s*/, "");
    if (name && !found.has(sourceId)) found.set(sourceId, { sourceId, name, sourceReference: `${TPEX_INDUSTRY_CHAIN_BASE_URL}/introduce.php?ic=${sourceId}` });
  });
  return [...found.values()];
}

export function parseTpexIndustryPage(html: string, ref: TpexIndustryRef): TpexIndustryDocument {
  const $ = cheerio.load(html);
  const nodes: TpexNode[] = [];
  const memberships: TpexMembership[] = [];
  $(".company-chain-panel[id^='ic_link_']").each((_index, element) => {
    const sourceId = ($(element).attr("id") ?? "").replace(/^ic_link_/, "");
    if (!sourceId) return;
    const stage = stageOf(clean($(element).closest(".chain").find(".chain-title-panel").first().text()));
    nodes.push({ sourceId, name: clean($(element).text()), stage });
    const list = $(`#companyList_${sourceId}`);
    list.find("tr").each((_rowIndex, row) => {
      const category = clean($(row).find("td").first().text()).match(/^([^（(]+)[（(]/)?.[1]?.trim() ?? null;
      $(row).find("a.company-text-over").each((_companyIndex, link) => {
        const href = $(link).attr("href") ?? "";
        const ticker = href.match(/[?&]stk_code=([^&#]+)/)?.[1] ?? null;
        memberships.push({ nodeSourceId: sourceId, companyName: clean($(link).text()), officialTicker: ticker ? decodeURIComponent(ticker) : null, officialReference: new URL(href, `${TPEX_INDUSTRY_CHAIN_BASE_URL}/`).href, marketCategory: category });
      });
    });
  });
  return { industry: ref, nodes, memberships };
}

export class TpexIndustryChainAdapter {
  private readonly fetcher: typeof fetch;
  private readonly delayMs: number;
  constructor(fetcher: typeof fetch = fetch, delayMs = 750) {
    this.fetcher = fetcher;
    this.delayMs = delayMs;
  }
  private async get(url: string) {
    const response = await this.fetcher(url, { headers: { Accept: "text/html", "User-Agent": "SmartFund private research industry-chain importer/1.0" } });
    if (!response.ok) throw new Error(`TPEx request failed (${response.status}) for ${url}`);
    return response.text();
  }
  async discover() { return parseTpexIndustryIndex(await this.get(`${TPEX_INDUSTRY_CHAIN_BASE_URL}/index.php`)); }
  async fetchIndustry(ref: TpexIndustryRef) { return parseTpexIndustryPage(await this.get(ref.sourceReference), ref); }
  async wait() { if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs)); }
}
