// 2026-10-21（使用者核准）: VERIFIED root cause of the 85.5% core_universe_fund coverage gap's
// 520-fund "tdcc-offshore" slice -- the Yahoo fundId mapping (mapping.ts) was a ONE-TIME sweep
// seeded 2026-10-12 into a single checkpoint row and never rebuilt. Of the 532 APPROVED
// tdcc-offshore funds not in that frozen blob, 453 were created AFTER 2026-10-12 and never had any
// chance to be swept at all -- exactly the same "static list, new rows never added" pattern as the
// earlier active-ETF FUND_ID_MAP gap. This module makes the mapping self-extending: each run, find
// APPROVED tdcc-offshore funds not yet in the mapping and try to resolve them live via Yahoo TW's
// own fund search (the same family of endpoint navFetch.ts already calls), using the SAME strict
// rule the original one-time sweep used -- an EXACT full-string name match, and only when exactly
// one candidate matches exactly. Anything with zero or more-than-one exact match is left unmapped
// and reported with evidence (the search response), never guessed. A live spot-check (40-fund
// sample from the gap) found ~15% resolve this way; the rest are genuinely not in Yahoo TW's own
// fund database (niche currency/share-class variants Yahoo doesn't index), which is a source-side
// absence, not an ingestion bug -- those stay excluded and show up as UNRESOLVED in the run's own
// details for evidence, not silently dropped.
import type { QueryFn } from "./mapping";
import type { OffshoreMappingEntry } from "./types";

export type UnresolvedOffshoreFund = {
  fundId: string;
  code: string | null;
  name: string;
  reason: "NO_CANDIDATES" | "NO_EXACT_MATCH" | "AMBIGUOUS_MULTIPLE_EXACT" | "FETCH_ERROR";
  evidence: string; // candidate names/ids returned by Yahoo, or the error message -- never empty
};

type YahooFundSearchResult = { id: string; name: string };

async function searchYahooFund(keyword: string, signal?: AbortSignal): Promise<YahooFundSearchResult[]> {
  const query = JSON.stringify({ onshore: "2", q: keyword, limit: 10 });
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsSearch;query=${encodeURIComponent(query)}?bkt=&device=desktop&ecma=modern&intl=tw&lang=zh-Hant-TW&partner=none&region=TW&site=finance&tz=Asia%2FTaipei&ver=1.4.930&returnMeta=true`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 SmartFund Fund Research/1.0" }, signal });
  if (!res.ok) throw new Error(`YAHOO_FUND_SEARCH_HTTP_${res.status}`);
  const json = (await res.json()) as { data?: { funds?: YahooFundSearchResult[] } };
  return json.data?.funds ?? [];
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function findUnmappedTdccOffshoreFunds(query: QueryFn, alreadyMappedIds: Set<string>): Promise<Array<{ fundId: string; code: string | null; name: string }>> {
  const rows = await query(
    `SELECT c.asset_id AS id, f.code, f.name
       FROM tw_purchasable_classification c
       JOIN funds f ON f.id = c.asset_id
      WHERE c.asset_type = 'FUND' AND c.status = 'APPROVED' AND f.data_provider = 'tdcc-offshore'
      ORDER BY f.created_at DESC`, // newest first -- a brand-new fund mattering sooner than an old,
                                   // already-tried-and-failed one is the whole point of this fix
    [],
  );
  return rows.filter((r: { id: string }) => !alreadyMappedIds.has(r.id)).map((r: { id: string; code: string | null; name: string }) => ({ fundId: r.id, code: r.code, name: r.name }));
}

export async function discoverNewMappings(
  query: QueryFn,
  existingMapping: OffshoreMappingEntry[],
  timeBudgetMs: number,
  requestSpacingMs: number,
): Promise<{ discovered: OffshoreMappingEntry[]; unresolved: UnresolvedOffshoreFund[] }> {
  const startedMs = Date.now();
  const mappedIds = new Set(existingMapping.map((m) => m.fundId));
  const candidates = await findUnmappedTdccOffshoreFunds(query, mappedIds);
  const discovered: OffshoreMappingEntry[] = [];
  const unresolved: UnresolvedOffshoreFund[] = [];

  for (const fund of candidates) {
    if (Date.now() - startedMs > timeBudgetMs) break;
    try {
      const results = await searchYahooFund(fund.name, AbortSignal.timeout(10_000));
      const exact = results.filter((r) => r.name === fund.name);
      if (exact.length === 1) {
        discovered.push({ fundId: fund.fundId, code: fund.code ?? "", yahooFundId: exact[0].id });
      } else if (exact.length > 1) {
        unresolved.push({ fundId: fund.fundId, code: fund.code, name: fund.name, reason: "AMBIGUOUS_MULTIPLE_EXACT", evidence: exact.map((e) => e.id).join(", ") });
      } else if (results.length > 0) {
        unresolved.push({ fundId: fund.fundId, code: fund.code, name: fund.name, reason: "NO_EXACT_MATCH", evidence: results.slice(0, 5).map((r) => r.name).join(" | ") });
      } else {
        unresolved.push({ fundId: fund.fundId, code: fund.code, name: fund.name, reason: "NO_CANDIDATES", evidence: "Yahoo TW fund search returned 0 results for this fund's exact name" });
      }
    } catch (e) {
      unresolved.push({ fundId: fund.fundId, code: fund.code, name: fund.name, reason: "FETCH_ERROR", evidence: e instanceof Error ? e.message : String(e) });
    }
    await sleep(requestSpacingMs);
  }
  return { discovered, unresolved };
}
