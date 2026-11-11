// 2026-11-11（使用者核准，^FTCS/^REIT/^BKCH重複代號事故）: 資料庫裡原本就有^FTCS/^REIT/^BKCH
// 三筆跟真正的FTCS/REIT/BKCH分開的重複ETF資料（通用發行商名稱如"FIRST TRUST EXCH"，不在台灣
// 買得到核心母體裡）——查過目前repo唯一會真的INSERT新etfs列的程式是
// lib/cron/newListingDetection.ts（只處理TWSE/TPEx，已經在那邊補上同一套正規化），這三筆重複
// 資料本身不是現有任何排程寫入的，查不到確切來源（可能是已刪除的舊一次性匯入腳本）。使用者核准
// 「不要刪除，只要防止再產生新的重複」——這個檔案是給任何「未來」新增/修改會INSERT etfs列的
// 程式共用的檢查工具，不是現在就有程式在呼叫它。
import { prisma } from "@/lib/prisma";

/** 去掉常見的非英數字首碼（目前只處理開頭的^，之後發現其他樣式再擴充），用於判斷「這是不是同一檔
 * 商品的另一種代號寫法」。只正規化比對用，不改動任何既有欄位值。 */
export function normalizeEtfCodeForDuplicateCheck(code: string): string {
  return code.trim().toUpperCase().replace(/^[^A-Z0-9]+/, "");
}

/** 寫入新ETF列之前先呼叫：同一個掛牌交易所、代號正規化後相同的列已經存在，就回傳那一筆既有資料，
 * 呼叫端應該用既有列（或人工檢視），不要再建立新列。回傳null代表確認沒有重複，可以安全新增。 */
export async function findExistingEtfByNormalizedCode(
  code: string,
  exchange: string | null,
): Promise<{ id: string; code: string; name: string } | null> {
  const target = normalizeEtfCodeForDuplicateCheck(code);
  if (!target) return null;
  const candidates = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; name: string }>>(
    exchange
      ? `SELECT id, code, name FROM etfs WHERE exchange = $2 AND upper(regexp_replace(code, '^[^A-Za-z0-9]+', '')) = $1`
      : `SELECT id, code, name FROM etfs WHERE upper(regexp_replace(code, '^[^A-Za-z0-9]+', '')) = $1`,
    ...(exchange ? [target, exchange] : [target]),
  );
  return candidates[0] ?? null;
}
