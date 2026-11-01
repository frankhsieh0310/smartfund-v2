// 2026-11-01（使用者核准）: 台股ETF分類原本只信任TWSE「基金基本資料彙總表」(t187ap47_L.csv)，
// 這份資料本身可能已經不在現行交易但還沒被移出彙總表（0060「新台灣」就是實例，VERIFIED
// 2026-10-31：e添富現行清單查無、Yahoo 0060.TW回404，但t187ap47_L.csv當時仍列著它）。
// 這支模組額外跟兩個交易所「自己的現行上市ETF清單」做唯讀比對，抓出「分類仍是APPROVED、
// 但已經不在交易所自己的現行清單上」的候選，只回傳清單，不寫入、不自動變更分類——是否要把
// 哪一檔排進 tw_purchasable_manual_overrides，由使用者看過結果後決定。
//
// TWSE來源：e添富 ETF投資篩選器 /zh/ETFortune/ajaxProductsResult（VERIFIED：TWSE自己的ETF官方
// 入口，從TWSE首頁「e添富」選單進入），空body POST回傳現行全部TWSE掛牌ETF。
//
// TPEx來源（2026-11-01修正）：「上櫃股票每日收盤行情」只列出當天有成交的ETF，低流動性債券ETF
// 常常連續好幾天無成交、不在表上不代表下市（使用者2026-11-01核正：00793B、00847B前天VERIFIED
// 還在交易）——改用證券櫃檯買賣中心首頁「ETF/ETN」選單 -> ETF訊息中心「投資篩選器」
// (info.tpex.org.tw/ETF/zh/filter.html -> 其背後的 info.tpex.org.tw/api/etfFilter)，這是
// 跟TWSE e添富同一類、非交易日活躍度篩選的官方商品清單工具，空body POST當場VERIFIED可用，
// 可以每天即時重新抓，不是寫死的快照。
//
// 2026-11-01（使用者更正，撤銷上一版的已知例外）：00790B(復華次順位金融債)、00793B(群益AAA-A
// 醫療債)、00847B(中信美國市政債)這3檔上一輪被列為「已知例外、維持APPROVED」，理由是使用者前天
// 口頭核實還在交易——VERIFIED這個判斷是錯的。從TPEx官方「重大訊息」(ETF訊息中心->重大訊息->
// 新上櫃/終止上櫃) VERIFIED三檔都已清算完成、信託契約終止：
//   00790B 清算基準日114/04/25(2025-04-25)、清算餘額分配114/05/15(2025-05-15)
//   00793B 清算基準日115/09/29(2026-09-29)、清算程序完成公告115/10/16(2026-10-16)
//   00847B 清算基準日115/10/15(2026-10-15)、清算程序完成公告115/10/30(2026-10-30)
// 三檔都不在TWSE/TPEx現行商品清單裡是正確結果，不是篩選器的收錄落差——移除「已知例外」清單，
// 讓這3檔照常進mismatches，由使用者決定要不要寫進tw_purchasable_manual_overrides。

const TWSE_URL = "https://www.twse.com.tw/zh/ETFortune/ajaxProductsResult";
const TPEX_FILTER_URL = "https://info.tpex.org.tw/api/etfFilter";
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

export async function fetchTpexLiveEtfCodes(): Promise<Set<string>> {
  const res = await fetch(TPEX_FILTER_URL, {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`TPEX_ETFFILTER_HTTP_${res.status}`);
  const json = (await res.json()) as { data: Array<{ stockNo: string }> };
  return new Set(json.data.map((d) => d.stockNo));
}

export type LiveListMismatch = { code: string; name: string; exchange: string; provider: string };

export async function findLiveListMismatches(
  query: (sql: string) => Promise<Array<{ code: string; name: string; exchange: string; provider: string }>>,
): Promise<{
  twseChecked: number; tpexChecked: number;
  mismatches: LiveListMismatch[]; knownFalsePositives: LiveListMismatch[];
  twseError: string | null; tpexError: string | null;
}> {
  const rows = await query(
    `SELECT e.code, e.name, e.exchange, e.provider FROM etfs e
       JOIN tw_purchasable_classification cl ON cl.asset_id = e.id AND cl.asset_type = 'ETF'
      WHERE cl.status = 'APPROVED' AND e.exchange IN ('TWSE', 'TPEx')`,
  );
  const twseRows = rows.filter((r) => r.exchange === "TWSE");
  const tpexRows = rows.filter((r) => r.exchange === "TPEx");

  let twseLive: Set<string> | null = null;
  let twseError: string | null = null;
  try {
    twseLive = await fetchTwseLiveEtfCodes();
  } catch (e) {
    twseError = (e as Error).message; // 抓不到就不比對TWSE那一側，不當成「全部都不在清單上」
  }

  let tpexLive: Set<string> | null = null;
  let tpexError: string | null = null;
  try {
    tpexLive = await fetchTpexLiveEtfCodes();
  } catch (e) {
    tpexError = (e as Error).message;
  }

  const mismatches: LiveListMismatch[] = [];
  // 2026-11-01：已知例外清單已撤銷（見上方註解），knownFalsePositives固定回傳空陣列，
  // 保留欄位只是不破壞route.ts既有的回傳形狀。
  const knownFalsePositives: LiveListMismatch[] = [];

  if (twseLive) for (const r of twseRows) if (!twseLive.has(r.code)) mismatches.push(r);
  if (tpexLive) for (const r of tpexRows) if (!tpexLive.has(r.code)) mismatches.push(r);

  return { twseChecked: twseRows.length, tpexChecked: tpexRows.length, mismatches, knownFalsePositives, twseError, tpexError };
}
