// 一次性腳本：停用 ^PSET 這個重複/錯誤的ETF列（ETF_HISTORY_GAP健康報告異常稽核發現）。
// VERIFIED：etfs表裡同時有兩筆——
//   1bc67adc-... code="PSET"  name="Principal Quality ETF"      exchange=NasdaqGM （正確的那筆，資料正常更新）
//   7fad819b-... code="^PSET" name="PRINCIPAL EXCHANGE"         exchange="Nasdaq GIDS" （這筆是垂死的重複列）
// 查證：Yahoo/SEC都確認真正的ETF代碼是"PSET"（Principal Quality ETF，前身Principal Price Setters
// Index ETF），"^"字首在Yahoo慣例裡代表「指數」不是ETF，"Nasdaq GIDS"(Global Index Data Service)
// 也是指數資料來源、不是真正掛牌ETF的交易所欄位——這筆"^PSET"看起來是當年擷取指數資料時誤建的
// 垂死列，資料停在10/18後沒再更新，被tw_purchasable_classification誤標成APPROVED，使使用者
// 誤以為多了一檔可買的ETF。
//
// 只停用不刪除：is_active設false、tw_purchasable_classification改成EXCLUDED_DUPLICATE，
// 保留所有歷史資料與這筆本身，可隨時回復。單一交易，先查目前狀態再寫入。

import { PrismaClient } from "@prisma/client";

const ETF_ID = "7fad819b-828f-48b5-b1c1-07f61ff8d375"; // ^PSET，確認過的重複列
const prisma = new PrismaClient();

async function main() {
  const before = await prisma.$queryRawUnsafe(`SELECT id, code, name, is_active FROM etfs WHERE id = $1`, ETF_ID);
  console.log("停用前：", JSON.stringify(before));
  if (before.length === 0) { console.log("這筆ETF已經不存在，不需要再處理。"); return; }
  if (before[0].code !== "^PSET") { console.log("code不是預期的^PSET，中止，避免動錯資料。"); return; }

  await prisma.$transaction([
    prisma.$executeRawUnsafe(`UPDATE etfs SET is_active = false, updated_at = NOW() WHERE id = $1`, ETF_ID),
    prisma.$executeRawUnsafe(
      `UPDATE tw_purchasable_classification SET status = 'EXCLUDED_DUPLICATE', updated_at = NOW() WHERE asset_type = 'ETF' AND asset_id = $1`,
      ETF_ID,
    ),
  ]);

  const after = await prisma.$queryRawUnsafe(`SELECT id, code, is_active FROM etfs WHERE id = $1`, ETF_ID);
  const afterClass = await prisma.$queryRawUnsafe(`SELECT status FROM tw_purchasable_classification WHERE asset_type='ETF' AND asset_id = $1`, ETF_ID);
  console.log("停用後：", JSON.stringify(after), JSON.stringify(afterClass));
}

main()
  .catch((error) => { console.error("失敗，交易已自動回復：", error.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
