// 2026-10-30（使用者核准）: 基金期間報酬率大量UNAVAILABLE的根因——有code的5859檔基金裡，3731檔
// 從未嘗試過Yahoo mapping（fund_provider_mappings完全沒有provider='yahoo'的列），FUND_RETURNS_SYNC
// 的mapping來源(loadDomesticYahooMapping)只讀既有mapping、從不自己發現新的。這支模組補上「發現」
// 那一步，沿用lib/offshore-nav-sync/discoverMapping.ts已經驗證過的Yahoo TW fund search、exact-name
// 比對規則（同一個search API、同一套比對邏輯，只是目標從tdcc-offshore基金換成domestic基金）。
//
// 範圍（使用者核准）：只處理 tw_purchasable_classification.status='APPROVED' 且 funds.data_provider
// 不是 yahoo/SEC/tdcc-offshore（這三種已經有各自的mapping來源）、且 fund_provider_mappings 完全沒有
// provider='yahoo' 的列（從未嘗試過，不是「上次沒配對到」）——VERIFIED這個範圍是3220檔。
//
// 節奏：每次呼叫一批，游標用fund id排序接續（跑完一圈回到NULL），請求之間至少
// REQUEST_SPACING_MS，遇到HTTP 429/403立刻整批中止（不繞過），等下一次排程自然重試。
//
// SHADOW MODE BY DEFAULT: FUND_YAHOO_MAPPING_BACKFILL_WRITE不是"on"時，只做搜尋比對、不寫
// fund_provider_mappings，dry-run結果一樣進production_scheduler_runs的details方便稽核。
export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type BackfillCandidate = { fundId: string; code: string | null; name: string };

export type BackfillOutcome =
  | { fundId: string; code: string | null; name: string; result: "MATCHED"; yahooId: string }
  | { fundId: string; code: string | null; name: string; result: "NO_EXACT_MATCH" | "AMBIGUOUS_MULTIPLE_EXACT" | "NO_CANDIDATES"; evidence: string }
  | { fundId: string; code: string | null; name: string; result: "RATE_LIMITED" | "FETCH_ERROR"; evidence: string };

const normalizeWs = (s: string) => s.replace(/\s+/g, "");

// 2026-10-30（使用者核准，VERIFIED live dry-run發現）: TDCC官方基金全名慣例在結尾加上法遵警語
// 括號（例如"...N類型(本基金配息來源可能為本金)"），但Yahoo TW fund search自己的基金名稱完全不帶
// 這段警語——用全名下去搜尋，Yahoo回傳0筆結果，不是比對規則太嚴格，是查詢關鍵字本身就查不到。
// 只去掉結尾「看起來像警語」的括號（內容含配息/本金/平準金/保證收益/風險其中之一關鍵字）才清除，
// 刻意不盲目去掉每一個結尾括號——像"(避險)"這種是share class真正的一部分，去掉會讓比對配到錯的
// 級別（例如誤配到無避險版本），這裡的keyword gate就是防止這種false positive。
const DISCLAIMER_KEYWORDS = /配息|本金|平準金|保證收益|風險/;
function stripTrailingDisclaimer(name: string): string {
  let s = name;
  for (let i = 0; i < 3; i++) {
    const m = s.match(/^(.*?)[（(]([^（）()]*)[）)]\s*$/);
    if (!m) break;
    if (!DISCLAIMER_KEYWORDS.test(m[2])) break;
    const stripped = m[1].trim();
    if (!stripped) break;
    s = stripped;
  }
  return s;
}

type YahooFundSearchResult = { id: string; name: string };

async function searchYahooFund(keyword: string, signal?: AbortSignal): Promise<YahooFundSearchResult[]> {
  const query = JSON.stringify({ onshore: "2", q: keyword, limit: 10 });
  const url = `https://tw.stock.yahoo.com/_td-stock/api/resource/FundServices.fundsSearch;query=${encodeURIComponent(query)}?bkt=&device=desktop&ecma=modern&intl=tw&lang=zh-Hant-TW&partner=none&region=TW&site=finance&tz=Asia%2FTaipei&ver=1.4.930&returnMeta=true`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 SmartFund Fund Research/1.0" }, signal });
  if (res.status === 429 || res.status === 403) throw new RateLimitedError(`HTTP_${res.status}`);
  if (!res.ok) throw new Error(`YAHOO_FUND_SEARCH_HTTP_${res.status}`);
  const json = (await res.json()) as { data?: { funds?: YahooFundSearchResult[] } };
  return json.data?.funds ?? [];
}

export class RateLimitedError extends Error {}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function findBackfillCandidates(query: QueryFn, afterFundId: string | null, limit: number): Promise<BackfillCandidate[]> {
  const rows = await query(
    `SELECT f.id AS "fundId", f.code, f.name
       FROM tw_purchasable_classification c
       JOIN funds f ON f.id = c.asset_id
      WHERE c.asset_type = 'FUND' AND c.status = 'APPROVED'
        AND COALESCE(f.data_provider, '') NOT IN ('yahoo', 'SEC', 'tdcc-offshore')
        AND NOT EXISTS (SELECT 1 FROM fund_provider_mappings m WHERE m.fund_id = f.id AND m.provider = 'yahoo')
        AND ($1::text IS NULL OR f.id > $1)
      ORDER BY f.id ASC
      LIMIT $2`,
    [afterFundId, limit],
  );
  return rows.map((r: { fundId: string; code: string | null; name: string }) => ({ fundId: r.fundId, code: r.code, name: r.name }));
}

// Dry-run or (when writeEnabled) real: resolves one batch of candidates via Yahoo TW fund search.
// Stops the ENTIRE batch (not just the one candidate) the moment a 429/403 is seen -- same
// "no bypass, wait for next scheduled run" rule CLAUDE.md requires elsewhere in this project.
export async function runMappingBackfillBatch(
  candidates: BackfillCandidate[],
  requestSpacingMs: number,
): Promise<{ outcomes: BackfillOutcome[]; rateLimitStop: boolean; lastAttemptedFundId: string | null }> {
  const outcomes: BackfillOutcome[] = [];
  let rateLimitStop = false;
  let lastAttemptedFundId: string | null = null;
  for (const c of candidates) {
    lastAttemptedFundId = c.fundId;
    try {
      const searchName = stripTrailingDisclaimer(c.name);
      const results = await searchYahooFund(searchName, AbortSignal.timeout(10_000));
      const exact = results.filter((r) => r.name === searchName || normalizeWs(r.name) === normalizeWs(searchName));
      if (exact.length === 1) {
        outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "MATCHED", yahooId: exact[0].id });
      } else if (exact.length > 1) {
        outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "AMBIGUOUS_MULTIPLE_EXACT", evidence: exact.map((e) => e.id).join(", ") });
      } else if (results.length > 0) {
        outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "NO_EXACT_MATCH", evidence: results.slice(0, 5).map((r) => r.name).join(" | ") });
      } else {
        outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "NO_CANDIDATES", evidence: "Yahoo TW fund search returned 0 results" });
      }
    } catch (e) {
      if (e instanceof RateLimitedError) {
        outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "RATE_LIMITED", evidence: e.message });
        rateLimitStop = true;
        break; // stop the whole batch, no retry-bypass
      }
      outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "FETCH_ERROR", evidence: e instanceof Error ? e.message : String(e) });
    }
    await sleep(requestSpacingMs);
  }
  return { outcomes, rateLimitStop, lastAttemptedFundId };
}

export async function writeMatchedMappings(executeFn: (sql: string, params: any[]) => Promise<unknown>, outcomes: BackfillOutcome[]): Promise<number> {
  let written = 0;
  for (const o of outcomes) {
    if (o.result !== "MATCHED") continue;
    await executeFn(
      `INSERT INTO fund_provider_mappings (id, fund_id, provider, provider_code, status, source, mapping_method, verified_at, last_checked_at, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, 'yahoo', $2, 'MATCHED', 'YAHOO_TW_FUND_SEARCH_EXACT_NAME', 'EXACT_NAME_MATCH_BACKFILL', NOW(), NOW(), NOW(), NOW())
       ON CONFLICT (fund_id, provider) DO UPDATE SET provider_code = EXCLUDED.provider_code, status = 'MATCHED', last_checked_at = NOW(), updated_at = NOW()`,
      [o.fundId, o.yahooId],
    );
    written++;
  }
  return written;
}
