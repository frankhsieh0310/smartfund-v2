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
  usEtf: { candidateCount: number; matched: number };
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
  const offshoreFunds = await prisma.fund.findMany({ select: { id: true, name: true } });
  const offshoreMatches = offshoreFunds
    .filter((f) => tdccNames.has(f.name) || tdccNamesNormalized.has(normalizeFundName(f.name)))
    .map((f) => ({
      assetType: "FUND" as const, assetId: f.id, source: TDCC_OFFSHORE_BASIC_INFO_SOURCE,
      sourceRecordRef: tdccNames.has(f.name) ? f.name : tdccNamesNormalized.get(normalizeFundName(f.name))!,
    }));
  await upsertApproved(offshoreMatches, writeEnabled);

  // ETF: TWSE + TPEx t187ap47 code == etfs.code
  const [twseRows, tpexRows] = await Promise.all([fetchOfficialEtfList("TWSE"), fetchOfficialEtfList("TPEx")]);
  const allEtfs = await prisma.etf.findMany({ select: { id: true, code: true } });
  const etfByCode = new Map(allEtfs.map((e) => [e.code, e.id]));
  const etfMatches = [
    ...twseRows.filter((r) => etfByCode.has(r.code)).map((r) => ({ assetType: "ETF" as const, assetId: etfByCode.get(r.code)!, source: TWSE_SOURCE, sourceRecordRef: r.code })),
    ...tpexRows.filter((r) => etfByCode.has(r.code)).map((r) => ({ assetType: "ETF" as const, assetId: etfByCode.get(r.code)!, source: TPEX_SOURCE, sourceRecordRef: r.code })),
  ];
  await upsertApproved(etfMatches, writeEnabled);

  // 第 4 類：美股ETF。沒有官方核准清單可比對，規則本身就是候選條件（見上面 US_ETF_SOURCE
  // 註解）；(d) 近 10 天內有 etf_history 的檢查用一次查詢批量做，不逐檔查。
  const usEtfCandidates = await prisma.etf.findMany({
    where: { isActive: true, dataSource: { not: null }, exchange: { in: US_EXCHANGES } },
    select: { id: true },
  });
  const usEtfIds = usEtfCandidates.map((e) => e.id);
  const freshRows = usEtfIds.length
    ? await prisma.$queryRawUnsafe<{ id: string }[]>(
        `SELECT DISTINCT etf_id AS id FROM etf_history WHERE etf_id = ANY($1::text[]) AND date > now() - interval '10 days'`,
        usEtfIds,
      )
    : [];
  const freshIdSet = new Set(freshRows.map((r) => r.id));
  const usEtfMatches = usEtfIds
    .filter((id) => freshIdSet.has(id))
    .map((id) => ({ assetType: "ETF" as const, assetId: id, source: US_ETF_SOURCE, sourceRecordRef: id }));
  await upsertApproved(usEtfMatches, writeEnabled);

  return {
    domesticFund: { officialCount: sitcaRows.length, matched: domesticMatches.length },
    offshoreFund: { officialCount: tdccNames.size, matched: offshoreMatches.length },
    etf: { officialCount: twseRows.length + tpexRows.length, matched: etfMatches.length },
    usEtf: { candidateCount: usEtfIds.length, matched: usEtfMatches.length },
  };
}
