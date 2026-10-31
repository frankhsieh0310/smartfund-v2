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

type YahooFundSearchResult = { id: string; name: string; currencyName?: string };

async function searchYahooFund(keyword: string, signal?: AbortSignal): Promise<YahooFundSearchResult[]> {
  const query = JSON.stringify({ onshore: "2", q: keyword, limit: 10 });
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsSearch;query=${encodeURIComponent(query)}?bkt=&device=desktop&ecma=modern&intl=tw&lang=zh-Hant-TW&partner=none&region=TW&site=finance&tz=Asia%2FTaipei&ver=1.4.930&returnMeta=true`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 SmartFund Fund Research/1.0" }, signal });
  if (!res.ok) throw new Error(`YAHOO_FUND_SEARCH_HTTP_${res.status}`);
  const json = (await res.json()) as { data?: { funds?: YahooFundSearchResult[] } };
  return json.data?.funds ?? [];
}

// 2026-10-31（使用者核准，AMBIGUOUS_MULTIPLE_EXACT用幣別去重）: VERIFIED「貝萊德世界礦業基金
// A2美元」這類案例——Yahoo搜尋同一個顯示名稱回傳2筆，但currencyName分別是「歐元」跟「美元」，
// 跟我方funds.currency(應該是USD)比對後只有一筆吻合。只用來NARROW已經通過exact-name比對的
// 候選，幣別不只縮到1筆才採用；0筆或還是2筆以上一律維持AMBIGUOUS_MULTIPLE_EXACT，不猜。
const YAHOO_CURRENCY_NAME_TO_ISO: Record<string, string> = {
  "美元": "USD", "歐元": "EUR", "日圓": "JPY", "日元": "JPY", "英鎊": "GBP", "港幣": "HKD",
  "澳幣": "AUD", "紐幣": "NZD", "加幣": "CAD", "瑞士法郎": "CHF", "人民幣": "CNY",
  "新加坡幣": "SGD", "南非幣": "ZAR", "瑞典幣": "SEK", "挪威幣": "NOK", "丹麥幣": "DKK",
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function findUnmappedTdccOffshoreFunds(query: QueryFn, alreadyMappedIds: Set<string>): Promise<Array<{ fundId: string; code: string | null; name: string; currency: string | null }>> {
  const rows = await query(
    `SELECT c.asset_id AS id, f.code, f.name, f.currency
       FROM tw_purchasable_classification c
       JOIN funds f ON f.id = c.asset_id
      WHERE c.asset_type = 'FUND' AND c.status = 'APPROVED' AND f.data_provider = 'tdcc-offshore'
      ORDER BY f.created_at DESC`, // newest first -- a brand-new fund mattering sooner than an old,
                                   // already-tried-and-failed one is the whole point of this fix
    [],
  );
  return rows.filter((r: { id: string }) => !alreadyMappedIds.has(r.id)).map((r: { id: string; code: string | null; name: string; currency: string | null }) => ({ fundId: r.id, code: r.code, name: r.name, currency: r.currency }));
}

// 2026-10-31（VERIFIED，新加坡大華2檔mapping被discovery重新寫回同一個壞對應）: Yahoo TW的
// fundsSearch對「新加坡大華全球成長基金(美元)」「新加坡大華全球科技基金(美元)」這2檔基金名稱
// EXACT match只回傳1個結果（符合這裡的比對規則），但那個id實際指向另一個級別/基金（VERIFIED
// F0HKG062HN:FO、F0HKG062HM:FO回傳的淨值跟TDCC官方值差了25%+）——這是Yahoo搜尋結果本身的問題，
// 不是比對規則太寬鬆，調嚴規則也擋不住。手動把這2筆從mapping移除後，discovery下一輪又會把它們
// 當成「還沒mapping過的候選」重新搜尋、重新寫回同一個錯誤id。永久排除，讓它們改由
// offshore-nav-tdcc-sync（TDCC CSV名稱比對，VERIFIED正確）涵蓋。
const PERMANENTLY_EXCLUDED_FROM_DISCOVERY = new Set([
  "31d4e169-18f9-485f-b6a6-c0f8da9a17cc", // 新加坡大華全球成長基金(美元)
  "6ead7c6e-44a4-4b38-8c7a-4fd70973b7f1", // 新加坡大華全球科技基金(美元)
]);

export async function discoverNewMappings(
  query: QueryFn,
  existingMapping: OffshoreMappingEntry[],
  timeBudgetMs: number,
  requestSpacingMs: number,
  alreadyTriedToday: Set<string> = new Set(),
): Promise<{ discovered: OffshoreMappingEntry[]; unresolved: UnresolvedOffshoreFund[]; attemptedThisRun: string[] }> {
  const startedMs = Date.now();
  const mappedIds = new Set(existingMapping.map((m) => m.fundId));
  // 2026-10-28（使用者核准修正，「39檔境外淨值落後」根因）: candidates本身固定ORDER BY
  // created_at DESC，沒有這層「今天已經試過」過濾的話，時間預算用完時永遠只處理得到清單最前面
  // 那一截，後面的候選排不到第二次機會——見completion.ts的DISCOVERY_PROGRESS_CHECKPOINT_KEY
  // 說明。這裡只是「跳過今天試過的」，不改變任何既有的exact-name比對規則本身。
  const candidates = (await findUnmappedTdccOffshoreFunds(query, mappedIds))
    .filter((c) => !alreadyTriedToday.has(c.fundId))
    .filter((c) => !PERMANENTLY_EXCLUDED_FROM_DISCOVERY.has(c.fundId));
  const discovered: OffshoreMappingEntry[] = [];
  const unresolved: UnresolvedOffshoreFund[] = [];
  const attemptedThisRun: string[] = [];

  // 2026-10-26（使用者核准範圍）: 查「51檔境外淨值落後」原因，VERIFIED 多數NO_EXACT_MATCH
  // 的evidence其實是同一檔基金、只差在Yahoo那邊的名稱沒有空白（例如我方「貝萊德中國基金 A2
  // 美元」對Yahoo「貝萊德中國基金A2美元」）——不是猜測性模糊比對，去掉空白後是逐字相同的
  // 官方基金全名，比對規則本身過嚴格才漏掉。只正規化空白，不做任何同義詞/相似度比對。
  const normalizeWs = (s: string) => s.replace(/\s+/g, "");
  for (const fund of candidates) {
    if (Date.now() - startedMs > timeBudgetMs) break;
    attemptedThisRun.push(fund.fundId);
    try {
      const results = await searchYahooFund(fund.name, AbortSignal.timeout(10_000));
      const exact = results.filter((r) => r.name === fund.name || normalizeWs(r.name) === normalizeWs(fund.name));
      if (exact.length === 1) {
        discovered.push({ fundId: fund.fundId, code: fund.code ?? "", yahooFundId: exact[0].id });
      } else if (exact.length > 1) {
        const byCurrency = fund.currency
          ? exact.filter((e) => e.currencyName && YAHOO_CURRENCY_NAME_TO_ISO[e.currencyName] === fund.currency)
          : [];
        if (byCurrency.length === 1) {
          discovered.push({ fundId: fund.fundId, code: fund.code ?? "", yahooFundId: byCurrency[0].id });
        } else {
          unresolved.push({ fundId: fund.fundId, code: fund.code, name: fund.name, reason: "AMBIGUOUS_MULTIPLE_EXACT", evidence: exact.map((e) => `${e.id}(${e.currencyName ?? "?"})`).join(", ") });
        }
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
  return { discovered, unresolved, attemptedThisRun };
}
