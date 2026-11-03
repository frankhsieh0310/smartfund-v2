// 公開說明書經理費率/保管費率寫入（2026-11-03使用者核准，野村投信試點，5檔dry-run核對過）。
// 寫入開關FUND_PROSPECTUS_FEE_WRITE，shadow模式預設不寫入。
//
// 範圍：這輪只有NOMURA_PROSPECTUS_FILENAME那5檔有PDF檔名對應（野村鴻運/中小/高科技/平衡/
// 貨幣市場），其餘野村投信基金（54檔基金家族裡的49檔）要延伸全部覆蓋，需要先把
// listNomuraFilings()式的MOPS清單頁自動解析做出來（這輪只手動核對出5檔檔名，自動解析沒做，
// 見fundProspectusFee.ts開頭註解）——這支function設計成「給多少筆對應就處理多少筆」，之後
// 補完整清單時不用改這支function本身。
//
// 費率屬於基金層級（跟持股月報一樣），同一個基金名稱寫入時，會更新該基金所有APPROVED、
// 非superseded share class的對應欄位。
import { prisma } from "@/lib/prisma";
import { fetchSitcaRows } from "@/lib/sitca-nav-sync/sitcaFetch";
import { extractNomuraProspectusFee, NOMURA_PROSPECTUS_FILENAME } from "@/lib/cloud-ingestion/fundProspectusFee";

export function isFundProspectusFeeWriteEnabled(): boolean {
  return process.env.FUND_PROSPECTUS_FEE_WRITE?.trim() === "on";
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

  for (const [fundName, filename] of Object.entries(NOMURA_PROSPECTUS_FILENAME)) {
    // 跟月報持股用一樣的base code家族共用邏輯：SITCA同一個基金簡稱(去掉類型後綴)的所有級別，
    // 全部一起更新這個基金層級的費率欄位。
    const matchedFundIds = nomuraRows
      .filter((r) => r.name.split("-")[0].replace(/證券投資信託基金$|基金$/, "") === fundName.replace(/基金$/, ""))
      .map((r) => fundByCode.get(r.taxId)?.id)
      .filter((id): id is string => !!id);
    if (matchedFundIds.length === 0) { failed.push({ fundName, error: "NO_FUND_ID_MATCHED" }); continue; }
    matched++;

    try {
      const result = await extractNomuraProspectusFee(filename, fundName);
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

  return { attempted: Object.keys(NOMURA_PROSPECTUS_FILENAME).length, matched, written, failed, dryRunRows };
}
