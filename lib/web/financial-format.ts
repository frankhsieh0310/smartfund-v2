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
