// 公開說明書經理費率/保管費率寫入（2026-11-03使用者核准，野村投信試點；2026-11-04改用
// listNomuraFilings()自動解析清單，取代原本只有5檔的NOMURA_PROSPECTUS_FILENAME手動對照表；
// 同日再改比對邏輯——原本借SITCA公告清單(taxId→funds.code)比對，對「XX傘型基金之YY基金」
// 「ETF連結基金」這類命名結構覆蓋不完整，改成跟lib/cloud-ingestion/issuerFundMappings.ts
// 月報持股用的同一套「去幣別/級別/法人後綴，基金層級名稱比對，只收唯一對應」規則，直接比對
// funds表裡公司含「野村」的所有列，不再透過SITCA taxId間接比對）。
// 寫入開關FUND_PROSPECTUS_FEE_WRITE，shadow模式預設不寫入。
//
// 範圍：listNomuraFilings()從MOPS清單頁解析出61筆申報記錄（114+115兩個ROC年度），只處理
// APPROVED、非superseded的基金——61筆裡對不到任何一個APPROVED fund.id的（已清算/改名後舊名/
// 非境內申報的傘型ETF子基金等），落入failed（NO_FUND_ID_MATCHED），不會被處理或寫入。
//
// 費率屬於基金層級（跟持股月報一樣），同一個基金名稱寫入時，會更新該基金所有APPROVED、
// 非superseded share class的對應欄位。
import { prisma } from "@/lib/prisma";
import { extractNomuraProspectusFee, listNomuraFilings } from "@/lib/cloud-ingestion/fundProspectusFee";

export function isFundProspectusFeeWriteEnabled(): boolean {
  return process.env.FUND_PROSPECTUS_FEE_WRITE?.trim() === "on";
}

// 2026-11-04 VERIFIED：MOPS申報清單用半形英數（"野村 e 科技基金"），funds表裡同一檔基金卻可能用
// 全形英數（"野村ｅ科技基金"）——把全形ASCII(U+FF01-FF5E)轉回半形(減0xFEE0)後再去空白比對，
// 兩邊就會收斂成同一個字串。
function normalizeNomuraName(raw: string): string {
  const halfWidth = raw.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  return halfWidth.replace(/\s+/g, "");
}

// 跟issuerFundMappings.ts月報持股用的baseName規則同一套：去掉「證券投資信託」這種法律用詞、
// 「XX傘型基金之YY基金」只取「之」後面真正的子基金名稱、再砍到第一個「基金」字為止，兩邊
// 都用這個規則正規化後比對，才能同時處理ETF連結基金／傘型之子基金這兩種命名結構。
function baseName(raw: string): string {
  let s = normalizeNomuraName(raw).replace(/證券投資信託|証券投資信託/g, "");
  const m = s.match(/之(野村)/);
  if (m) s = s.slice(m.index! + 1);
  const idx = s.indexOf("基金");
  return idx < 0 ? s : s.slice(0, idx + 2);
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

  // 2026-11-04：改成直接比對funds表（公司或名稱含「野村」），不再透過SITCA taxId間接比對——
  // 只收APPROVED、非superseded的列，同baseName的所有fund.id分到同一組，供後面「只對到唯一
  // 一檔」判斷歧義用。
  const candidates = await prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
    `SELECT f.id, f.name FROM funds f
     WHERE (f.company LIKE '%野村%' OR f.name LIKE '%野村%')
       AND f.id NOT IN (SELECT old_fund_id FROM fund_superseded_by_code)
       AND f.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type = 'FUND' AND status = 'APPROVED')`,
  );
  const dbBaseMap = new Map<string, string[]>();
  for (const f of candidates) {
    const b = baseName(f.name);
    if (!dbBaseMap.has(b)) dbBaseMap.set(b, []);
    dbBaseMap.get(b)!.push(f.id);
  }

  const failed: Array<{ fundName: string; error: string }> = [];
  const dryRunRows: FundProspectusFeeDryRunRow[] = [];
  let written = 0;
  let matched = 0;

  const filings = await listNomuraFilings();
  let attempted = 0;
  for (const [fundName, filing] of filings) {
    attempted++;
    const normalized = baseName(fundName);
    // 61筆申報記錄裡對不到任何APPROVED fund.id的（已清算/改名舊名/非境內申報ETF子基金/全形
    // 半形字元差異未收斂等），落入下面的NO_FUND_ID_MATCHED，不會被處理，等同篩掉；只要唯一
    // 對到一組才算成功，避免猜測。
    const matchedFundIds = dbBaseMap.get(normalized) ?? [];
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
