// 只讀邏輯驗證：ingestUsFundShareClass本身一定會寫DB（沒有dry-run開關），不能直接在Preview上
// 呼叫驗證。這裡單獨驗證幣別解析邏輯本身（跟fundIngest.ts裡那段邏輯完全一致），不碰DB。
import { mapTdccCurrencyToIso } from "../../../lib/tdcc-currency-map";

function resolveCurrency(raw: string | null): { isoCurrency: string | null; currencyUnresolved: boolean } {
  let isoCurrency: string | null = null;
  let currencyUnresolved = false;
  if (raw) {
    if (/^[A-Z]{3}$/.test(raw)) isoCurrency = raw;
    else {
      const mapped = mapTdccCurrencyToIso(raw);
      if (mapped) isoCurrency = mapped;
      else currencyUnresolved = true;
    }
  }
  return { isoCurrency, currencyUnresolved };
}

const cases: [string | null, string][] = [
  ["USD", "合法ISO，應直接使用"],
  ["美元", "中文，應透過tdcc-currency-map轉成USD"],
  ["日幣", "中文（之前漏掉的那個），應轉成JPY"],
  [null, "完全沒有資料，應該是null/not-unresolved（讓既有USD預設接手，不算unresolved）"],
  ["XYZ", "完全查不到的亂碼，應該是currencyUnresolved=true"],
  ["歐元", "中文，應轉成EUR"],
];
console.log("幣別解析邏輯驗證（純邏輯，不寫DB）：");
for (const [raw, desc] of cases) {
  const r = resolveCurrency(raw);
  console.log(`輸入=${JSON.stringify(raw)} (${desc}) => isoCurrency=${r.isoCurrency}, currencyUnresolved=${r.currencyUnresolved}`);
}
