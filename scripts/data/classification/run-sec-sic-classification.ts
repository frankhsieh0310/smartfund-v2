// 一次性/手動補跑 SEC SIC 產業分類 ingestion（本地直連production DB），直到done或逾時。
// 核心邏輯跟雲端排程route(app/api/cron/sec-sic-classification/route.ts)共用
// lib/cron/secSicClassificationIngest.ts，不是另一套實作。
import { runSecSicClassificationBatch } from "../../../lib/cron/secSicClassificationIngest";

async function main() {
  const wallBudgetMs = Number(process.argv[2] ?? 1_800_000);
  const startCursor = process.argv[3] ?? null;
  const started = Date.now();
  let cursor: string | null = startCursor;
  let totalProcessed = 0, totalUpdated = 0, rounds = 0;
  const untranslated = new Set<string>();
  while (Date.now() - started < wallBudgetMs) {
    rounds++;
    const result = await runSecSicClassificationBatch({ afterTicker: cursor, timeBudgetMs: 60_000 });
    totalProcessed += result.processed;
    totalUpdated += result.updated;
    for (const code of result.skippedUntranslated) untranslated.add(code);
    console.log(`round ${rounds}: +${result.processed} processed, +${result.updated} updated, noCik=${result.skippedNoCik}, noSic=${result.skippedNoSic}, errors=${result.errors}, lastTicker=${result.lastTicker}, done=${result.done}`);
    if (result.done) { console.log("DONE — full universe covered this pass."); break; }
    cursor = result.lastTicker;
  }
  console.log(`TOTAL: processed=${totalProcessed} updated=${totalUpdated} rounds=${rounds} elapsedMs=${Date.now() - started}`);
  if (untranslated.size) console.log(`UNTRANSLATED SIC CODES: ${[...untranslated].join(", ")}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
