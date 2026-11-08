// 2026-11-08（使用者核准定案，排行榜混入舊日期資料修正）: 績效排序之前只排除
// pending_settle/suspect_unsettled 兩個旗標，但「某檔基金最新一筆被標記後，往回退到更舊但沒被
// 標記的那一筆」仍然可能被拿來跟別檔「當天就有正確新數字」的基金互相比較——大跌前的舊數字反而
// 排到最前面。規則改成：先找出這批結果裡「基準日最新的那一天」，只有基準日落在「最新那天，或最
// 多早一個營業日」範圍內的資料才能參與排名；更舊的一律沉到最後，並標記 metricStale=true（畫面
// 顯示「資料較舊」），不可以跟新鮮資料混排。
// 日期字串皆為 YYYY-MM-DD（ISO，可直接字串比較大小），所以這裡全部用字串運算，不轉 Date 物件。

/** ISO 星期一=1 ... 星期日=7，只用來判斷「最新基準日的前一個營業日」。 */
function isoWeekday(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const jsDay = d.getUTCDay(); // Sun=0..Sat=6
  return jsDay === 0 ? 7 : jsDay;
}

function addDaysIso(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 給定一個日期（通常本身就是交易日），回推上一個營業日（週一回推到週五，其餘回推一天）。 */
export function previousBusinessDayIso(dateStr: string): string {
  const dow = isoWeekday(dateStr);
  if (dow === 1) return addDaysIso(dateStr, -3); // Monday -> Friday
  if (dow === 7) return addDaysIso(dateStr, -2); // Sunday -> Friday（理論上不會是基準日，保險處理）
  if (dow === 6) return addDaysIso(dateStr, -1); // Saturday -> Friday（同上）
  return addDaysIso(dateStr, -1);
}

/** 這批結果裡最新的基準日（找不到任何日期時回傳 null）。 */
export function maxAsOfDate(dates: Array<string | null | undefined>): string | null {
  let max: string | null = null;
  for (const d of dates) {
    if (d && (max === null || d > max)) max = d;
  }
  return max;
}

/**
 * 判斷某一筆資料的基準日是否夠新鮮，可以參與排名。
 * asOfDate 為 null（完全沒有資料）不算「舊資料」，由呼叫端另外處理成「無資料」。
 */
export function isAsOfDateFresh(asOfDate: string | null | undefined, datasetMaxAsOfDate: string | null): boolean {
  if (!asOfDate) return true; // 沒有日期可比，不在這裡擋，交給呼叫端的 null 處理
  if (!datasetMaxAsOfDate) return true;
  return asOfDate >= previousBusinessDayIso(datasetMaxAsOfDate);
}

/** SQL 版本：給一個 date 欄位的 SQL 片段，回傳「這一列的基準日是否落在最新基準日或最多早一個
 * 營業日內」的布林運算式。用同一個 CTE 算出的 maxd 欄位名稱代入。 */
export function freshnessSqlExpr(dateColumnSql: string, maxDateColumnSql: string): string {
  return `(${dateColumnSql} >= CASE EXTRACT(ISODOW FROM ${maxDateColumnSql})::int WHEN 1 THEN ${maxDateColumnSql} - 3 ELSE ${maxDateColumnSql} - 1 END)`;
}
