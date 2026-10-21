export const formatPriceChange = (change: number | null, percent: number | null, currency: string) => {
  if (change == null || percent == null) return "—";
  const unit = currency === "TWD" ? "元" : currency === "USD" ? "美元" : currency;
  const sign = change > 0 ? "+" : "";
  const percentSign = percent > 0 ? "+" : "";
  return `${sign}${change.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} ${unit}（${percentSign}${percent.toFixed(2)}%）`;
};

export const formatVolume = (shares: number | null) => shares == null ? "—" : shares >= 100_000_000
  ? `${(shares / 100_000_000).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 億股`
  : shares >= 1_000_000 ? `${(shares / 1_000_000).toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} 百萬股`
  : `${shares.toLocaleString("zh-TW")} 股`;

export const formatMoneyByAsset = (value: number | null, currency: string) => {
  if (value == null) return "—";
  const unit = currency === "TWD" ? "元" : currency === "USD" ? "美元" : currency;
  return `${value.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} ${unit}`;
};

const formatLargeMoney = (value: number | null, currency: string) => {
  if (value == null) return "—";
  const unit = currency === "TWD" ? "元" : currency === "USD" ? "美元" : currency;
  if (Math.abs(value) >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 兆${unit}`;
  if (Math.abs(value) >= 100_000_000) return `${(value / 100_000_000).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 億${unit}`;
  if (Math.abs(value) >= 10_000) return `${(value / 10_000).toLocaleString("zh-TW", { maximumFractionDigits: 2 })} 萬${unit}`;
  return formatMoneyByAsset(value, currency);
};

export const formatTurnover = formatLargeMoney;
export const formatMarketCap = formatLargeMoney;

// 2026-10-21（使用者核准的畫面顯示層統一）: 資料庫一律存ISO 4217代碼（今天的幣別修正已經讓
// 全部funds.currency都是ISO格式），畫面一律轉成中文顯示——避免「同一個頁面有的基金顯示JPY、
// 有的顯示日圓」這種不一致。只改顯示文字，不改版面、顏色、排版。
const ISO_CURRENCY_ZH: Record<string, string> = {
  USD: "美元", TWD: "新台幣", EUR: "歐元", AUD: "澳幣", CNY: "人民幣", CNH: "離岸人民幣",
  ZAR: "南非幣", JPY: "日圓", GBP: "英鎊", SGD: "新加坡幣", NZD: "紐西蘭幣", HKD: "港幣",
  CAD: "加拿大幣", SEK: "瑞典幣", CHF: "瑞士法郎", NOK: "挪威幣",
};

/** ISO 4217代碼轉中文幣別名稱，查不到的代碼（未預期的新幣別）原樣顯示代碼，不隱藏、不報錯。 */
export const formatCurrencyZh = (currency: string | null | undefined): string => {
  if (!currency) return "—";
  return ISO_CURRENCY_ZH[currency] ?? currency;
};
