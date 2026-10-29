// Yahoo奇摩股市 fund "持股狀況" page (/holdings) — same page already embeds a structured
// regionHolding/sectorHolding JSON block (verified 2026-10-29 against a real fund page), reusing
// the exact balanced-object extraction technique already proven in lib/yahoo/fundPerformancePage.ts
// rather than a second scraping approach.
import { YahooFundRateLimitedError } from "./fundPerformancePage";

function extractBalancedObject(text: string, keyMarker: string): string | null {
  const keyIndex = text.indexOf(keyMarker);
  if (keyIndex === -1) return null;
  const braceStart = text.indexOf("{", keyIndex);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(braceStart, i + 1);
    }
  }
  return null;
}

export type AllocationEntry = { nameInChinese: string; weight: number };
export type YahooFundAllocation = {
  sectors: AllocationEntry[];
  sectorsAsOf: string | null;
  regions: AllocationEntry[];
  regionsAsOf: string | null;
};

/** yahooFundId must include the ":FO" suffix, e.g. "F0000155PU:FO" (same convention as
 * fetchYahooFundPerformance). Returns null when the page has neither block (e.g. a fund type Yahoo
 * doesn't publish a breakdown for) rather than throwing — that is not a failure to retry. */
export async function fetchYahooFundAllocation(yahooFundId: string): Promise<YahooFundAllocation | null> {
  const url = `https://tw.stock.yahoo.com/fund/${encodeURIComponent(yahooFundId)}/holdings`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new YahooFundRateLimitedError(res.status);
  if (!res.ok) return null;

  const html = await res.text();
  const parseEntries = (json: string | null): AllocationEntry[] => {
    if (!json) return [];
    try {
      const obj = JSON.parse(json) as { nameInChinese: string; weight: string }[];
      return Array.isArray(obj) ? obj.map((e) => ({ nameInChinese: e.nameInChinese, weight: Number(e.weight) })).filter((e) => Number.isFinite(e.weight)) : [];
    } catch {
      return [];
    }
  };

  const regionBlockJson = extractBalancedObject(html, '"regionHolding":{');
  const sectorBlockJson = extractBalancedObject(html, '"sectorHolding":{');
  let regionBlock: { updated?: string; regions?: unknown[] } = {};
  let sectorBlock: { updated?: string; sectors?: unknown[] } = {};
  try { regionBlock = regionBlockJson ? JSON.parse(regionBlockJson) : {}; } catch { regionBlock = {}; }
  try { sectorBlock = sectorBlockJson ? JSON.parse(sectorBlockJson) : {}; } catch { sectorBlock = {}; }

  const regions = parseEntries(regionBlock.regions ? JSON.stringify(regionBlock.regions) : null);
  const sectors = parseEntries(sectorBlock.sectors ? JSON.stringify(sectorBlock.sectors) : null);
  if (!regions.length && !sectors.length) return null;

  return {
    sectors, sectorsAsOf: sectorBlock.updated ?? null,
    regions, regionsAsOf: regionBlock.updated ?? null,
  };
}
