// 台股ETF「本基金不配息」官方判斷 — 元大投信官網產品頁(yuantaetfs.com/product/detail/{code}/
// Basic_information，Nuxt SSR，raw fetch可直接拿到內容)上的「收益分配」欄位(是/否)，VERIFIED
// 2026-10-31：這是官方欄位，不是看基金名稱猜（「正2/反1」這類名稱特徵完全沒有用在判斷邏輯裡）。
// 範圍目前只到元大投信（yuantaetfs.com這個網域只服務元大自己發行的ETF），其他發行商的ETF這裡
// 不處理、維持在覆蓋率分母裡，不排除。
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export class YuantaRateLimitedError extends Error {
  httpStatus: number;
  constructor(httpStatus: number) { super(`YUANTA_HTTP_${httpStatus}`); this.httpStatus = httpStatus; }
}

export type YuantaDistributionCheck = { distributes: boolean | null; notFound: boolean };

export async function checkYuantaDistribution(code: string): Promise<YuantaDistributionCheck> {
  const url = `https://www.yuantaetfs.com/product/detail/${encodeURIComponent(code)}/Basic_information`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 403 || res.status === 429) throw new YuantaRateLimitedError(res.status);
  if (!res.ok) return { distributes: null, notFound: true };
  const text = await res.text();
  if (text.includes("查無此商品")) return { distributes: null, notFound: true };
  const m = text.match(/收益分配<\/div>\s*<div[^>]*>([^<]*)<\/div>/);
  if (!m) return { distributes: null, notFound: false };
  if (m[1] === "否") return { distributes: false, notFound: false };
  if (m[1] === "是") return { distributes: true, notFound: false };
  return { distributes: null, notFound: false };
}
