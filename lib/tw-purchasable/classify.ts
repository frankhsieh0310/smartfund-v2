// "台灣買得到" classification -- see docs/specs/technical-screener-reverse-lookup.md ("一之一"
// section) for the full design rationale and VERIFIED official-list numbers this cross-references
// against. Three official sources, three separate join keys (no single universal identifier
// exists across all three):
//   - 境內基金 (domestic fund): SITCA official daily NAV CSV, identity = 基金統編 == funds.code.
//   - 境外基金 (offshore fund): TDCC opendata dataset 3-2, identity = exact fund NAME == funds.name
//     (funds.code/isin are NULL for the vast majority of offshore funds -- documented elsewhere).
//   - ETF: TWSE + TPEx t187ap47 official fund-summary CSVs, identity = code == etfs.code.
//
// Deliberately only writes APPROVED rows for assets that actually match an official list by this
// key. Assets in `funds`/`etfs` that DON'T match are left with no row at all (not written as
// NOT_APPROVED) -- per the spec doc's own VERIFIED finding, ~18% of ETFs and ~12% of domestic
// funds fail to match purely due to code-format drift, not genuine non-approval, so writing
// NOT_APPROVED for every non-match would misrepresent those as confirmed-unapproved when the
// honest state is "couldn't confirm either way". Callers (reverse-lookup UI) should treat a
// missing row as "approval status unknown", not "not approved".
import { prisma } from "@/lib/prisma";
import { fetchSitcaIdentityRows } from "@/lib/sitca-nav-sync/sitcaFetch";
import { fetchTdccOffshoreBasicInfoNames, TDCC_OFFSHORE_BASIC_INFO_SOURCE } from "./tdccOffshoreBasicInfo";
import { fetchOfficialEtfList } from "@/lib/cron/newListingDetection";
import { checkRetailRestricted } from "./retailRestrictedEtf";
import { fetchCurrentlyTradingTwCodes } from "@/lib/cron/twCurrentlyTradingCheck";

const SITCA_SOURCE = "SITCA_NAV_CSV";
const TWSE_SOURCE = "TWSE_T187AP47_L";
const TPEX_SOURCE = "TPEX_T187AP47_O";
// 2026-10-18（使用者核准的第 4 類）: 複委託常見美股 ETF。沒有像 SITCA/TDCC/TWSE-TPEx 那樣的
// 官方「核准清單」可以逐筆比對身分，規則改成直接用資料庫本身的狀態判斷：(a) data_source 沒有
// 市場後綴（本資料庫美股的既有慣例）、(b) exchange 屬於美股四個主要交易所、(c) is_active=true、
// (d) 近 10 天內有 etf_history 資料（排除下市但仍標 active、或完全沒資料的列，不算「買得到」）。
const US_ETF_SOURCE = "US_EXCHANGE_ACTIVE_WITH_RECENT_DATA";
// VERIFIED 這是資料庫裡 exchange 欄位真實出現的美股主要交易所字串（唯讀查詢確認），不是猜的。
// 刻意不含 'TWSE'（57 檔重複 ETF 的隱藏/錯誤資料剛好也落在「無後綴」條件裡，必須排除）、
// 也不含 OTC Markets 系列（跟「美國交易所上市」的字面意思不符，場外櫃買不算交易所）。
const US_EXCHANGES = ["NYSE", "NYSEArca", "NYSE American", "NasdaqGM", "Nasdaq GIDS", "Cboe US"];

export type ClassifyResult = {
  domesticFund: { officialCount: number; matched: number };
  offshoreFund: { officialCount: number; matched: number };
  etf: { officialCount: number; matched: number };
  usEtf: { candidateCount: number; matched: number; retailRestricted: number };
};

async function upsertApproved(
  rows: { assetType: "FUND" | "ETF"; assetId: string; source: string; sourceRecordRef: string }[],
  writeEnabled: boolean,
): Promise<number> {
  if (!writeEnabled || rows.length === 0) return rows.length;
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk
      .map((_, idx) => `(gen_random_uuid(), $${idx * 4 + 1}, $${idx * 4 + 2}, 'APPROVED', $${idx * 4 + 3}, $${idx * 4 + 4}, now(), now(), now())`)
      .join(",\n");
    await prisma.$executeRawUnsafe(
      `INSERT INTO tw_purchasable_classification
         (id, asset_type, asset_id, status, source, source_record_ref, checked_at, created_at, updated_at)
       VALUES ${values}
       ON CONFLICT (asset_type, asset_id) DO UPDATE SET
         status = 'APPROVED', source = EXCLUDED.source, source_record_ref = EXCLUDED.source_record_ref,
         checked_at = now(), updated_at = now()`,
      ...chunk.flatMap((r) => [r.assetType, r.assetId, r.source, r.sourceRecordRef]),
    );
  }
  return rows.length;
}

export async function classifyTwPurchasable(writeEnabled: boolean): Promise<ClassifyResult> {
  // 境內基金 (domestic): SITCA 基金統編 == funds.code
  const sitcaRows = await fetchSitcaIdentityRows();
  const domesticFunds = await prisma.fund.findMany({ where: { code: { not: null } }, select: { id: true, code: true } });
  const domesticByCode = new Map(domesticFunds.map((f) => [f.code!, f.id]));
  const domesticMatches = sitcaRows
    .filter((r) => domesticByCode.has(r.taxId))
    .map((r) => ({ assetType: "FUND" as const, assetId: domesticByCode.get(r.taxId)!, source: SITCA_SOURCE, sourceRecordRef: r.taxId }));
  await upsertApproved(domesticMatches, writeEnabled);

  // 境外基金 (offshore): TDCC 3-2 fund name == funds.name
  // 2026-10-18 修正：29 檔純粹因為全形空白／多餘空白差異（例如 TDCC 名稱帶雙空白、我們存的
  // 是單空白）比對失敗，誠實的基金其實存在、比對鍵只是沒有正規化——比對前先去掉空白字元，
  // 跟 lib/cron/newFundListingDetection.ts 的 normalizeFundName 用同一個規則。
  const tdccNames = await fetchTdccOffshoreBasicInfoNames();
  const normalizeFundName = (s: string) => s.replace(/[　\s]+/g, "");
  const tdccNamesNormalized = new Map([...tdccNames].map((n) => [normalizeFundName(n), n]));
  // 2026-10-19 root-cause fix: this used to match ALL funds by name, regardless of data_provider --
  // VERIFIED 378 of core_universe_fund coverage gap's ~500 stale entries are data_provider='yahoo'
  // rows, a known-stale 2026-07-24 bulk import that (per lib/data-platform/web/fundService.ts's own
  // existing STALE_UNSYNCED_OFFSHORE_FUND_DAYS comment) has never been covered by any ongoing NAV
  // sync since and is already hidden from the website's own listings for exactly this reason. When a
  // genuine 'tdcc-offshore' row for the same fund name also exists, matching the 'yahoo' duplicate
  // too just marks a second, never-updated row as "core/approved" alongside the real one -- it never
  // gets fresh fund_history and permanently drags the coverage check down. Excluding data_provider =
  // 'yahoo' here keeps this classification consistent with the website's own existing stale-hiding
  // rule, not a new policy invented just for this check.
  const offshoreFunds = await prisma.fund.findMany({ where: { NOT: { dataProvider: "yahoo" } }, select: { id: true, name: true } });
  const offshoreMatches = offshoreFunds
    .filter((f) => tdccNames.has(f.name) || tdccNamesNormalized.has(normalizeFundName(f.name)))
    .map((f) => ({
      assetType: "FUND" as const, assetId: f.id, source: TDCC_OFFSHORE_BASIC_INFO_SOURCE,
      sourceRecordRef: tdccNames.has(f.name) ? f.name : tdccNamesNormalized.get(normalizeFundName(f.name))!,
    }));
  await upsertApproved(offshoreMatches, writeEnabled);
  // 2026-10-19 root-cause fix (paired with the data_provider='yahoo' exclusion above): rows that
  // were APPROVED by an earlier run before this fix existed stay APPROVED forever otherwise --
  // upsertApproved only ever inserts/updates matches, it never revokes a stale one (deliberately, to
  // avoid misclassifying the ~18%/12% genuine code-format-drift non-matches documented at the top of
  // this file as "confirmed not approved"). This is a narrower, specific case: a fund row we KNOW is
  // a stale, never-synced 2026-07-24 'yahoo' bulk-import duplicate of a real tdcc-offshore row is
  // never a legitimate ambiguous case, so revoking it here doesn't weaken that general policy.
  if (writeEnabled) {
    await prisma.$executeRawUnsafe(
      `UPDATE tw_purchasable_classification SET status = 'NOT_APPROVED', updated_at = now()
       WHERE asset_type = 'FUND' AND status = 'APPROVED'
         AND asset_id IN (SELECT id FROM funds WHERE data_provider = 'yahoo')`,
    );
  }

  // ETF: TWSE + TPEx t187ap47 code == etfs.code
  // 2026-10-18 修正：t187ap47 官方清單本身 VERIFIED 會包含已經不在交易的 ETF（唯讀對照
  // TWSE/TPEx 今天真實收盤行情，427 檔官方清單裡有 68 檔完全沒有今天的收盤紀錄）——單純
  // 「代號存在於官方清單」不等於「現在買得到」，額外要求代號也出現在今天的收盤行情裡才算
  // 核心母體，跟上面美股ETF第4類用同一個「現行掛牌」查詢，不寫兩套。
  const [twseRows, tpexRows] = await Promise.all([fetchOfficialEtfList("TWSE"), fetchOfficialEtfList("TPEx")]);
  const tradingCodes = await fetchCurrentlyTradingTwCodes();
  const allEtfs = await prisma.etf.findMany({ select: { id: true, code: true } });
  const etfByCode = new Map(allEtfs.map((e) => [e.code, e.id]));
  const etfMatches = [
    ...twseRows.filter((r) => etfByCode.has(r.code) && tradingCodes.has(r.code)).map((r) => ({ assetType: "ETF" as const, assetId: etfByCode.get(r.code)!, source: TWSE_SOURCE, sourceRecordRef: r.code })),
    ...tpexRows.filter((r) => etfByCode.has(r.code) && tradingCodes.has(r.code)).map((r) => ({ assetType: "ETF" as const, assetId: etfByCode.get(r.code)!, source: TPEX_SOURCE, sourceRecordRef: r.code })),
  ];
  await upsertApproved(etfMatches, writeEnabled);

  // 第 4 類：美股ETF。沒有官方核准清單可比對，規則本身就是候選條件（見上面 US_ETF_SOURCE
  // 註解）；(d) 近 10 天內有 etf_history 的檢查用一次查詢批量做，不逐檔查。
  const usEtfCandidates = await prisma.etf.findMany({
    where: { isActive: true, dataSource: { not: null }, exchange: { in: US_EXCHANGES } },
    select: { id: true, name: true, category: true },
  });
  const usEtfIds = usEtfCandidates.map((e) => e.id);
  const freshRows = usEtfIds.length
    ? await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT DISTINCT etf_id AS id FROM etf_history WHERE etf_id = ANY($1::text[]) AND date > now() - interval '10 days'`,
        usEtfIds,
      )
    : [];
  const freshIdSet = new Set(freshRows.map((r) => r.id));
  // 2026-10-23（使用者核准）: 一般投資人透過複委託買不到的美股ETF（虛擬資產現貨/期貨ETF、超過
  // 2倍正向/1倍反向槓桿的ETF）排除在核心母體外，見 retailRestrictedEtf.ts 的判定依據。每天重新
  // 分類時都套用同一條規則，不會因為下一輪classify又把它們重新加回APPROVED。
  const freshCandidates = usEtfCandidates.filter((e) => freshIdSet.has(e.id));
  const usEtfMatches: { assetType: "ETF"; assetId: string; source: string; sourceRecordRef: string }[] = [];
  const retailRestrictedMatches: { assetType: "ETF"; assetId: string; source: string; sourceRecordRef: string }[] = [];
  for (const e of freshCandidates) {
    const check = checkRetailRestricted(e.name, e.category);
    if (check.excluded) {
      retailRestrictedMatches.push({ assetType: "ETF", assetId: e.id, source: `RETAIL_RESTRICTED:${check.reason}`, sourceRecordRef: e.id });
    } else {
      usEtfMatches.push({ assetType: "ETF", assetId: e.id, source: US_ETF_SOURCE, sourceRecordRef: e.id });
    }
  }
  await upsertApproved(usEtfMatches, writeEnabled);
  if (writeEnabled && retailRestrictedMatches.length) {
    const CHUNK = 500;
    for (let i = 0; i < retailRestrictedMatches.length; i += CHUNK) {
      const chunk = retailRestrictedMatches.slice(i, i + CHUNK);
      const values = chunk.map((_, idx) => `(gen_random_uuid(), $${idx * 4 + 1}, $${idx * 4 + 2}, 'EXCLUDED_RETAIL_RESTRICTED', $${idx * 4 + 3}, $${idx * 4 + 4}, now(), now(), now())`).join(",\n");
      await prisma.$executeRawUnsafe(
        `INSERT INTO tw_purchasable_classification (id, asset_type, asset_id, status, source, source_record_ref, checked_at, created_at, updated_at)
         VALUES ${values}
         ON CONFLICT (asset_type, asset_id) DO UPDATE SET
           status = CASE WHEN tw_purchasable_classification.status = 'APPROVED' THEN 'EXCLUDED_RETAIL_RESTRICTED' ELSE tw_purchasable_classification.status END,
           source = EXCLUDED.source, source_record_ref = EXCLUDED.source_record_ref, checked_at = now(), updated_at = now()`,
        ...chunk.flatMap((r) => [r.assetType, r.assetId, r.source, r.sourceRecordRef]),
      );
    }
  }

  // officialCount 改成只算現行掛牌的那些（跟上面 etfMatches 用同一個 tradingCodes 過濾），
  // 不是整份 427 檔官方清單——否則母體本身就含已下市商品，分母錯誤。
  const twseTrading = twseRows.filter((r) => tradingCodes.has(r.code)).length;
  const tpexTrading = tpexRows.filter((r) => tradingCodes.has(r.code)).length;

  return {
    domesticFund: { officialCount: sitcaRows.length, matched: domesticMatches.length },
    offshoreFund: { officialCount: tdccNames.size, matched: offshoreMatches.length },
    etf: { officialCount: twseTrading + tpexTrading, matched: etfMatches.length },
    usEtf: { candidateCount: usEtfIds.length, matched: usEtfMatches.length, retailRestricted: retailRestrictedMatches.length },
  };
}
