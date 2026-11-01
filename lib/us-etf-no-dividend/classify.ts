// 2026-11-01（使用者核准，用詞修正）: 美股ETF「近12個月未配息」判斷——純DB端分類，不打外部
// API（dividend_yield / inception_date 都已經是既有Yahoo enrich排程寫回的既有資料，這裡只讀）。
// 併進既有的 tw-purchasable-classify 每日排程裡當一個額外步驟，不新增獨立cron
// (vercel.json目前剛好卡在100個cron上限，見liveListCrossCheck.ts同樣理由的先例)。
//
// 用詞修正的理由：dividend_yield=0 只代表「近12個月Yahoo沒有抓到配息」，不代表「配息政策是
// 不配息」——剛上市還沒等到第一次配息的ETF，dividend_yield一樣會是0。所以：
//   1. 只有成立滿12個月（inception_date <= now() - 12 months）且 dividend_yield = 0 的，才標記
//      為 distribution_freq = 'NO_DIST_12M_YAHOO'，畫面顯示「近12個月未配息（來源：Yahoo）」。
//   2. 不滿12個月的，不管dividend_yield是不是0，一律不標記，維持在配息缺口分母裡。
//   3. inception_date本身是NULL（不知道上市多久）的，一律不標記，不猜。
//   4. 'NONE'（本基金不配息）只保留給發行商官網/公開說明書明確寫不配息的既有判斷，這裡完全不寫
//      'NONE'，也絕不覆蓋既有的'NONE'/'UNSPECIFIED'/其他非NULL值（WHERE distribution_freq IS NULL）。
//
// SHADOW MODE BY DEFAULT：除非 US_ETF_NO_DIVIDEND_WRITE 精確等於"on"，只分類、回報，不寫入。
import { prisma } from "@/lib/prisma";
import { isUsEtfNoDividendWriteEnabled } from "./writeGate";

export type UsEtfNoDividendResult = { writeEnabled: boolean; candidateCount: number; written: number };

export async function classifyUsEtfNoDividend(): Promise<UsEtfNoDividendResult> {
  const writeEnabled = isUsEtfNoDividendWriteEnabled();

  const candidates = await prisma.$queryRawUnsafe<Array<{ id: string; code: string }>>(
    `SELECT e.id, e.code FROM etfs e
       JOIN tw_purchasable_classification cl ON cl.asset_id = e.id AND cl.asset_type = 'ETF'
      WHERE cl.status = 'APPROVED' AND e.exchange NOT IN ('TWSE', 'TPEx')
        AND e.id NOT IN (SELECT etf_id FROM etf_distribution_events)
        AND e.dividend_yield = 0
        AND e.inception_date IS NOT NULL AND e.inception_date <= now() - interval '12 months'
        AND e.distribution_freq IS NULL`,
  );

  let written = 0;
  if (writeEnabled) {
    for (const row of candidates) {
      await prisma.$executeRawUnsafe(
        `UPDATE etfs SET distribution_freq = 'NO_DIST_12M_YAHOO', distribution_checked_at = NOW() WHERE id = $1 AND distribution_freq IS NULL`,
        row.id,
      );
      written++;
    }
  }
  return { writeEnabled, candidateCount: candidates.length, written };
}
