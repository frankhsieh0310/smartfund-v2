// 2026-11-01（使用者核准）: 台股ETF分類原本只信任TWSE「基金基本資料彙總表」(t187ap47_L.csv)，
// 這份資料本身可能已經不在現行交易但還沒被移出彙總表（0060「新台灣」就是實例，VERIFIED
// 2026-10-31：e添富現行清單查無、Yahoo 0060.TW回404，但t187ap47_L.csv當時仍列著它）。
// 這支模組額外跟兩個交易所「自己的現行上市ETF清單」做唯讀比對，抓出「分類仍是APPROVED、
// 但已經不在交易所自己的現行清單上」的候選，只回傳清單，不寫入、不自動變更分類——是否要把
// 哪一檔排進 tw_purchasable_manual_overrides，由使用者看過結果後決定（2026-11-01使用者原話：
// 「不在清單上的逐檔列出代碼和名稱，先讓我看過，不要寫入」）。
//
// TWSE來源：e添富 ETF投資篩選器 /zh/ETFortune/ajaxProductsResult（VERIFIED：TWSE自己的ETF官方
// 入口，從TWSE首頁「e添富」選單進入，不是猜的），空body POST回傳現行全部TWSE掛牌ETF。
// VERIFIED 這份清單只涵蓋TWSE掛牌的股票型ETF，不含TPEx掛牌的債券型ETF（exchange='TPEx'的121檔
// 全部不在這份清單裡，不是下市，只是這個入口的收錄範圍本來就不含TPEx商品）——所以只拿來比對
// exchange='TWSE'的列。
//
// TPEx來源：證券櫃檯買賣中心官網「ETF/ETN」選單 -> 當日行情表 (/zh-tw/product/etf/info/price.html)，
// 這個頁面本身的POST端點(www/zh-tw/afterTrading/otc)需要一組目前還原不出來的jQuery/tables.js內部
// 參數才能直接呼叫，VERIFIED直接重現該POST會被拒絕或回傳空清單——這支模組改用同一個頁面渲染後
// 的DOM逐頁擷取（瀏覽器實際渲染出的「代號」欄位），只拿來比對exchange='TPEx'的列。這個DOM擷取
// 做法只能在有瀏覽器環境的手動驗證回合裡執行，這支Node模組本身沒有對應的無頭瀏覽器基礎設施，所以
// TPEx這一段目前是「讀取已經人工驗證過的清單快照」，不是這支函式自動重新抓——見下方
// TPEX_LIVE_LIST_SNAPSHOT 的註解。

const TWSE_URL = "https://www.twse.com.tw/zh/ETFortune/ajaxProductsResult";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export async function fetchTwseLiveEtfCodes(): Promise<Set<string>> {
  const res = await fetch(TWSE_URL, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: "",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`TWSE_ETFORTUNE_HTTP_${res.status}`);
  const json = (await res.json()) as { data: Array<{ stockNo: string }> };
  return new Set(json.data.map((d) => d.stockNo));
}

// 2026-11-01 VERIFIED快照：證券櫃檯買賣中心「上櫃股票每日收盤行情(不含定價)」頁面
// (www.tpex.org.tw/zh-tw/product/etf/info/price.html)，category=「上櫃指數股票型基金(ETF)」，
// 2026/10/30收盤資料，118檔，逐頁從官網渲染後的表格擷取（不是猜的、不是估計的）。這份清單目前
// 用硬編碼快照方式存在這裡，因為這支頁面的AJAX端點(afterTrading/otc)需要tables.js內部才看得到的
// 請求參數，暫時無法從純Node環境直接重現同一支POST；要讓這個常態檢查真正逐日更新TPEx這一側，
// 之後需要在有瀏覽器環境的回合裡重新擷取並更新這個陣列，或還原出tables.js實際送出的body。
const TPEX_LIVE_LIST_SNAPSHOT = {
  asOfDate: "2026-10-30",
  codes: [
    "00411A", "00679B", "00687B", "00687C", "00694B", "00695B", "00696B", "00697B", "00719B", "00720B",
    "00722B", "00723B", "00724B", "00725B", "00726B", "00727B", "00734B", "00740B", "00741B", "00746B",
    "00749B", "00750B", "00751B", "00754B", "00755B", "00756B", "00758B", "00759B", "00760B", "00761B",
    "00764B", "00768B", "00772B", "00773B", "00777B", "00778B", "00779B", "00780B", "00781B", "00782B",
    "00785B", "00786B", "00787B", "00788B", "00789B", "00791B", "00792B", "00795B", "00799B", "00834B",
    "00836B", "00840B", "00841B", "00842B", "00844B", "00845B", "00846B", "00848B", "00849B", "00853B",
    "00856B", "00857B", "00858", "00859B", "00860B", "00862B", "00863B", "00864B", "00867B", "00870B",
    "00877", "00884B", "00886", "00887", "00888", "00890B", "00928", "00931B", "00933B", "00937B",
    "00942B", "00948B", "00950B", "00955", "00957B", "00958B", "00959B", "00966B", "00967B", "00968B",
    "00969B", "00970B", "00980B", "00980D", "00980T", "00981B", "00981D", "00982B", "00983B", "00984B",
    "00985D", "00986B", "00986D", "00987B", "00987D", "00988B", "00989B", "00990B", "00992B", "00998A",
    "006201", "009806", "009807", "009814", "009815", "009822", "009823", "009825",
  ],
};

export function getTpexLiveEtfSnapshot(): { asOfDate: string; codes: Set<string> } {
  return { asOfDate: TPEX_LIVE_LIST_SNAPSHOT.asOfDate, codes: new Set(TPEX_LIVE_LIST_SNAPSHOT.codes) };
}

export type LiveListMismatch = { code: string; name: string; exchange: string; provider: string };

export async function findLiveListMismatches(
  query: (sql: string) => Promise<Array<{ code: string; name: string; exchange: string; provider: string }>>,
): Promise<{ twseChecked: number; tpexChecked: number; tpexSnapshotAsOfDate: string; mismatches: LiveListMismatch[]; twseError: string | null }> {
  const rows = await query(
    `SELECT e.code, e.name, e.exchange, e.provider FROM etfs e
       JOIN tw_purchasable_classification cl ON cl.asset_id = e.id AND cl.asset_type = 'ETF'
      WHERE cl.status = 'APPROVED' AND e.exchange IN ('TWSE', 'TPEx')`,
  );
  const twseRows = rows.filter((r) => r.exchange === "TWSE");
  const tpexRows = rows.filter((r) => r.exchange === "TPEx");
  const tpexSnapshot = getTpexLiveEtfSnapshot();

  let twseLive: Set<string> | null = null;
  let twseError: string | null = null;
  try {
    twseLive = await fetchTwseLiveEtfCodes();
  } catch (e) {
    twseError = (e as Error).message; // 抓不到就不比對TWSE那一側，不當成「全部都不在清單上」
  }

  const mismatches: LiveListMismatch[] = [];
  if (twseLive) {
    for (const r of twseRows) if (!twseLive.has(r.code)) mismatches.push(r);
  }
  for (const r of tpexRows) if (!tpexSnapshot.codes.has(r.code)) mismatches.push(r);

  return { twseChecked: twseRows.length, tpexChecked: tpexRows.length, tpexSnapshotAsOfDate: tpexSnapshot.asOfDate, mismatches, twseError };
}
