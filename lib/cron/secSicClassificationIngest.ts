// 2026-11-11（使用者核准，官方產業分類定案）: securities.sector 補進 SEC EDGAR 公司資料裡的官方
// SIC (Standard Industrial Classification) 產業代碼，翻成中文（見 secSicTranslation.ts）。
// 流程：抓SEC的ticker->CIK公開對照表（company_tickers.json，SEC自己維護、公開給programmatic
// client使用，跟既有Form4專案同一個data.sec.gov網域，同一套"遇401/403/429就停下回報"規則），
// 再逐家打submissions.json讀sic/sicDescription——跟secForm4Ingest.ts同一套節流/中止邏輯，獨立
// 檔案避免互相影響。resumable：以ticker字母序游標記錄進度，可分批執行。
// 2026-11-12 使用者回報核實+VERIFIED修正：原本WHERE country='US'漏掉一小批（20筆）securities
// 列——這些列的country存的是全名「United States」而不是兩字代碼「US」（同一批剛好是NVDA/AAPL/
// MSFT/AMZN/GOOGL/AVGO/GOOG/META這幾檔最知名的大型股，更早期某次匯入用了不同拼法），導致這支
// 排程從上線以來從未處理過這幾檔——不是cursor進度不夠，是WHERE條件直接把它們排除在外。改成
// country IN ('US','United States')兩種寫法都接受。
// 2026-11-12 使用者回報核實+核准定案：sector改用SIC代碼對照台股官方產業分類（見
// secSicToTwBucket.ts），不再是逐碼直譯的獨立中文說明——讓同一個產業（例如半導體）在台股/美股
// 用同一個中文名稱，穿透分析的產業集中度才不會把同產業拆成兩類。沒有台股等效類別的產業維持
// 既有逐碼翻譯，不勉強塞、不留英文。
import { prisma } from "@/lib/prisma";
import { sicCodeToDisplaySector } from "@/lib/data-platform/secSicToTwBucket";

const SEC_UA = "SmartMatchApp-IndustryClassification research-contact@smartmatch-app.example";
const REQUEST_DELAY_MS = 350;
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url: string): Promise<unknown | null> {
  await sleep(REQUEST_DELAY_MS);
  const res = await fetch(url, { headers: { "User-Agent": SEC_UA, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new Error(`SEC_BLOCKED_${res.status}`);
  if (!res.ok) return null;
  return res.json();
}

type TickerEntry = { cik_str: number; ticker: string; title: string };

export type SicIngestResult = {
  processed: number; updated: number; skippedAlready: number; skippedNoCik: number; skippedNoSic: number; skippedUntranslated: string[];
  errors: number; lastTicker: string | null; done: boolean;
};

export async function runSecSicClassificationBatch(opts: { afterTicker?: string | null; timeBudgetMs: number }): Promise<SicIngestResult> {
  const startedAt = Date.now();
  const result: SicIngestResult = { processed: 0, updated: 0, skippedAlready: 0, skippedNoCik: 0, skippedNoSic: 0, skippedUntranslated: [], errors: 0, lastTicker: null, done: false };

  const tickerMapRaw = await fetchJson(TICKERS_URL) as Record<string, TickerEntry> | null;
  if (!tickerMapRaw) { result.done = true; return result; }
  const tickerToCik = new Map<string, string>();
  for (const entry of Object.values(tickerMapRaw)) {
    tickerToCik.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
  }

  const usTickers = await prisma.$queryRawUnsafe<Array<{ id: string; ticker: string; sector: string | null }>>(
    `SELECT id, ticker, sector FROM securities
      WHERE country IN ('US','United States') AND exchange IN ('NASDAQ','NYSE','AMEX','NYQ','NMS','NCM','NGM')
        AND ticker IS NOT NULL
        ${opts.afterTicker ? "AND ticker > $1" : ""}
      ORDER BY ticker ASC`,
    ...(opts.afterTicker ? [opts.afterTicker] : []),
  );

  for (const row of usTickers) {
    if (Date.now() - startedAt > opts.timeBudgetMs) { result.lastTicker = result.lastTicker; result.done = false; return result; }
    result.processed++;
    result.lastTicker = row.ticker;
    const cik = tickerToCik.get(row.ticker.toUpperCase());
    if (!cik) { result.skippedNoCik++; continue; }
    let submission: { sic?: string; sicDescription?: string } | null;
    try {
      submission = await fetchJson(`https://data.sec.gov/submissions/CIK${cik}.json`) as { sic?: string; sicDescription?: string } | null;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("SEC_BLOCKED_")) throw e;
      result.errors++;
      continue;
    }
    if (!submission || !submission.sic) { result.skippedNoSic++; continue; }
    const zh = sicCodeToDisplaySector(submission.sic);
    if (!zh) {
      if (!result.skippedUntranslated.includes(submission.sic)) result.skippedUntranslated.push(submission.sic);
      continue;
    }
    if (row.sector === zh) { result.skippedAlready++; continue; }
    try {
      await prisma.$transaction(async (tx) => {
        // industry欄位存原始SIC代碼本身（之前沒有存，只存翻譯後的中文）——保留原始代碼方便
        // 之後要調整對照表時可以直接重算，不用重新打一次SEC API。
        await tx.$executeRawUnsafe(`UPDATE securities SET sector=$1, industry=$2, updated_at=now() WHERE id=$3`, zh, submission.sic, row.id);
        const verify = await tx.$queryRawUnsafe<Array<{ sector: string | null }>>(`SELECT sector FROM securities WHERE id=$1`, row.id);
        if (verify[0]?.sector !== zh) throw new Error(`verify mismatch for ${row.id}`);
      });
      const after = await prisma.$queryRawUnsafe<Array<{ sector: string | null }>>(`SELECT sector FROM securities WHERE id=$1`, row.id);
      if (after[0]?.sector !== zh) throw new Error(`post-commit mismatch for ${row.id}`);
      result.updated++;
    } catch (e) {
      result.errors++;
      console.error(`[sec-sic-classification] write error for ${row.ticker}`, e instanceof Error ? e.message : e);
    }
  }
  result.done = true;
  return result;
}
