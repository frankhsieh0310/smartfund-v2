// 一次性/手動補跑 SEC Form 4 ingestion（本地直連production DB），直到EXHAUSTED或逾時。
// 核心邏輯跟雲端排程route(app/api/cron/sec-form4-insider-trades/route.ts)共用
// lib/cron/secForm4Ingest.ts，不是另一套實作。
import { runSecForm4IngestBatch } from "../../../lib/cron/secForm4Ingest";

async function main() {
  const wallBudgetMs = Number(process.argv[2] ?? 540_000);
  const startCursor = process.argv[3] ?? null;
  const started = Date.now();
  let cursor: string | null = startCursor;
  let totalIssuers = 0, totalFilings = 0, totalRows = 0, rounds = 0;
  while (Date.now() - started < wallBudgetMs) {
    rounds++;
    const result = await runSecForm4IngestBatch({ afterTicker: cursor, timeBudgetMs: 60_000 });
    totalIssuers += result.issuersProcessed;
    totalFilings += result.filingsFetched;
    totalRows += result.rowsInserted;
    console.log(`round ${rounds}: +${result.issuersProcessed} issuers, +${result.filingsFetched} filings, +${result.rowsInserted} rows, cursor=${result.lastCursor}, stopped=${result.stoppedReason}`);
    if (result.stoppedReason === "EXHAUSTED") { console.log("EXHAUSTED — full universe covered this pass."); break; }
    cursor = result.lastCursor;
  }
  console.log(`TOTAL: issuers=${totalIssuers} filings=${totalFilings} rows=${totalRows} rounds=${rounds} elapsedMs=${Date.now() - started}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
