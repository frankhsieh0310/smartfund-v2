// Domestic + offshore fund 產業配置/區域配置（sector/region allocation）sync, sourced from Yahoo
// 奇摩's own fund "持股狀況" page (lib/yahoo/fundAllocationPage.ts) — same mapping sources and
// cursor/time-budget/request-pacing contract as FUND_RETURNS_SYNC (app/api/cron/fund-returns-sync),
// which this route mirrors deliberately rather than inventing a second convention.
//
// SHADOW MODE BY DEFAULT: unless FUND_ALLOCATION_SYNC_WRITE is exactly "on", fetches and classifies
// but writes nothing.
//
// Storage: fund_classifications (no schema change). This table's existing rows use
// classification_value to hold a category CODE (e.g. SECTOR -> UTILITIES, a single tag, no
// weight). This route adds two NEW classification_type values (YAHOO_SECTOR_ALLOCATION /
// YAHOO_REGION_ALLOCATION) and repurposes classification_value to hold the weight percentage as
// text instead — distinct types mean existing SECTOR/INVESTMENT_REGION rows and their single-tag
// meaning are untouched.
import { prisma } from "@/lib/prisma";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { loadMapping } from "@/lib/offshore-nav-sync/mapping";
import { loadDomesticYahooMapping } from "@/lib/holdings-alt-source/domesticYahooMapping";
import { fetchYahooFundAllocation, managerFullName } from "@/lib/yahoo/fundAllocationPage";
import { YahooFundRateLimitedError } from "@/lib/yahoo/fundPerformancePage";
import { isFundAllocationSyncWriteEnabled } from "@/lib/cron/fundAllocationWriteGate";

export const runtime = "nodejs";
export const maxDuration = 290;
export const dynamic = "force-dynamic";

const JOB = "FUND_ALLOCATION_SYNC";
const CHECKPOINT_KEY = "fund-allocation-sync:cursor";
const REQUEST_DELAY_MS = 3_200; // same anti-scraping pace as FUND_RETURNS_SYNC, same source
const TIME_BUDGET_MS = 270_000;
const query = (sql: string, params: any[]) => prisma.$queryRawUnsafe<any[]>(sql, ...params);

function isWriteEnabled(): boolean {
  return isFundAllocationSyncWriteEnabled();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const startedMs = Date.now();
  const writeEnabled = isWriteEnabled();

  const [offshoreMapping, domesticMapping] = await Promise.all([loadMapping(query), loadDomesticYahooMapping(query)]);
  // 2026-10-29（根因修正，跟FUND_RETURNS_SYNC同一輪稽核發現的教訓）: 這裡直接用yahooFundId排序/
  // 分頁游標——不用code，因為offshore mapping裡有200多筆entry的code是空字串，用code當游標會讓
  // 游標被JS的falsy判斷重置回最前面、永遠卡住同一批，這輪已經在FUND_RETURNS_SYNC修過一次這個
  // bug，這裡從一開始就用對的鍵，不重蹈覆轍。
  const combined = [...offshoreMapping, ...domesticMapping].sort((a, b) => a.yahooFundId.localeCompare(b.yahooFundId));

  const checkpoint = await readCheckpoint(CHECKPOINT_KEY);
  const afterCode = checkpoint?.lastSymbol ?? null;
  const startIndex = afterCode ? combined.findIndex((m) => m.yahooFundId > afterCode) : 0;
  const batch = startIndex === -1 ? [] : combined.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + 200);

  const today = new Date().toISOString().slice(0, 10);
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "YAHOO_FUND_HOLDINGS_PAGE", runKey: `${JOB}:${today}:${afterCode ?? "start"}`,
    universeCount: combined.length, batchSize: batch.length, checkpointBefore: checkpoint,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey: afterCode });

  let attempted = 0, written = 0, noData = 0, failed = 0;
  let lastCode: string | null = afterCode;
  let rateLimitStop = false;
  let timeBudgetStop = false;

  for (const entry of batch) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) { timeBudgetStop = true; break; }
    attempted++;
    try {
      const allocation = await fetchYahooFundAllocation(entry.yahooFundId);
      if (allocation) {
        if (writeEnabled) {
          // 沒有既有unique constraint可以用ON CONFLICT（fund_classifications本來就不是為這種
          // 「每次整批覆蓋」的資料設計的），改成每次先刪掉這檔基金舊的這兩種分類再整批重寫，
          // 包在一個transaction裡，不會留下新舊混雜或重複列。
          await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(
              `DELETE FROM fund_classifications WHERE fund_id = $1 AND classification_type IN ('YAHOO_SECTOR_ALLOCATION', 'YAHOO_REGION_ALLOCATION')`,
              entry.fundId,
            );
            for (const sector of allocation.sectors) {
              await tx.$executeRawUnsafe(
                `INSERT INTO fund_classifications (id, fund_id, classification_type, classification_code, classification_name, classification_value, source, source_record_id, as_of_date, classification_method, created_at, updated_at)
                 VALUES (gen_random_uuid()::text, $1, 'YAHOO_SECTOR_ALLOCATION', $2, $2, $3, 'YAHOO_FUND_HOLDINGS_PAGE', $4, $5::date, 'YAHOO_PUBLISHED', NOW(), NOW())`,
                entry.fundId, sector.nameInChinese, String(sector.weight), entry.yahooFundId, allocation.sectorsAsOf,
              );
            }
            for (const region of allocation.regions) {
              await tx.$executeRawUnsafe(
                `INSERT INTO fund_classifications (id, fund_id, classification_type, classification_code, classification_name, classification_value, source, source_record_id, as_of_date, classification_method, created_at, updated_at)
                 VALUES (gen_random_uuid()::text, $1, 'YAHOO_REGION_ALLOCATION', $2, $2, $3, 'YAHOO_FUND_HOLDINGS_PAGE', $4, $5::date, 'YAHOO_PUBLISHED', NOW(), NOW())`,
                entry.fundId, region.nameInChinese, String(region.weight), entry.yahooFundId, allocation.regionsAsOf,
              );
            }
            // 2026-10-29（使用者核准，基金經理人缺口）: 同一頁本來就有managers陣列，不另外多打
            // 一次請求。既有fund_managers沒有name的unique constraint，用「名字一致」查詢避免
            // 重複建人；每次先清掉這檔基金舊的assignment再整批重寫（跟上面sector/region同一套
            // delete+rewrite作法），避免卸任經理人一直留著。
            await tx.$executeRawUnsafe(`DELETE FROM fund_manager_assignments WHERE fund_id = $1 AND source = 'YAHOO_FUND_HOLDINGS_PAGE'`, entry.fundId);
            for (const manager of allocation.managers) {
              const name = managerFullName(manager);
              if (!name) continue;
              const existing = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM fund_managers WHERE name = $1 LIMIT 1`, name);
              const managerId = existing[0]?.id ?? (await tx.$queryRawUnsafe<{ id: string }[]>(
                `INSERT INTO fund_managers (id, name, source, source_record_id, verification_status, created_at, updated_at)
                 VALUES (gen_random_uuid()::text, $1, 'YAHOO_FUND_HOLDINGS_PAGE', $2, 'VERIFIED_SUPPLEMENTAL', NOW(), NOW()) RETURNING id`,
                name, `${entry.yahooFundId}:manager:${name}`,
              ))[0].id;
              await tx.$executeRawUnsafe(
                `INSERT INTO fund_manager_assignments (id, manager_id, fund_id, start_date, role, source, source_record_id, verified_at, created_at, updated_at)
                 VALUES (gen_random_uuid()::text, $1, $2, $3::date, $4, 'YAHOO_FUND_HOLDINGS_PAGE', $5, NOW(), NOW(), NOW())`,
                managerId, entry.fundId, manager.startDate, manager.role, `${entry.yahooFundId}:manager:${name}`,
              );
            }
          });
        }
        written++;
      } else {
        noData++;
      }
    } catch (e) {
      if (e instanceof YahooFundRateLimitedError) { rateLimitStop = true; break; }
      failed++;
    }
    lastCode = entry.yahooFundId;
    await sleep(REQUEST_DELAY_MS);
  }

  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, {
    lastSymbol: rateLimitStop || timeBudgetStop || batch.length === 200 ? lastCode : null,
    processed: attempted, succeeded: written, failed: noData + failed,
  });

  const status = rateLimitStop || timeBudgetStop ? "PARTIAL" : writeEnabled && attempted > 0 && written === 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, "YAHOO_FUND_HOLDINGS_PAGE", startedMs, {
    status, attempted, completed: written, inserted: written, updated: 0, failed: noData + failed, retryableFailures: 0,
    checkpointAfter: null,
    details: { writeEnabled, rateLimitStop, timeBudgetStop, lastCode, universeCount: combined.length },
  });

  return Response.json({ ok: true, job: JOB, runId, status, attempted, written, noData, failed, writeEnabled, lastCode, universeCount: combined.length });
}
