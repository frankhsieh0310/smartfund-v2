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
//
// 2026-10-30（使用者核准，規則二）: 第一輪正式執行VERIFIED 6/14檔是NO_CANDIDATES（Yahoo對我方
// 全名+去警語後的字串搜尋仍回傳0筆）——VERIFIED根因是share class的寫法結構不同（標點、順序），
// 不是基金真的不存在。加兩條規則都「用確定欄位核實、不靠猜字串像不像」：
//   規則一：比對前把全形「－」、半形「-」跟空白都正規化掉，仍要求完全相符。
//   規則二：規則一仍對不上時，從同一次base-name搜尋結果裡，用三個獨立欄位做交叉核實——
//     (a) 幣別完全相同（funds.currency 對 Yahoo currencyName，固定對照表，對不上的貨幣一律不比對）
//     (b) 累積/配息型態要一致（從名稱關鍵字判斷雙方，任一方判斷不出來就不比對這個候選）
//     (c) 同一天的淨值（funds.latestNavDate 對 Yahoo latestPriceDate 要同一天）相差在0.1%以內
//   三個條件都通過的候選必須剛好一檔才算配對成功，兩檔以上或零檔都維持不配對。刻意不比較級別
//   字母本身像不像（A/B/N/R/S...)，但三個條件篩完如果剩兩個不同級別的候選，就是「零檔」或
//   「多檔」而被拒絕——不會把A類誤配到R類，因為不同級別通常淨值不同、沒辦法同時通過(c)。
//
// 2026-10-30（使用者核准，第二輪修正——規則二在實測上沒有增量，根因是搜尋字串本身回傳0筆）:
//   VERIFIED Yahoo搜尋API對「去警語但仍帶級別/幣別/配息型後綴」的查詢字串，大部分直接回傳0筆，
//   不是回傳了格式不符的候選——規則二的交叉核實因此沒有候選池可篩，不是比對邏輯的問題。
//   修正：
//   1. 搜尋改用「基金名稱本身」（toBaseName()：去掉級別代號、幣別、配息型後綴），取得候選池；
//      核實仍然只靠幣別/累積配息型態/同日淨值±0.1%這三個確定欄位，不靠base name字串像不像。
//   2. 累積/配息型態判斷不出來、但名稱帶級別代號（例如N9類型、S類型、A類、B類）的，改成比對
//      「級別代號完全相同」(extractLevelCode()) + 幣別 + 同日淨值±0.1%，一樣要求剛好一檔。
//   3. 範圍排除ETF（f.name LIKE '%ETF%'）：ETF的報酬率顯示邏輯跟一般基金不同，不在這個backfill
//      的範圍內處理，另外在ETF頁面確認。
//   這兩條規則都不比較級別字母本身「像不像」，只比對完全相同的欄位值，篩完剩兩個不同級別的候選
//   會因為淨值或級別代號對不上而被拒絕（零檔或多檔），不會配錯級別。
export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

export type BackfillCandidate = {
  fundId: string;
  code: string | null;
  name: string;
  currency: string | null;
  latestNav: number | null;
  latestNavDate: string | null; // YYYY-MM-DD
};

export type BackfillOutcome =
  | { fundId: string; code: string | null; name: string; result: "MATCHED"; yahooId: string; matchedVia: "EXACT_NAME" | "CROSS_CHECK" | "LEVEL_CODE" }
  | { fundId: string; code: string | null; name: string; result: "NO_EXACT_MATCH" | "AMBIGUOUS_MULTIPLE_EXACT" | "NO_CANDIDATES"; evidence: string }
  | { fundId: string; code: string | null; name: string; result: "RATE_LIMITED" | "FETCH_ERROR"; evidence: string };

const normalizeWs = (s: string) => s.replace(/\s+/g, "");
// 全形「－」(U+FF0D)、數學減號「−」(U+2212)、半形「-」(U+002D) 一律正規化成同一個字元再比對。
const normalizeDash = (s: string) => s.replace(/[－−]/g, "-");
const normalizeForMatch = (s: string) => normalizeWs(normalizeDash(s));

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

// funds.currency(ISO) -> Yahoo TW fund search的currencyName(中文)固定對照。沒列在這裡的貨幣，
// 規則二一律跳過（不比對，不猜）。
const CURRENCY_MAP: Record<string, string> = {
  TWD: "新台幣",
  USD: "美元",
  CNY: "人民幣",
  JPY: "日幣",
  AUD: "澳幣",
  ZAR: "南非幣",
  EUR: "歐元",
  NZD: "紐幣",
};

type DistType = "ACCUMULATING" | "DISTRIBUTING";
function inferDistType(name: string): DistType | null {
  if (/不配息/.test(name)) return "ACCUMULATING";
  if (/累積/.test(name)) return "ACCUMULATING";
  if (/配息|月配|季配|分配|雙月配|年配/.test(name)) return "DISTRIBUTING";
  return null;
}

// 累積/配息型態判斷不出來時的備援：抓名稱裡的級別代號（N9類型、S類型、A類、B類…）。只在雙方
// 代號完全相同時才算核實通過，不比較代號字母本身「像不像」。
function extractLevelCode(name: string): string | null {
  const m1 = name.match(/([A-Za-z]{1,2}[0-9]{0,2})\s*類型/);
  if (m1) return m1[1].toUpperCase();
  const m2 = name.match(/([A-Za-z]{1,2})類(?!型)/);
  if (m2) return m2[1].toUpperCase();
  return null;
}

// 搜尋用的「基金家族名稱」：去掉警語括號、其他括號（通常裝幣別/配息型）、第一個dash之後的級別/
// 幣別/計價後綴，以及常見的級別代號、幣別、配息型關鍵字尾段。核實仍然只靠幣別/型態/淨值這三個
// 確定欄位，所以這裡就算切得不夠乾淨，最多只是候選池變大或變小，不會讓錯誤的候選通過核實。
const TRAILING_SUFFIX_RE =
  /(新台幣|新臺幣|美元|人民幣|南非幣|澳幣|日幣|歐元|紐幣|計價|不配息|累積型|配息型|月配|季配|分配|年配|雙月配|[A-Za-z]{1,3}[0-9]{0,2}類型?)+$/;

function toBaseName(name: string): string {
  let s = normalizeDash(stripTrailingDisclaimer(name));
  s = s.replace(/[（(][^）)]*[）)]/g, "").trim();
  const dashIdx = s.indexOf("-");
  if (dashIdx > 0) s = s.slice(0, dashIdx).trim();
  let prev: string;
  do {
    prev = s;
    s = s.replace(TRAILING_SUFFIX_RE, "").trim();
  } while (s !== prev && s.length > 0);
  return s || name;
}

type YahooFundSearchResult = { id: string; name: string; currencyName: string | null; price: string | null; latestPriceDate: string | null };

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
    `SELECT f.id AS "fundId", f.code, f.name, f.currency, f.latest_nav::text AS "latestNav", to_char(f.latest_nav_date, 'YYYY-MM-DD') AS "latestNavDate"
       FROM tw_purchasable_classification c
       JOIN funds f ON f.id = c.asset_id
      WHERE c.asset_type = 'FUND' AND c.status = 'APPROVED'
        AND COALESCE(f.data_provider, '') NOT IN ('yahoo', 'SEC', 'tdcc-offshore')
        AND NOT EXISTS (SELECT 1 FROM fund_provider_mappings m WHERE m.fund_id = f.id AND m.provider = 'yahoo')
        AND f.name NOT LIKE '%ETF%'
        AND ($1::text IS NULL OR f.id > $1)
      ORDER BY f.id ASC
      LIMIT $2`,
    [afterFundId, limit],
  );
  return rows.map((r: { fundId: string; code: string | null; name: string; currency: string | null; latestNav: string | null; latestNavDate: string | null }) => ({
    fundId: r.fundId, code: r.code, name: r.name, currency: r.currency,
    latestNav: r.latestNav != null ? Number(r.latestNav) : null, latestNavDate: r.latestNavDate,
  }));
}

// 規則二：exact-name比對失敗後，從同一批搜尋結果用幣別+累積/配息型態+同日淨值(±0.1%)三個獨立
// 欄位交叉核實，剛好一檔通過全部三個條件才算配對成功。
function resolveViaCrossCheck(candidate: BackfillCandidate, searchResults: YahooFundSearchResult[]): { yahooId: string } | null {
  const ourCurrencyName = candidate.currency ? CURRENCY_MAP[candidate.currency] : null;
  if (!ourCurrencyName) return null; // 貨幣不在對照表裡，不比對
  const ourDistType = inferDistType(candidate.name);
  if (!ourDistType) return null; // 我方型態判斷不出來，不比對
  if (candidate.latestNav == null || !candidate.latestNavDate) return null; // 沒有我方淨值可核實，不比對
  const ourNav = candidate.latestNav;
  const ourNavDate = candidate.latestNavDate;

  const survivors = searchResults.filter((r) => {
    if (r.currencyName !== ourCurrencyName) return false;
    const theirDistType = inferDistType(r.name);
    if (!theirDistType || theirDistType !== ourDistType) return false;
    if (!r.latestPriceDate || r.latestPriceDate !== ourNavDate) return false;
    const theirPrice = r.price != null ? Number(r.price) : null;
    if (theirPrice == null || !Number.isFinite(theirPrice) || ourNav === 0) return false;
    const diffPct = Math.abs(theirPrice - ourNav) / ourNav;
    return diffPct <= 0.001;
  });
  return survivors.length === 1 ? { yahooId: survivors[0].id } : null;
}

// 規則二備援：累積/配息型態判斷不出來但雙方都有級別代號時，改用「級別代號完全相同」取代型態
// 比對，幣別跟同日淨值±0.1%兩個條件不變，一樣要求剛好一檔。
function resolveViaLevelCode(candidate: BackfillCandidate, searchResults: YahooFundSearchResult[]): { yahooId: string } | null {
  const ourCurrencyName = candidate.currency ? CURRENCY_MAP[candidate.currency] : null;
  if (!ourCurrencyName) return null;
  const ourLevelCode = extractLevelCode(candidate.name);
  if (!ourLevelCode) return null;
  if (candidate.latestNav == null || !candidate.latestNavDate) return null;
  const ourNav = candidate.latestNav;
  const ourNavDate = candidate.latestNavDate;

  const survivors = searchResults.filter((r) => {
    if (r.currencyName !== ourCurrencyName) return false;
    const theirLevelCode = extractLevelCode(r.name);
    if (!theirLevelCode || theirLevelCode !== ourLevelCode) return false;
    if (!r.latestPriceDate || r.latestPriceDate !== ourNavDate) return false;
    const theirPrice = r.price != null ? Number(r.price) : null;
    if (theirPrice == null || !Number.isFinite(theirPrice) || ourNav === 0) return false;
    const diffPct = Math.abs(theirPrice - ourNav) / ourNav;
    return diffPct <= 0.001;
  });
  return survivors.length === 1 ? { yahooId: survivors[0].id } : null;
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
      const disclaimerStripped = stripTrailingDisclaimer(c.name);
      const searchName = toBaseName(c.name);
      const results = await searchYahooFund(searchName, AbortSignal.timeout(10_000));
      const exact = results.filter(
        (r) => r.name === disclaimerStripped || normalizeForMatch(r.name) === normalizeForMatch(disclaimerStripped),
      );
      if (exact.length === 1) {
        outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "MATCHED", yahooId: exact[0].id, matchedVia: "EXACT_NAME" });
      } else if (exact.length > 1) {
        outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "AMBIGUOUS_MULTIPLE_EXACT", evidence: exact.map((e) => e.id).join(", ") });
      } else {
        const viaDistType = resolveViaCrossCheck(c, results);
        const viaLevelCode = viaDistType ? null : resolveViaLevelCode(c, results);
        const crossChecked = viaDistType ?? viaLevelCode;
        if (crossChecked) {
          const matchedVia: "CROSS_CHECK" | "LEVEL_CODE" = viaDistType ? "CROSS_CHECK" : "LEVEL_CODE";
          outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "MATCHED", yahooId: crossChecked.yahooId, matchedVia });
        } else if (results.length > 0) {
          outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "NO_EXACT_MATCH", evidence: results.slice(0, 5).map((r) => r.name).join(" | ") });
        } else {
          outcomes.push({ fundId: c.fundId, code: c.code, name: c.name, result: "NO_CANDIDATES", evidence: "Yahoo TW fund search returned 0 results" });
        }
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
       VALUES (gen_random_uuid()::text, $1, 'yahoo', $2, 'MATCHED', 'YAHOO_TW_FUND_SEARCH_EXACT_NAME', $3, NOW(), NOW(), NOW(), NOW())
       ON CONFLICT (fund_id, provider) DO UPDATE SET provider_code = EXCLUDED.provider_code, status = 'MATCHED', last_checked_at = NOW(), updated_at = NOW()`,
      [
        o.fundId,
        o.yahooId,
        o.matchedVia === "CROSS_CHECK"
          ? "EXACT_NAME_MATCH_BACKFILL_CROSS_CHECK"
          : o.matchedVia === "LEVEL_CODE"
            ? "EXACT_NAME_MATCH_BACKFILL_LEVEL_CODE"
            : "EXACT_NAME_MATCH_BACKFILL",
      ],
    );
    written++;
  }
  return written;
}
