// 證交所「基本市況報導網站」(MIS) 的「ETF發行單位變動及淨值揭露專區」——
// https://mis.twse.com.tw/stock/various-areas/etf-price/indicator-disclosure-etf 這個頁面背後
// 真正打的資料API，plain JSON，不需要認證、不需要特殊header，15秒更新一次。涵蓋TWSE和TPEx
// 掛牌的ETF（VERIFIED 00722B/00937B/00948B這3檔TPEx的也在同一份清單裡，不用分開打TPEx的頁面）。
//
// 2026-10-30（使用者核准，ETF折溢價接官方資料）: 這份資料本身就是「投信或總代理人預估淨值」
// 跟「預估折溢價幅度」官方直接公布的數字（不是我方自算），VERIFIED跟頁面本身渲染出來的表格逐欄
// 核對一致。price(e)/estimatedNav(f)/premiumPct(g)/asOfDate(i)都來自同一筆記錄、同一個時間戳，
// 不會有「淨值用舊的、價格用新的」這種跨欄位日期不一致問題——這正是2026-10-30上午
// app/etf/[code]/page.tsx那個bug（etfs.latestNav是死資料、跟當天price硬配對）的根本解法。
//
// 不偽裝User-Agent：這支fetch完全不帶自訂header，跟VERIFIED可以直接200成功的狀態一致，不繞過
// 任何機制。遇到非200或JSON格式不對，直接往上丟錯誤，由呼叫端的cron run-log記錄、不重試硬闖。
const URL = "https://mis.twse.com.tw/stock/data/all_etf.txt";

type RawRow = { a: string; b: string; e: string | number; f: string | number; g: string | number; h: string | number; i: string };

export type TwseEtfPremiumDiscount = {
  code: string;
  name: string;
  price: number;
  estimatedNav: number;
  premiumPct: number;
  previousNav: number;
  asOfDate: string; // YYYY-MM-DD, 跟price/estimatedNav/premiumPct同一筆記錄的日期
};

function ymdToIso(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

export async function fetchTwseEtfPremiumDiscount(): Promise<Map<string, TwseEtfPremiumDiscount>> {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`TWSE_MIS_ETF_HTTP_${res.status}`);
  const json = (await res.json()) as { a1?: Array<{ msgArray?: RawRow[] }> };
  const rows: RawRow[] = json.a1?.flatMap((g) => g.msgArray ?? []) ?? [];
  if (!rows.length) throw new Error("TWSE_MIS_ETF_EMPTY — a1[].msgArray missing/empty, page markup may have changed");

  const result = new Map<string, TwseEtfPremiumDiscount>();
  for (const row of rows) {
    const price = Number(row.e);
    const estimatedNav = Number(row.f);
    const premiumPct = Number(row.g);
    const previousNav = Number(row.h);
    if (![price, estimatedNav, premiumPct, previousNav].every(Number.isFinite)) continue;
    if (!/^\d{8}$/.test(row.i)) continue;
    result.set(row.a, { code: row.a, name: row.b, price, estimatedNav, premiumPct, previousNav, asOfDate: ymdToIso(row.i) });
  }
  return result;
}
