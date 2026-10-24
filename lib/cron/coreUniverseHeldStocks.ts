// 共用：找出「四類核心母體的ETF／基金實際有持有」的非台股/美股股票清單。從
// lib/cron/yahooFundamentalsSync.ts抽出來，給全球股票最新價格同步cron共用，避免兩邊各寫一份
// 容易drift。見原本的說明：
// - ETF這條：etf_holdings本身有ticker+country，直接對stocks表match（etf_holdings沒有
//   stock_id外鍵，用ticker+country是能確定的對應）。
// - 基金這條：真正的資料在holdings表（asset_type='FUND'）+已經建好、選股反查
//   (/api/mobile/reverse-holdings)本來就在用的reverse_current_positions投影表——product_key
//   對FUND是"FUND:<fund_id>"，可以直接parse出fund_id跟tw_purchasable_classification對應。
//   fund_holdings/ISIN橋接表全庫只有10筆，不是真正資料來源，不用那條路。
import { prisma } from "@/lib/prisma";

export async function findCoreUniverseHeldStockIds(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT DISTINCT s.id
       FROM stocks s
       JOIN etf_holdings eh ON eh.ticker = s.ticker AND (eh.country = s.country OR eh.country IS NULL)
       JOIN tw_purchasable_classification c ON c.asset_type = 'ETF' AND c.status = 'APPROVED' AND c.asset_id = eh.etf_id
      WHERE s.is_active AND s.country NOT IN ('TW', 'US')
     UNION
     SELECT DISTINCT s.id
       FROM stocks s
       JOIN reverse_current_positions p ON p.stock_id = s.id AND p.type = '基金'
       JOIN tw_purchasable_classification c ON c.asset_type = 'FUND' AND c.status = 'APPROVED' AND c.asset_id = split_part(p.product_key, ':', 2)
      WHERE s.is_active AND s.country NOT IN ('TW', 'US')`,
  );
  return rows.map((r) => r.id);
}
