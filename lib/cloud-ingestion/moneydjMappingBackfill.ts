// 境內基金 MoneyDJ 代碼配對 backfill — 只配「缺持股的242檔基金」的基金層級（每檔基金只要配
// 一個級別），名稱精確比對，只有唯一一檔候選時才寫入。
//
// 2026-10-31（使用者核准）: 搜尋端點還沒確認可用(見moneydjSearchProbe.ts的除錯結果)，
// parseMoneydjSearchResults() 目前是未驗證的骨架——拿到除錯結果、看過真正的回應格式後才能把
// 解析邏輯填對。寫入開關 MONEYDJ_MAPPING_BACKFILL_WRITE 這輪保持關閉，不管解析對不對都不會
// 寫入 fund_mappings。
import { prisma } from "@/lib/prisma";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SEARCH_URL = "https://www.moneydj.com/funddjx/fundsearch.xdjhtm";

export class MoneydjSearchRateLimitedError extends Error {}

export type MoneydjSearchResult = { name: string; moneydjCode: string };

// UNVERIFIED：還沒看過真正的搜尋回應格式，這裡先假設回應裡每筆結果是
// <a href="...yp013000.djhtm?a=XXXX...">基金名稱</a> 這種常見的 MoneyDJ 連結格式，用正則抓
// (代碼, 名稱) 配對。確認後幾乎一定要重寫這個函式。
function parseMoneydjSearchResults(html: string): MoneydjSearchResult[] {
  const results: MoneydjSearchResult[] = [];
  const re = /yp013000\.djhtm\?a=([A-Za-z0-9]+)[^"]*"[^>]*>([^<]+)</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    results.push({ moneydjCode: m[1], name: m[2].trim() });
  }
  return results;
}

export async function searchMoneydjByName(name: string): Promise<MoneydjSearchResult[]> {
  const res = await fetch(`${SEARCH_URL}?keyword=${encodeURIComponent(name)}`, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 403 || res.status === 429) throw new MoneydjSearchRateLimitedError();
  if (!res.ok) return [];
  return parseMoneydjSearchResults(await res.text());
}

export type MappingCandidate = { baseCode: string; representativeFundId: string; canonicalName: string };

// 候選池：持股完全缺資料的242檔基金（基金層級），每檔只取一個代表級別（任何一個皆可，因為同一
// 基金代碼只需要配一次moneydj_code，其他級別透過既有的master-fund/read-time共用邏輯取得）。
export async function nextMappingCandidates(afterBaseCode: string | null, limit: number): Promise<MappingCandidate[]> {
  return prisma.$queryRawUnsafe<MappingCandidate[]>(
    `SELECT DISTINCT ON (base_code) base_code AS "baseCode", fund_id AS "representativeFundId", canonical_name AS "canonicalName"
       FROM (
         SELECT substring(f.code from '^[0-9]{8}') AS base_code, f.id AS fund_id, f.name AS canonical_name
           FROM funds f
           JOIN tw_purchasable_classification c ON c.asset_type = 'FUND' AND c.asset_id = f.id AND c.status = 'APPROVED'
          WHERE f.code ~ '^[0-9]{8}[A-Za-z]*$'
            AND f.id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)
            AND f.id NOT IN (SELECT fund_id FROM fund_mappings WHERE moneydj_code IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.fund_id = f.id)
       ) t
      WHERE ($1::text IS NULL OR base_code > $1)
      ORDER BY base_code
      LIMIT $2`,
    afterBaseCode,
    limit,
  );
}

// 名稱精確比對：MoneyDJ 搜尋結果裡，跟我方 canonicalName 完全相等（去除前後空白、基金種類／配息
// 警語等括號附註後比對本體名稱）才算候選；候選剛好只有一檔才回傳、多檔或零檔都不寫入。
function normalizeFundName(name: string): string {
  return name.replace(/[（(][^）)]*[）)]/g, "").trim();
}

export function pickUniqueExactMatch(canonicalName: string, searchResults: MoneydjSearchResult[]): MoneydjSearchResult | null {
  const target = normalizeFundName(canonicalName);
  const matches = searchResults.filter((r) => normalizeFundName(r.name) === target);
  const uniqueCodes = new Set(matches.map((m) => m.moneydjCode));
  return uniqueCodes.size === 1 ? matches[0] : null;
}
