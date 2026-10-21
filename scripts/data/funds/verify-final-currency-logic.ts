import { mapTdccCurrencyToIso, isValidIsoCurrency } from "../../../lib/tdcc-currency-map";

function resolveCurrency(raw: string | null) {
  let isoCurrency: string | null = null;
  let currencyUnresolved = false;
  if (isValidIsoCurrency(raw)) { isoCurrency = raw; }
  else if (raw) {
    const mapped = mapTdccCurrencyToIso(raw);
    if (mapped) isoCurrency = mapped;
    else currencyUnresolved = true;
  } else { currencyUnresolved = true; }
  return { isoCurrency, currencyUnresolved };
}

const cases: [string | null, string][] = [
  ["USD", "合法ISO"], ["美元", "中文轉換"], ["日幣", "中文轉換"],
  [null, "完全沒資料，現在也應該unresolved（不再預設USD）"],
  ["XYZ", "格式對但不是真貨幣，現在應該unresolved"],
  ["AUD", "合法ISO"], ["ZAR", "合法ISO"], ["TWD", "合法ISO"],
];
console.log("最終驗證（ISO 4217正式清單 + 不再預設USD）:");
for (const [raw, desc] of cases) {
  const r = resolveCurrency(raw);
  console.log(`輸入=${JSON.stringify(raw)} (${desc}) => iso=${r.isoCurrency}, unresolved=${r.currencyUnresolved}`);
}
