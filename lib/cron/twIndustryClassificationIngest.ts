// 2026-11-11（使用者核准，官方產業分類定案）: securities.sector 補進 TWSE/TPEx 官方產業別。
// 見 scripts/data/classification/run-tw-industry-classification.ts 開頭的來源/授權說明——同一套
// 邏輯抽成共用函式，供雲端排程route跟本地一次性script共用（不是兩套實作）。
import { prisma } from "@/lib/prisma";

const TWSE_URL = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L";
const TPEX_URL = "https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O";

type Row = { 公司代號: string; 公司名稱: string; 產業別: string };

async function fetchRows(url: string): Promise<Row[]> {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 401 || res.status === 403 || res.status === 429) throw new Error(`BLOCKED_${res.status}`);
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return res.json();
}

export type TwIndustryResult = { fetched: number; updated: number; skippedNoMatch: number; skippedAlready: number; errors: number };

export async function runTwIndustryClassificationSync(): Promise<TwIndustryResult> {
  const [twse, tpex] = await Promise.all([fetchRows(TWSE_URL), fetchRows(TPEX_URL)]);
  const byTickerExchange = new Map<string, { ticker: string; exchange: "TWSE" | "TPEx"; sector: string }>();
  for (const r of twse) {
    if (!r.公司代號 || !r.產業別) continue;
    byTickerExchange.set(`TWSE:${r.公司代號}`, { ticker: r.公司代號, exchange: "TWSE", sector: r.產業別 });
  }
  for (const r of tpex) {
    if (!r.公司代號 || !r.產業別) continue;
    byTickerExchange.set(`TPEx:${r.公司代號}`, { ticker: r.公司代號, exchange: "TPEx", sector: r.產業別 });
  }
  const result: TwIndustryResult = { fetched: byTickerExchange.size, updated: 0, skippedNoMatch: 0, skippedAlready: 0, errors: 0 };
  for (const entry of byTickerExchange.values()) {
    try {
      const before = await prisma.$queryRawUnsafe<Array<{ id: string; sector: string | null }>>(
        `SELECT id, sector FROM securities WHERE country='TW' AND exchange=$1 AND ticker=$2 LIMIT 1`,
        entry.exchange, entry.ticker,
      );
      const row = before[0];
      if (!row) { result.skippedNoMatch++; continue; }
      if (row.sector === entry.sector) { result.skippedAlready++; continue; }
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`UPDATE securities SET sector=$1, updated_at=now() WHERE id=$2`, entry.sector, row.id);
        const verify = await tx.$queryRawUnsafe<Array<{ sector: string | null }>>(`SELECT sector FROM securities WHERE id=$1`, row.id);
        if (verify[0]?.sector !== entry.sector) throw new Error(`verify mismatch for ${row.id}`);
      });
      const after = await prisma.$queryRawUnsafe<Array<{ sector: string | null }>>(`SELECT sector FROM securities WHERE id=$1`, row.id);
      if (after[0]?.sector !== entry.sector) throw new Error(`post-commit mismatch for ${row.id}`);
      result.updated++;
    } catch (e) {
      result.errors++;
      console.error(`[tw-industry] error for ${entry.exchange}:${entry.ticker}`, e instanceof Error ? e.message : e);
    }
  }
  return result;
}
