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

// 2026-10-31（使用者核准，人工排除機制）: 匯豐全球趨勢組合基金（合併消滅）、俄羅斯相關8個級別
// （暫停申購贖回持續至今）VERIFIED確認不能申購，但它們的名字/代碼仍然出現在TDCC核備清單上——
// 每天重新分類時upsertApproved會照官方清單把它們的status蓋回APPROVED。新增這張專屬表
// （tw_purchasable_manual_overrides，RLS啟用+REVOKE anon/authenticated，見對應的DDL SQL）記錄
// 人工判定，這裡的資產一律排除在「比對官方清單」的候選名單之外，絕不讓官方清單把它們蓋回
// APPROVED，而且每輪都明確維持NOT_APPROVED（不是只是不碰它）。
type ManualOverrideKey = string; // `${assetType}:${assetId}`
async function loadManualOverrides(): Promise<Set<ManualOverrideKey>> {
  const rows = await prisma.$queryRawUnsafe<{ asset_type: string; asset_id: string }[]>(
    `SELECT asset_type, asset_id FROM tw_purchasable_manual_overrides`,
  );
  return new Set(rows.map((r) => `${r.asset_type}:${r.asset_id}`));
}

async function enforceManualOverrides(overrides: Set<ManualOverrideKey>, writeEnabled: boolean): Promise<void> {
  if (!writeEnabled || overrides.size === 0) return;
  const rows = [...overrides].map((k) => {
    const [assetType, assetId] = k.split(":");
    return { assetType, assetId };
  });
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map((_, idx) => `($${idx * 2 + 1}, $${idx * 2 + 2}, 'MANUAL_OVERRIDE')`).join(",\n");
    await prisma.$executeRawUnsafe(
      `INSERT INTO tw_purchasable_classification (id, asset_type, asset_id, status, source, source_record_ref, checked_at, created_at, updated_at)
       SELECT gen_random_uuid(), x.asset_type, x.asset_id, 'NOT_APPROVED', x.source, x.asset_id, now(), now(), now()
       FROM (VALUES ${values}) AS x(asset_type, asset_id, source)
       ON CONFLICT (asset_type, asset_id) DO UPDATE SET
         status = 'NOT_APPROVED', source = 'MANUAL_OVERRIDE', checked_at = now(), updated_at = now()`,
      ...chunk.flatMap((r) => [r.assetType, r.assetId]),
    );
  }
}

export async function classifyTwPurchasable(writeEnabled: boolean): Promise<ClassifyResult> {
  const manualOverrides = await loadManualOverrides();

  // 境內基金 (domestic): SITCA 基金統編 == funds.code
  const sitcaRows = await fetchSitcaIdentityRows();
  const domesticFunds = await prisma.fund.findMany({ where: { code: { not: null } }, select: { id: true, code: true } });
  const domesticByCode = new Map(domesticFunds.map((f) => [f.code!, f.id]));
  const domesticMatches = sitcaRows
    .filter((r) => domesticByCode.has(r.taxId))
    .map((r) => ({ assetType: "FUND" as const, assetId: domesticByCode.get(r.taxId)!, source: SITCA_SOURCE, sourceRecordRef: r.taxId }))
    .filter((m) => !manualOverrides.has(`${m.assetType}:${m.assetId}`));
  await upsertApproved(domesticMatches, writeEnabled);
  // 2026-10-31（使用者核准修正，野村鴻運等16檔同一類問題）: SITCA有時會把一個基金統編拆成帶
  // 字母字尾的子類型代碼（例如00968493 -> 00968493A累積型/00968493B TISA類型）。
  // newFundListingDetection.ts已經會幫新字尾代碼建立新的funds列，但舊的無字尾列從此再也比對不到
  // SITCA CSV。2026-10-31使用者更正：不能用NOT_APPROVED（out-of-scope-purge會把它連同可能還有
  // 價值的多年fund_history一起刪掉）——改成只在「新舊代碼的NAV接得上」時，寫進獨立的
  // fund_superseded_by_code表（只影響列表/搜尋顯示，不碰APPROVED狀態、不碰fund_history），接
  // 不上的（通常是舊代碼fund_history本來就是空的，兩邊之間有數個月空窗、沒有相鄰資料可比對）
  // 完全不處理，維持現狀——跟VERIFIED當時16檔裡只有1檔（00968493，有相鄰日資料且變動在這檔
  // 基金自己歷史波動範圍內）通過這個檢查的結論一致。
  const SUPERSEDE_ADJACENT_WINDOW_DAYS = 5; // 容許跨週末/假日
  const SUPERSEDE_JUMP_GUARD_PCT = 0.20; // 跟navSanity.ts既有±20%跳空保護同一個門檻
  if (writeEnabled) {
    const sitcaTaxIdSet = new Set(sitcaRows.map((r) => r.taxId));
    const staleSplitCandidates = domesticFunds
      .filter((f) => {
        if (!f.code || sitcaTaxIdSet.has(f.code)) return false;
        const suffixed = `${f.code}A`;
        return domesticByCode.has(suffixed) && domesticByCode.get(suffixed) !== f.id;
      })
      .map((f) => ({ oldFundId: f.id, newFundId: domesticByCode.get(`${f.code}A`)! }));
    for (const c of staleSplitCandidates) {
      const oldLast = await prisma.$queryRawUnsafe<{ date: string; nav: string }[]>(
        `SELECT date::text, nav::text FROM fund_history WHERE fund_id = $1 ORDER BY date DESC LIMIT 1`,
        c.oldFundId,
      );
      if (!oldLast[0]) continue; // 舊代碼沒有歷史淨值可比對，維持現狀不處理
      const newNear = await prisma.$queryRawUnsafe<{ nav: string }[]>(
        `SELECT nav::text FROM fund_history WHERE fund_id = $1 AND date >= $2::date
           AND date <= $2::date + interval '${SUPERSEDE_ADJACENT_WINDOW_DAYS} days'
         ORDER BY date ASC LIMIT 1`,
        c.newFundId, oldLast[0].date,
      );
      if (!newNear[0]) continue; // 新代碼在相鄰窗口內沒有資料，維持現狀不處理
      const oldNav = Number(oldLast[0].nav), newNav = Number(newNear[0].nav);
      if (!Number.isFinite(oldNav) || !Number.isFinite(newNav) || oldNav <= 0) continue;
      if (Math.abs(newNav - oldNav) / oldNav > SUPERSEDE_JUMP_GUARD_PCT) continue; // 接不上，不處理
      await prisma.$executeRawUnsafe(
        `INSERT INTO fund_superseded_by_code (old_fund_id, new_fund_id, reason)
         VALUES ($1, $2, 'SITCA_CODE_SPLIT_VERIFIED_NAV_CONTINUITY')
         ON CONFLICT (old_fund_id) DO UPDATE SET new_fund_id = EXCLUDED.new_fund_id, decided_at = now()`,
        c.oldFundId, c.newFundId,
      );
    }
  }

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
    }))
    .filter((m) => !manualOverrides.has(`${m.assetType}:${m.assetId}`));
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
  // 2026-10-18 這裡原本額外要求代號也出現在「今天的收盤行情」裡才核准，理由是t187ap47官方清單
  // 本身包含已經不在交易的ETF。2026-10-31（使用者核准，根因修正）：VERIFIED這個「當天有收盤
  // 行情」條件本身太嚴，誤傷了低流動性、但其實還在掛牌的ETF（00793B/00847B這兩檔公司債ETF連續
  // 多天沒有成交量，被這個條件卡住一直拿不到APPROVED，結果被out-of-scope-purge當成範圍外刪掉）。
  // 改回「在證交所/櫃買中心官方清單上就視為掛牌中」這個更貼近「官方來源實際公布」原則的判斷，不
  // 再額外要求當天成交——沒有成交量不等於下市。
  const [twseRows, tpexRows] = await Promise.all([fetchOfficialEtfList("TWSE"), fetchOfficialEtfList("TPEx")]);
  const allEtfs = await prisma.etf.findMany({ select: { id: true, code: true } });
  const etfByCode = new Map(allEtfs.map((e) => [e.code, e.id]));
  const etfMatches = [
    ...twseRows.filter((r) => etfByCode.has(r.code)).map((r) => ({ assetType: "ETF" as const, assetId: etfByCode.get(r.code)!, source: TWSE_SOURCE, sourceRecordRef: r.code })),
    ...tpexRows.filter((r) => etfByCode.has(r.code)).map((r) => ({ assetType: "ETF" as const, assetId: etfByCode.get(r.code)!, source: TPEX_SOURCE, sourceRecordRef: r.code })),
  ].filter((m) => !manualOverrides.has(`${m.assetType}:${m.assetId}`));
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
    if (manualOverrides.has(`ETF:${e.id}`)) continue;
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

  await enforceManualOverrides(manualOverrides, writeEnabled);

  return {
    domesticFund: { officialCount: sitcaRows.length, matched: domesticMatches.length },
    offshoreFund: { officialCount: tdccNames.size, matched: offshoreMatches.length },
    etf: { officialCount: twseRows.length + tpexRows.length, matched: etfMatches.length },
    usEtf: { candidateCount: usEtfIds.length, matched: usEtfMatches.length, retailRestricted: retailRestrictedMatches.length },
  };
}
