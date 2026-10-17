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

export type ClassifyResult = {
  domesticFund: { officialCount: number; matched: number };
  offshoreFund: { officialCount: number; matched: number };
  etf: { officialCount: number; matched: number };
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
  const tdccNames = await fetchTdccOffshoreBasicInfoNames();
  const offshoreFunds = await prisma.fund.findMany({ select: { id: true, name: true } });
  const offshoreMatches = offshoreFunds
    .filter((f) => tdccNames.has(f.name))
    .map((f) => ({ assetType: "FUND" as const, assetId: f.id, source: TDCC_OFFSHORE_BASIC_INFO_SOURCE, sourceRecordRef: f.name }));
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

  return {
    domesticFund: { officialCount: sitcaRows.length, matched: domesticMatches.length },
    offshoreFund: { officialCount: tdccNames.size, matched: offshoreMatches.length },
    etf: { officialCount: twseRows.length + tpexRows.length, matched: etfMatches.length },
  };
}
