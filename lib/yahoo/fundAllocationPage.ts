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
export type FundManagerEntry = { familyName: string | null; givenName: string | null; middleName: string | null; role: string | null; startDate: string | null };
export type YahooFundAllocation = {
  sectors: AllocationEntry[];
  sectorsAsOf: string | null;
  regions: AllocationEntry[];
  regionsAsOf: string | null;
  // 2026-10-29: 同一頁本來就有managers陣列（經理人姓名/角色/到任日），跟sector/region一起解析，
  // 不另外多打一次請求。
  managers: FundManagerEntry[];
};

// 中文姓名（familyName是純中文字）用「姓+名」不留空格；西式姓名用「名 中間名 姓」留空格，
// 否則像"HardyAnthony"這種黏在一起的英文名字看不出斷字。
function managerFullName(m: FundManagerEntry): string {
  const parts = [m.familyName, m.givenName].filter(Boolean) as string[];
  if (parts.length === 0) return "";
  const isCjk = /^[一-鿿]+$/.test(m.familyName ?? "");
  if (isCjk) return parts.join("");
  return [m.givenName, m.middleName, m.familyName].filter(Boolean).join(" ");
}

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

  // managers陣列是同一頁頂層的一個key（不像regionHolding/sectorHolding包了一層），直接找
  // `"managers":[...]`這個陣列本身（用方括號配對，不是大括號）。
  let managers: FundManagerEntry[] = [];
  const managersKeyIndex = html.indexOf('"managers":[');
  if (managersKeyIndex !== -1) {
    const bracketStart = html.indexOf("[", managersKeyIndex);
    let depth = 0, bracketEnd = -1;
    for (let i = bracketStart; i < html.length; i++) {
      if (html[i] === "[") depth++;
      else if (html[i] === "]") { depth--; if (depth === 0) { bracketEnd = i; break; } }
    }
    if (bracketEnd !== -1) {
      try {
        const parsed = JSON.parse(html.slice(bracketStart, bracketEnd + 1));
        if (Array.isArray(parsed)) {
          managers = parsed.map((m: any) => ({ familyName: m.familyName ?? null, givenName: m.givenName ?? null, middleName: m.middleName ?? null, role: m.role ?? null, startDate: m.startDate ?? null }));
        }
      } catch { managers = []; }
    }
  }

  if (!regions.length && !sectors.length && !managers.length) return null;

  return {
    sectors, sectorsAsOf: sectorBlock.updated ?? null,
    regions, regionsAsOf: regionBlock.updated ?? null,
    managers,
  };
}

export { managerFullName };
