// New domestic / offshore FUND listing detection — separate from newListingDetection.ts (ETFs),
// because neither official feed here carries an establishment/approval date (confirmed this round:
// SITCA's own daily NAV CSV has no 成立日期 field; TDCC's offshore NAV dataset 3-4 has no 核備日
// field either — both are pure NAV feeds). Research this round also checked sfb.gov.tw, data.gov.tw,
// and fundclear.com.tw for any date-bearing new-fund source and found nothing live and
// machine-readable; a 2020-era FSC dataset (申請日期/核准日期 fields) exists but has not been
// updated since 2020-05-29 and is unusable.
//
// Because there is no date to filter a one-time "backfill gap" out of a true "new today" signal (the
// trick that works for ETFs via 上市日期), this uses a BASELINE-SEED pattern instead: the first time
// this pipeline ever runs for a given source, it silently records every code/name currently seen as
// a KNOWN_BASELINE row (no NEW_LISTING fired — firing on first run would misreport every
// already-existing-but-never-onboarded fund as "new"). From the second run onward, anything not in
// `funds` AND not already in the baseline is genuinely new since yesterday and gets a NEW_LISTING
// event with milestone_date = NULL (honest "官方未公告" — the TDCC/SITCA feeds cannot supply a date).
import { prisma } from "@/lib/prisma";
import { fetchSitcaRows, fetchSitcaIdentityRows } from "@/lib/sitca-nav-sync/sitcaFetch";
import { fetchTdccNavCsv, parseTdccNavCsv } from "@/lib/offshore-nav-sync/tdccBatchSource";
import { fetchTdccOffshoreBasicInfoNames } from "@/lib/tw-purchasable/tdccOffshoreBasicInfo";

const DOMESTIC_SOURCE = "SITCA nav.csv (基金統編 diff)";
const OFFSHORE_SOURCE = "TDCC opendata 3-4 (基金名稱 diff)";

type ProductType = "DOMESTIC_FUND" | "OFFSHORE_FUND";

async function knownKeys(productType: ProductType, source: string): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<{ code: string }[]>(
    `SELECT DISTINCT code FROM product_listing_events
     WHERE product_type = $1 AND source = $2 AND event_type IN ('KNOWN_BASELINE', 'NEW_LISTING')`,
    productType, source,
  );
  return new Set(rows.map((r) => r.code));
}

async function hasAnyBaseline(productType: ProductType, source: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM product_listing_events WHERE product_type = $1 AND source = $2 LIMIT 1`,
    productType, source,
  );
  return rows.length > 0;
}

// 2026-10-17 root-cause fix: this used to be one sequentially-awaited INSERT per row. The real
// SITCA/TDCC universe is thousands of rows, so a cold-start seed (or any run that has to log a
// large backlog of candidates) took far longer than Vercel's maxDuration and got hard-killed
// mid-loop -- a serverless timeout kill never reaches the catch block, so finishRun() never ran
// and the production_scheduler_runs row was left stuck IN_PROGRESS forever (VERIFIED: two such
// stuck rows from 2026-10-15/16, both with attempted=0/inserted=0/error=null -- the signature of a
// hard kill, not a thrown exception). Batched into chunked multi-row INSERTs instead: productType,
// milestoneKind and source are constant per call ($1/$2/$3), so only 2 params per row (code, name),
// keeping well under Postgres's bind param limit even at chunk size 1000.
const UPSERT_CHUNK_SIZE = 1000;

async function batchInsertEvents(
  eventType: "KNOWN_BASELINE" | "NEW_LISTING",
  milestoneKind: string | null,
  conflictAction: "DO NOTHING" | "DO UPDATE SET updated_at = now()",
  productType: ProductType,
  source: string,
  items: { key: string; name: string }[],
) {
  for (let i = 0; i < items.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = items.slice(i, i + UPSERT_CHUNK_SIZE);
    const values = chunk
      .map((_, idx) => `(gen_random_uuid(), $1, $${idx * 2 + 4}, $${idx * 2 + 5}, '${eventType}', NULL, $2, $3, NULL, now(), NULL, now(), now())`)
      .join(",\n");
    await prisma.$executeRawUnsafe(
      `INSERT INTO product_listing_events
         (id, product_type, code, name, event_type, milestone_date, milestone_kind, source, source_url, detected_at, product_id, created_at, updated_at)
       VALUES ${values}
       ON CONFLICT (product_type, code, event_type, source) ${conflictAction}`,
      productType, milestoneKind, source, ...chunk.flatMap((item) => [item.key, item.name]),
    );
  }
}

async function seedBaseline(productType: ProductType, source: string, items: { key: string; name: string }[]) {
  if (items.length === 0) return;
  await batchInsertEvents("KNOWN_BASELINE", null, "DO NOTHING", productType, source, items);
}

async function logNewFunds(productType: ProductType, source: string, items: { key: string; name: string }[]) {
  if (items.length === 0) return;
  await batchInsertEvents("NEW_LISTING", "官方未公告（來源僅提供淨值，無成立／核備日期欄位）", "DO UPDATE SET updated_at = now()", productType, source, items);
}

export type NewFundResult = {
  isFirstRun: boolean;
  seeded: number;
  newlyDetected: { key: string; name: string }[];
  /** 2026-10-18: funds rows actually created from the official SITCA list this run, independent of
   * the baseline/new-listing event bookkeeping above (see createMissingDomesticFunds doc comment). */
  created: { taxId: string; name: string; company: string }[];
  /** 2026-10-17: non-zero only when a day's "candidates" list was abnormally large and got treated
   * as a baseline catch-up instead of real new-listing events -- see CANDIDATE_BACKFILL_THRESHOLD. */
  baselineBackfilled: number;
};

// 2026-10-17: an earlier bug (unbatched sequential inserts, see batchInsertEvents's doc comment)
// left both baselines partially seeded in production (83/~1071 offshore funds recorded). A normal
// run's "candidates" (funds.code/name not yet in the baseline) is meant to be a handful of real new
// listings per day -- if it's this large instead, the baseline itself is incomplete, not today's
// news. Silently mass-announcing hundreds of pre-existing funds as "new today" would misrepresent
// real data to users, which this project explicitly doesn't do. Past this threshold, top up the
// baseline instead of logging NEW_LISTING events; below it, proceed as genuine new listings.
const CANDIDATE_BACKFILL_THRESHOLD = 50;

// 2026-10-18 root-cause fix: this pipeline previously only ever LOGGED a product_listing_events row
// (logNewFunds below) and never created the actual `funds` row -- unlike the ETF sibling
// (lib/cron/newListingDetection.ts), which does both. VERIFIED live: 8 real SITCA-registered funds
// (e.g. 94991068B／富邦新台商基金-TISA類型) had been sitting in product_listing_events as either
// KNOWN_BASELINE or NEW_LISTING for one or more days with no corresponding `funds` row at all.
//
// "Should a funds row exist" and "should today's 新商品上架 screen announce this as new" are
// deliberately decoupled here: a fund that was swept into the first-run KNOWN_BASELINE snapshot
// (because our `funds` table simply hadn't onboarded it yet, not because it's genuinely old news)
// must still get its row created -- it was never "fine to ignore", the baseline-seed only exists to
// keep that backlog from being mis-announced as a brand-new product today. So this checks EVERY
// taxId from the official list against `funds.code`, regardless of baseline/known status, and
// creates whatever's missing; the event-log/新商品上架 `candidates` logic below is untouched.
async function createMissingDomesticFunds(writeEnabled: boolean, existingFundCodes: Set<string>): Promise<{ taxId: string; name: string; company: string }[]> {
  const identity = await fetchSitcaIdentityRows();
  const navRows = await fetchSitcaRows().catch(() => []); // best-effort -- NAV might not be published yet for some
  const navByTaxId = new Map(navRows.map((r) => [r.taxId, r.nav]));

  const seenTaxIds = new Set<string>();
  const missing: { taxId: string; name: string; company: string }[] = [];
  for (const row of identity) {
    if (seenTaxIds.has(row.taxId) || existingFundCodes.has(row.taxId)) continue;
    seenTaxIds.add(row.taxId);
    missing.push(row);
  }
  if (!writeEnabled || missing.length === 0) return missing;

  const created: { taxId: string; name: string; company: string }[] = [];
  for (const row of missing) {
    const nav = navByTaxId.get(row.taxId) ?? null;
    await prisma.fund.create({
      data: {
        name: row.name,
        code: row.taxId,
        company: row.company,
        currency: "TWD",
        dataProvider: "SITCA",
        isActive: true,
        latestNav: nav ?? undefined,
      },
    });
    created.push(row);
  }
  return created;
}

// 2026-10-18（使用者核准的最小新增方案）: offshore 的「auto-provisioning 是另一個更難的問題」
// 舊註解（見下方 detectNewOffshoreFunds）其實只對一部分正確——TDCC NAV CSV（tdccBatchSource.ts
// 的 dataset 3-4，不是這裡 OFFSHORE_SOURCE 用的字串標籤）VERIFIED 每一列都有自己的 code/isin/
// currency 欄位，不是完全沒有身分識別。把 NAV CSV 跟資料庫比對後缺漏的基金清單，再交叉比對
// dataset 3-2（lib/tw-purchasable/tdccOffshoreBasicInfo.ts，「目前核備可在台灣銷售」的官方
// 清冊）——VERIFIED 兩個資料集範圍不同：3-4 是「目前還在回報淨值」的基金（可能包含已停止對
// 新投資人銷售、但既有持有人仍可查詢淨值的基金），3-2 才是「目前核備、可銷售」的清單。
// 唯讀 dry-run 把 993 筆缺漏分類：454 筆同時在 3-2（可補建），539 筆不在 3-2（排除——這些
// navDate 本身並不陳舊，代表它們是「還在回報淨值但已不在銷售核備清單上」，符合已停售/下架
// 的特徵，不建立 funds 列）。只有 454 筆會真的被建立。
// 與 lib/tw-purchasable/classify.ts 比對 TDCC 名稱時用同一個正規化規則（去掉全形空白／多餘
// 空白），避免把「只有空白字元差異」的既存基金誤判成缺漏而建出重複列。
function normalizeFundName(s: string): string {
  return s.replace(/[　\s]+/g, "");
}

async function createMissingOffshoreFunds(writeEnabled: boolean, existingFundNames: Set<string>): Promise<{ taxId: string; name: string; company: string }[]> {
  const csvText = await fetchTdccNavCsv();
  const byName = parseTdccNavCsv(csvText);
  const approvedNames = await fetchTdccOffshoreBasicInfoNames();
  const approvedNormalized = new Set([...approvedNames].map(normalizeFundName));
  const existingNormalized = new Set([...existingFundNames].map(normalizeFundName));
  const missing: { taxId: string; name: string; company: string }[] = [];
  for (const [name, row] of byName) {
    if (existingFundNames.has(name) || existingNormalized.has(normalizeFundName(name))) continue;
    // 只補建「目前核備、可在台灣銷售」的基金——跟 3-2 清冊比對不到的一律排除，不建立。
    const isCurrentlyApproved = approvedNames.has(name) || approvedNormalized.has(normalizeFundName(name));
    if (!isCurrentlyApproved) continue;
    missing.push({ taxId: row.code, name, company: "" });
  }
  if (!writeEnabled || missing.length === 0) return missing;

  const created: { taxId: string; name: string; company: string }[] = [];
  for (const row of missing) {
    const navRow = byName.get(row.name)!;
    await prisma.fund.create({
      data: {
        name: row.name,
        // funds.company 是必填欄位，但 TDCC NAV CSV（dataset 3-4）這一列本身不帶總代理/發行
        // 公司名稱——誠實標記待補，不要編造一個看起來像真資料的公司名稱。
        company: "（境外基金，總代理公司待人工補上）",
        currency: navRow.currency ?? "USD",
        dataProvider: "tdcc-offshore",
        isActive: true,
        latestNav: navRow.nav,
        latestNavDate: new Date(navRow.navDate),
        isin: navRow.isin ?? undefined,
      },
    });
    created.push(row);
  }
  return created;
}

/** Domestic funds: identity key is 基金統編 (== funds.code for ~95% of rows per sitcaFetch.ts's own
 * verified comment; the remaining 5% have no code match at all and are intentionally left out of
 * this detector — they're not resolvable to a `funds` row either way, so "new" vs "existing" can't
 * be determined for them from this CSV alone). */
export async function detectNewDomesticFunds(writeEnabled: boolean): Promise<NewFundResult> {
  const rows = await fetchSitcaRows();
  const bySeen = new Map<string, string>(); // taxId -> name, de-duped
  for (const r of rows) bySeen.set(r.taxId, r.name);

  const existingFundCodes = new Set((await prisma.fund.findMany({ select: { code: true } })).map((f) => f.code).filter((c): c is string => c !== null));
  const isFirstRun = !(await hasAnyBaseline("DOMESTIC_FUND", DOMESTIC_SOURCE));
  const known = isFirstRun ? new Set<string>() : await knownKeys("DOMESTIC_FUND", DOMESTIC_SOURCE);

  const candidates = [...bySeen.entries()]
    .filter(([taxId]) => !existingFundCodes.has(taxId) && !known.has(taxId))
    .map(([taxId, name]) => ({ key: taxId, name }));

  const created = await createMissingDomesticFunds(writeEnabled, existingFundCodes);
  const needsBackfill = !isFirstRun && candidates.length > CANDIDATE_BACKFILL_THRESHOLD;

  if (!writeEnabled) {
    return { isFirstRun, seeded: isFirstRun ? bySeen.size : 0, newlyDetected: isFirstRun || needsBackfill ? [] : candidates, created, baselineBackfilled: needsBackfill ? candidates.length : 0 };
  }

  if (isFirstRun) {
    await seedBaseline("DOMESTIC_FUND", DOMESTIC_SOURCE, [...bySeen.entries()].map(([taxId, name]) => ({ key: taxId, name })));
    return { isFirstRun: true, seeded: bySeen.size, newlyDetected: [], created, baselineBackfilled: 0 };
  }
  if (needsBackfill) {
    await seedBaseline("DOMESTIC_FUND", DOMESTIC_SOURCE, candidates);
    return { isFirstRun: false, seeded: 0, newlyDetected: [], created, baselineBackfilled: candidates.length };
  }
  await logNewFunds("DOMESTIC_FUND", DOMESTIC_SOURCE, candidates);
  return { isFirstRun: false, seeded: 0, newlyDetected: candidates, created, baselineBackfilled: 0 };
}

/** Offshore funds: funds.code is NULL for most offshore funds (per tdccBatchSource.ts's own
 * documented reason), so identity here is exact fund NAME — the same join key
 * lib/offshore-nav-sync/tdccBatchSource.ts already uses for NAV writes. */
export async function detectNewOffshoreFunds(writeEnabled: boolean): Promise<NewFundResult> {
  const csvText = await fetchTdccNavCsv();
  const byName = parseTdccNavCsv(csvText);

  const existingFundNames = new Set((await prisma.fund.findMany({ select: { name: true } })).map((f) => f.name));
  const isFirstRun = !(await hasAnyBaseline("OFFSHORE_FUND", OFFSHORE_SOURCE));
  const known = isFirstRun ? new Set<string>() : await knownKeys("OFFSHORE_FUND", OFFSHORE_SOURCE);

  const candidates = [...byName.keys()]
    .filter((name) => !existingFundNames.has(name) && !known.has(name))
    .map((name) => ({ key: name, name }));

  // 2026-10-18（使用者核准的最小新增方案）: 原本這裡完全不建立 funds 列（見下面保留的舊註解）。
  // 現在跟 domestic 的 createMissingDomesticFunds 一樣，用「是否該有 funds 列」跟「今天的畫面
  // 要不要宣布為新商品」兩件事分開處理——不管 isFirstRun/needsBackfill 走哪個分支，缺漏的
  // funds 列都會檢查並（writeEnabled 時）建立。
  const created = await createMissingOffshoreFunds(writeEnabled, existingFundNames);

  // Offshore fund auto-provisioning used to be treated as a separate, harder problem (funds.code is
  // NULL for most offshore funds) -- VERIFIED 2026-10-18 that TDCC's own NAV CSV does carry a usable
  // code/isin per row (see createMissingOffshoreFunds above), so the backfill gap is now closeable.
  const needsBackfill = !isFirstRun && candidates.length > CANDIDATE_BACKFILL_THRESHOLD;

  if (!writeEnabled) {
    return { isFirstRun, seeded: isFirstRun ? candidates.length : 0, newlyDetected: isFirstRun || needsBackfill ? [] : candidates, created, baselineBackfilled: needsBackfill ? candidates.length : 0 };
  }

  if (isFirstRun) {
    await seedBaseline("OFFSHORE_FUND", OFFSHORE_SOURCE, [...byName.keys()].map((name) => ({ key: name, name })));
    return { isFirstRun: true, seeded: byName.size, newlyDetected: [], created, baselineBackfilled: 0 };
  }
  if (needsBackfill) {
    await seedBaseline("OFFSHORE_FUND", OFFSHORE_SOURCE, candidates);
    return { isFirstRun: false, seeded: 0, newlyDetected: [], created, baselineBackfilled: candidates.length };
  }
  await logNewFunds("OFFSHORE_FUND", OFFSHORE_SOURCE, candidates);
  return { isFirstRun: false, seeded: 0, newlyDetected: candidates, created, baselineBackfilled: 0 };
}
