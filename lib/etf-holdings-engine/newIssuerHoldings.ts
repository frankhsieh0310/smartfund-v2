// 2026-11-05（使用者核准，22檔被動式ETF補holdings來源第一批）：4家新issuer（UOBAM/FTFT/ESUNAM/
// USITC，共17檔ticker）跑在既有etf-official-holdings這支cron底下，不新增cron trigger——不論哪個
// issuer的排程觸發這支route，結束後剩下的時間預算都會順便檢查一次「今天新issuer這批有沒有跑過」
// （DONE:<today>哨兵，跟cloud-fund-holdings的MoneyDJ節流同一套模式），還沒跑過才真正發送請求。
// 一次一個請求、至少間隔3秒、20秒逾時；遇到401/403/429立即停止該issuer（不影響其他issuer），
// 記錄為EXTERNAL，不重試、不繞過、不換來源。寫入受NEW_ISSUER_HOLDINGS_WRITE開關控制（route.ts
// 已經處理），這裡只負責抓取+驗證+（開關開啟時）呼叫同一套持久化邏輯。
import { prisma } from "@/lib/prisma";
import { readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { upsertSnapshot, type QueryFn } from "./storage";
import { syncOfficialSnapshotToHoldings } from "./syncToHoldings";
import type { OfficialPcfAdapter } from "./types";
import { UobamOfficialPcfAdapter, FUND_ID_MAP as UOBAM_MAP } from "./adapters/uobam";
import { FtftOfficialPcfAdapter, FUND_ID_MAP as FTFT_MAP } from "./adapters/ftft";
import { EsunamOfficialPcfAdapter, FUND_ID_MAP as ESUNAM_MAP } from "./adapters/esunam";
import { UsitcOfficialPcfAdapter, FUND_ID_MAP as USITC_MAP } from "./adapters/usitc";

const CHECKPOINT_KEY = "etf-official-holdings:new-issuers-daily";
const REQUEST_SPACING_MS = 3_000;
const PER_REQUEST_TIMEOUT_MS = 20_000;

const ISSUERS: Array<{ name: string; adapter: OfficialPcfAdapter; tickers: string[] }> = [
  { name: "UOBAM", adapter: UobamOfficialPcfAdapter, tickers: Object.keys(UOBAM_MAP) },
  { name: "FTFT", adapter: FtftOfficialPcfAdapter, tickers: Object.keys(FTFT_MAP) },
  { name: "ESUNAM", adapter: EsunamOfficialPcfAdapter, tickers: Object.keys(ESUNAM_MAP) },
  { name: "USITC", adapter: UsitcOfficialPcfAdapter, tickers: Object.keys(USITC_MAP) },
];

function todayTaipeiKey(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export type NewIssuerHoldingsResult = {
  ok: boolean;
  skipped: boolean;
  reason?: string;
  perIssuer?: Array<{ issuer: string; attempted: number; succeeded: number; externalBlocked: boolean; errors: string[] }>;
};

export async function runNewIssuerHoldings(writeEnabled: boolean, deadlineMs: number): Promise<NewIssuerHoldingsResult> {
  const today = todayTaipeiKey();
  const before = await readCheckpoint(CHECKPOINT_KEY);
  if (before?.lastSymbol === `DONE:${today}`) {
    return { ok: true, skipped: true, reason: "already attempted today" };
  }

  const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe<any[]>(sql, ...(params as any[]));
  const perIssuer: NewIssuerHoldingsResult["perIssuer"] = [];

  for (const { name, adapter, tickers } of ISSUERS) {
    let attempted = 0, succeeded = 0;
    let externalBlocked = false;
    const errors: string[] = [];
    for (const ticker of tickers) {
      if (Date.now() >= deadlineMs) break;
      attempted++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);
      try {
        const snap = await adapter.fetchSnapshot(ticker, undefined, controller.signal);
        if (!snap.positions.length) throw new Error("empty positions");
        if (writeEnabled) {
          const { snapshotId } = await upsertSnapshot(query, snap);
          try {
            await syncOfficialSnapshotToHoldings(query, ticker, { snapshotId });
          } catch { /* official snapshot already safely stored either way */ }
        }
        succeeded++;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push(`${ticker}: ${message.slice(0, 200)}`);
        // 401/403/429一律立即停止這個issuer剩下的ticker，不重試、不換來源 —— 每個adapter的
        // fetch失敗訊息都包含HTTP狀態碼字串（例如UOBAM_HTTP_429），直接比對狀態碼子字串即可。
        if (/HTTP_401|HTTP_403|HTTP_429/.test(message)) {
          externalBlocked = true;
          clearTimeout(timer);
          break;
        }
      } finally {
        clearTimeout(timer);
      }
      await new Promise((r) => setTimeout(r, REQUEST_SPACING_MS));
    }
    perIssuer.push({ issuer: name, attempted, succeeded, externalBlocked, errors });
  }

  await writeCheckpoint("ETF_OFFICIAL_HOLDINGS:NewIssuers", CHECKPOINT_KEY, "new-issuers-daily-run", {
    lastSymbol: `DONE:${today}`,
    processed: perIssuer.reduce((n, p) => n + p.attempted, 0),
    succeeded: perIssuer.reduce((n, p) => n + p.succeeded, 0),
    failed: perIssuer.reduce((n, p) => n + (p.attempted - p.succeeded), 0),
  });

  return { ok: true, skipped: false, perIssuer };
}
