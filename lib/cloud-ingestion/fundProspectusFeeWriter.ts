// 公開說明書經理費率/保管費率寫入（2026-11-03使用者核准，野村投信試點；2026-11-04改用
// listNomuraFilings()自動解析清單，取代原本只有5檔的NOMURA_PROSPECTUS_FILENAME手動對照表）。
// 寫入開關FUND_PROSPECTUS_FEE_WRITE，shadow模式預設不寫入。
//
// 範圍：listNomuraFilings()從MOPS清單頁解析出61筆申報記錄（114+115兩個ROC年度），但「只處理
// APPROVED的，已改名或清算的排除」——這一步不用額外過濾邏輯，因為下面的fundByCode本來就只收
// tw_purchasable_classification狀態APPROVED、且未被fund_superseded_by_code標記取代的基金列；
// 61筆裡對不到任何一個APPROVED fund.id的（已清算/改名後舊名/非境內申報的傘型ETF子基金等），
// 自然落入failed（NO_FUND_ID_MATCHED），不會被處理或寫入。VERIFIED差異來源：61筆中約10筆是
// 已清算基金(野村巴西證券基金/野村雙印傘型證券基金/野村鑫全球債券組合基金/野村目標到期傘型
// 基金/野村新興非投資等級債券組合基金舊名)、境外ETF子基金(野村亞洲傘型之韓國科技30ETF/亞洲
// 科技主動式ETF，不適用MOPS境內基金申報、不在這份清單的「正常」範圍內)，以及少數全形/半形
// 字元差異(例如"野村ｅ科技基金"官網全形E跟公會清單半形e)；使用者原本預期的54檔跟這裡篩出的
// APPROVED筆數相近但非完全一致，確切對應待逐筆核對全形/半形字元後再收斂，先如實回報差異。
//
// 費率屬於基金層級（跟持股月報一樣），同一個基金名稱寫入時，會更新該基金所有APPROVED、
// 非superseded share class的對應欄位。
import { prisma } from "@/lib/prisma";
import { fetchSitcaRows } from "@/lib/sitca-nav-sync/sitcaFetch";
import { extractNomuraProspectusFee, listNomuraFilings } from "@/lib/cloud-ingestion/fundProspectusFee";

export function isFundProspectusFeeWriteEnabled(): boolean {
  return process.env.FUND_PROSPECTUS_FEE_WRITE?.trim() === "on";
}

// 2026-11-04 VERIFIED：MOPS申報清單用半形英數（"野村 e 科技基金"），SITCA公告清單同一檔基金卻用
// 全形英數（"野村ｅ科技基金"）——兩邊各自內部一致，只是彼此不同，單純去空白比對不到。把全形
// ASCII(U+FF01-FF5E)轉回半形(減0xFEE0)後再去空白比對，兩邊就會收斂成同一個字串。
function normalizeNomuraName(raw: string): string {
  const halfWidth = raw.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  return halfWidth.replace(/\s+/g, "");
}

export type FundProspectusFeeDryRunRow = {
  fundName: string;
  matchedFundIds: string[];
  mgmtFeeText: string;
  custodianFeeText: string;
  inceptionDate: string | null;
  sourceUrl: string;
};

export type FundProspectusFeeResult = {
  attempted: number;
  matched: number;
  written: number;
  failed: Array<{ fundName: string; error: string }>;
  dryRunRows: FundProspectusFeeDryRunRow[];
};

export async function runNomuraProspectusFeeSync(): Promise<FundProspectusFeeResult> {
  const writeEnabled = isFundProspectusFeeWriteEnabled();
  const sitcaRows = await fetchSitcaRows();
  const nomuraRows = sitcaRows.filter((r) => r.company === "野村投信");

  const allFunds = await prisma.$queryRawUnsafe<{ id: string; code: string; name: string }[]>(
    `SELECT f.id, f.code, f.name FROM funds f
     WHERE f.id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)
       AND f.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`,
  );
  const fundByCode = new Map(allFunds.map((f) => [f.code, f]));

  const failed: Array<{ fundName: string; error: string }> = [];
  const dryRunRows: FundProspectusFeeDryRunRow[] = [];
  let written = 0;
  let matched = 0;

  const filings = await listNomuraFilings();
  let attempted = 0;
  for (const [fundName, filing] of filings) {
    attempted++;
    const normalized = normalizeNomuraName(fundName).replace(/基金$/, "");
    // 跟月報持股用一樣的base code家族共用邏輯：SITCA同一個基金簡稱(去掉類型後綴)的所有級別，
    // 全部一起更新這個基金層級的費率欄位——fundByCode只含APPROVED、非superseded的基金，61筆
    // 申報記錄裡對不到任何APPROVED fund.id的（已清算/改名舊名/非境內申報ETF子基金），就落入
    // 下面的NO_FUND_ID_MATCHED，不會被處理，等同篩掉。
    const matchedFundIds = nomuraRows
      .filter((r) => normalizeNomuraName(r.name.split("-")[0]).replace(/證券投資信託基金$|基金$/, "") === normalized)
      .map((r) => fundByCode.get(r.taxId)?.id)
      .filter((id): id is string => !!id);
    if (matchedFundIds.length === 0) { failed.push({ fundName, error: "NO_FUND_ID_MATCHED" }); continue; }
    matched++;

    try {
      const result = await extractNomuraProspectusFee(filing.filename, fundName);
      dryRunRows.push({
        fundName, matchedFundIds, mgmtFeeText: result.mgmtFeeText, custodianFeeText: result.custodianFeeText,
        inceptionDate: result.inceptionDate, sourceUrl: result.sourceUrl,
      });
      if (writeEnabled) {
        for (const fundId of matchedFundIds) {
          await prisma.$executeRawUnsafe(
            `UPDATE funds SET mgmt_fee_rate_prospectus_text = $1, custodian_fee_rate_prospectus_text = $2,
               fee_rate_prospectus_source_url = $3, fee_rate_prospectus_filed_at = $4
             WHERE id = $5`,
            result.mgmtFeeText, result.custodianFeeText, result.sourceUrl, result.filedAt, fundId,
          );
        }
        written++;
      }
    } catch (e) {
      failed.push({ fundName, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { attempted, matched, written, failed, dryRunRows };
}
