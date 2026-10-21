import { detectNewDomesticFunds, detectNewOffshoreFunds } from "../../../lib/cron/newFundListingDetection";

async function main() {
  console.log("Dry-run (writeEnabled=false，不會寫入) 驗證 skippedInvalidCurrency 欄位存在且可讀...");
  const domestic = await detectNewDomesticFunds(false, Date.now() + 30_000);
  const offshore = await detectNewOffshoreFunds(false, Date.now() + 30_000);
  console.log("domestic.skippedInvalidCurrency:", JSON.stringify(domestic.skippedInvalidCurrency));
  console.log("offshore.skippedInvalidCurrency:", JSON.stringify(offshore.skippedInvalidCurrency));
  console.log("domestic.created (dry-run下恆為空):", JSON.stringify(domestic.created));
  console.log("offshore.created (dry-run下恆為空):", JSON.stringify(offshore.created));
}
main().catch((e) => { console.error("ERROR:", e); process.exitCode = 1; });
