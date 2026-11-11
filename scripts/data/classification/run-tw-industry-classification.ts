// 一次性/手動補跑 TWSE/TPEx 產業分類 ingestion（本地直連production DB）。
// 核心邏輯跟雲端排程route(app/api/cron/tw-industry-classification/route.ts)共用
// lib/cron/twIndustryClassificationIngest.ts，不是另一套實作。
import { runTwIndustryClassificationSync } from "../../../lib/cron/twIndustryClassificationIngest";

async function main() {
  const result = await runTwIndustryClassificationSync();
  console.log(`[tw-industry] fetched=${result.fetched} updated=${result.updated} skippedNoMatch=${result.skippedNoMatch} skippedAlready=${result.skippedAlready} errors=${result.errors}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
