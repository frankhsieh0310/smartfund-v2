// 2026-11-11（使用者核准，官方產業分類定案）: securities.sector 補進 SEC EDGAR 公司資料裡的官方
// SIC (Standard Industrial Classification) 產業代碼，翻成中文（見 secSicTranslation.ts）。
// 流程：抓SEC的ticker->CIK公開對照表（company_tickers.json，SEC自己維護、公開給programmatic
// client使用，跟既有Form4專案同一個data.sec.gov網域，同一套"遇401/403/429就停下回報"規則），
// 再逐家打submissions.json讀sic/sicDescription——跟secForm4Ingest.ts同一套節流/中止邏輯，獨立
// 檔案避免互相影響。resumable：以ticker字母序游標記錄進度，可分批執行。
import { prisma } from "@/lib/prisma";
import { translateSicDescription } from "@/lib/data-platform/secSicTranslation";

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
      WHERE country='US' AND exchange IN ('NASDAQ','NYSE','AMEX','NYQ','NMS','NCM','NGM')
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
    const zh = translateSicDescription(submission.sic);
    if (!zh) {
      if (!result.skippedUntranslated.includes(submission.sic)) result.skippedUntranslated.push(submission.sic);
      continue;
    }
    if (row.sector === zh) { result.skippedAlready++; continue; }
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE securities SET sector=$1, updated_at=now() WHERE id=$2`, zh, row.id);
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
