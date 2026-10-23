// 2026-10-23（使用者核准）: 範圍外資料（台灣買不到、不屬於四類核心母體）的清理排程。
//
// 範圍外ETF定義（沿用Thread B匯出時已經驗證過的同一條SUBQ，不重新發明）：既不是
// tw_purchasable_classification的APPROVED，**也不是**目前is_active=true又掛在美股主要交易所的
// ETF——第二個條件是刻意保留的保護傘，涵蓋那87檔還沒做完補檔檢查的美股ETF（不管它們最後classify
// 結果是APPROVED/EXCLUDED_RETAIL_RESTRICTED/沒有任何分類紀錄，只要還在美股交易所掛牌且active，
// 這支route就不會刪它）。
const ETF_OOS_SUBQ = `(SELECT id FROM etfs WHERE id NOT IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='ETF' AND status='APPROVED') AND NOT (is_active=true AND exchange IN ('NYSE','NYSEArca','NYSE American','NasdaqGM','Nasdaq GIDS','Cboe US')))`;
// 範圍外基金：不是tw_purchasable_classification的APPROVED（SITCA國內 / TDCC境外都算在內）。
const FUND_OOS_SUBQ = `(SELECT id FROM funds WHERE id NOT IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='FUND' AND status='APPROVED'))`;

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { isOutOfScopePurgeWriteEnabled } from "@/lib/cron/outOfScopePurgeGate";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "OUT_OF_SCOPE_PURGE";
const TIME_BUDGET_MS = 280_000;

type PurgeTask = { id: string; table: string; filterSql: string; batchSize: number };

// 子表先刪、父表（etfs/funds）最後刪，避免最後刪父表時觸發一次巨大的CASCADE交易。順序：
// ETF面 -> 基金面；每一面內先刪最大、最重的history表，再刪其他子表，再刪holdings，最後刪本體。
const TASKS: PurgeTask[] = [
  // --- ETF面 ---
  { id: "etf_history", table: "etf_history", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 50_000 },
  { id: "etf_performances", table: "etf_performances", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_distribution_events", table: "etf_distribution_events", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_sector_allocations", table: "etf_sector_allocations", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_credit_rating_allocations", table: "etf_credit_rating_allocations", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_upcoming_exrights", table: "etf_upcoming_exrights", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_asset_metrics", table: "etf_asset_metrics", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "bond_etf_research_snapshot", table: "bond_etf_research_snapshot", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "bond_etf_technical_analytics", table: "bond_etf_technical_analytics", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_creation_redemptions", table: "etf_creation_redemptions", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_flow_aggregates", table: "etf_flow_aggregates", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_flow_coverage", table: "etf_flow_coverage", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_flows", table: "etf_flows", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_holding_snapshots", table: "etf_holding_snapshots", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_issuer_mappings", table: "etf_issuer_mappings", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_shares_outstanding", table: "etf_shares_outstanding", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_yahoo_observations", table: "etf_yahoo_observations", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etf_yahoo_terminal_status", table: "etf_yahoo_terminal_status", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  // holdings是範圍外ETF的持股明細——直接刪除這部分，不留fund_id/etf_id為NULL的孤兒列。
  { id: "holdings_etf_side", table: "holdings", filterSql: `etf_id IN ${ETF_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "etfs", table: "etfs", filterSql: `id IN ${ETF_OOS_SUBQ}`, batchSize: 500 },

  // --- 基金面 ---
  // fund_history沒有另外封存（可從Yahoo重新取得的公開資料），直接刪除。
  { id: "fund_history", table: "fund_history", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 50_000 },
  { id: "fund_annual_returns", table: "fund_annual_returns", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_manager_assignments", table: "fund_manager_assignments", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_distribution_observations", table: "fund_distribution_observations", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_profile_provenance", table: "fund_profile_provenance", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_classifications", table: "fund_classifications", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_documents", table: "fund_documents", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_flows", table: "fund_flows", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_holding_changes", table: "fund_holding_changes", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_holding_snapshot_metrics", table: "fund_holding_snapshot_metrics", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_holdings", table: "fund_holdings", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_holdings_name_only", table: "fund_holdings_name_only", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_mappings", table: "fund_mappings", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_performances", table: "fund_performances", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_provider_mappings", table: "fund_provider_mappings", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_risk_metrics", table: "fund_risk_metrics", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_security_ownership", table: "fund_security_ownership", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_share_classes", table: "fund_share_classes", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "fund_source_allocation_observations", table: "fund_source_allocation_observations", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "holdings_fund_side", table: "holdings", filterSql: `fund_id IN ${FUND_OOS_SUBQ}`, batchSize: 5_000 },
  { id: "funds", table: "funds", filterSql: `id IN ${FUND_OOS_SUBQ}`, batchSize: 500 },
];

// 只在台北時間 22:30–00:30 與 06:00–08:00 執行，避開01:00-05:30跟整點附近的台股排程時段。
function withinAllowedWindow(now: Date): boolean {
  const taipeiMinutes = (() => {
    const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    return (utcMinutes + 8 * 60) % (24 * 60); // UTC+8
  })();
  const inWindow = (startH: number, startM: number, endH: number, endM: number) => {
    const start = startH * 60 + startM, end = endH * 60 + endM;
    return start <= end ? taipeiMinutes >= start && taipeiMinutes < end : taipeiMinutes >= start || taipeiMinutes < end;
  };
  return inWindow(22, 30, 23, 59) || inWindow(0, 0, 0, 30) || inWindow(6, 0, 8, 0);
}

async function isDatabaseBusy(): Promise<boolean> {
  // 沒有直接的CPU%可查（Supabase的CPU指標要透過Management API，這支route沒有那個權杖），用
  // pg_stat_activity裡「非idle的連線數」當作負載代理指標——同時有大量非idle連線，代表資料庫正在
  // 忙，這一輪先跳過，不要再疊加清理負擔上去。
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM pg_stat_activity WHERE state <> 'idle' AND pid <> pg_backend_pid()`,
  );
  const activeCount = rows[0]?.n ?? 0;
  const BUSY_THRESHOLD = 15;
  return activeCount > BUSY_THRESHOLD;
}

// 2026-10-23: COUNT(*)對etf_history/fund_history這種大表（VERIFIED一次plain COUNT(*)會撞到
// session層級2分鐘statement_timeout）太貴，而且task selection根本不需要知道「確切剩多少筆」，
// 只需要知道「還有沒有」——改用EXISTS，便宜很多。精確筆數只在dry-run報告（下面另外處理、自己
// 延長statement_timeout）才會真的去數。
async function hasRemaining(task: PurgeTask): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ found: number }>>(
    `SELECT 1 AS found FROM ${task.table} WHERE ${task.filterSql} LIMIT 1`,
  );
  return rows.length > 0;
}

async function countRemainingSlow(task: PurgeTask): Promise<number> {
  // 僅供dry-run使用——自己的連線延長statement_timeout（在一個交易內SET LOCAL，交易結束自動
  // 還原，不影響其他呼叫），因為這是人工觸發的查詢，可以接受比較久。
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '240s'`);
    const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM ${task.table} WHERE ${task.filterSql}`,
    );
    return rows[0]?.n ?? 0;
  }, { timeout: 250_000 });
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const now = new Date();
  const writeEnabled = isOutOfScopePurgeWriteEnabled();
  const url = new URL(request.url);
  const forceDryRun = url.searchParams.get("dryRun") === "1" || !writeEnabled;

  // dry-run：回報每個任務目前還剩多少筆，不實際刪除、不管時間窗口。用countRemainingSlow（延長
  // statement_timeout），因為這是人工觸發、偶爾才跑一次，可以接受比較久；平常task selection走的
  // hasRemaining則是便宜的EXISTS，兩者分開避免互相拖累。
  if (forceDryRun) {
    const counts: Record<string, number> = {};
    for (const task of TASKS) counts[task.id] = await countRemainingSlow(task);
    const totalRemaining = Object.values(counts).reduce((a, b) => a + b, 0);
    return Response.json({
      ok: true, job: JOB, mode: "DRY_RUN", writeEnabled, totalRemaining, counts,
      note: writeEnabled ? "called with ?dryRun=1" : "OUT_OF_SCOPE_PURGE_WRITE is not 'on' -- no deletion will ever happen until it is",
    });
  }

  if (!withinAllowedWindow(now)) {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "OUTSIDE_ALLOWED_WINDOW (台北22:30-00:30 / 06:00-08:00)" });
  }

  const runKey = `out-of-scope-purge:${now.toISOString()}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "INTERNAL_PURGE", runKey, universeCount: 0, batchSize: 0, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present and running" });

  try {
    if (await isDatabaseBusy()) {
      await finishRun(runId, JOB, "INTERNAL_PURGE", startedMs, {
        status: "SKIPPED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
        checkpointAfter: null, details: { reason: "DATABASE_BUSY" },
      });
      return Response.json({ ok: true, job: JOB, skipped: true, reason: "DATABASE_BUSY" });
    }

    // 挑第一個「還有剩餘資料」的task，在時間預算內一直刪到這個task清空或預算用完為止——不會在
    // 同一次invocation裡跳到下一個table，確保進度紀錄跟每個table的刪除量一一對應、容易追蹤。
    let activeTask: PurgeTask | null = null;
    for (const task of TASKS) {
      if (await hasRemaining(task)) { activeTask = task; break; }
    }

    if (!activeTask) {
      await finishRun(runId, JOB, "INTERNAL_PURGE", startedMs, {
        status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
        checkpointAfter: null, details: { allTasksComplete: true },
      });
      return Response.json({ ok: true, job: JOB, status: "COMPLETED", allTasksComplete: true });
    }

    let deletedThisRun = 0;
    while (Date.now() - startedMs < TIME_BUDGET_MS) {
      const result = await prisma.$executeRawUnsafe(
        `WITH victims AS (SELECT id FROM ${activeTask.table} WHERE ${activeTask.filterSql} LIMIT ${activeTask.batchSize})
         DELETE FROM ${activeTask.table} WHERE id IN (SELECT id FROM victims)`,
      );
      const deletedCount = typeof result === "number" ? result : Number(result);
      deletedThisRun += deletedCount;
      if (deletedCount === 0) break; // task genuinely empty now
      if (deletedCount < activeTask.batchSize) break; // last partial batch, task will be empty next tick
    }

    const stillHasMore = await hasRemaining(activeTask);
    await finishRun(runId, JOB, "INTERNAL_PURGE", startedMs, {
      status: "COMPLETED", attempted: deletedThisRun, completed: deletedThisRun, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
      checkpointAfter: null,
      details: { task: activeTask.id, table: activeTask.table, deletedThisRun, stillHasMore },
    });
    return Response.json({ ok: true, job: JOB, task: activeTask.id, deletedThisRun, stillHasMore });
  } catch (e: any) {
    const errorMessage = String(e?.message ?? e);
    await finishRun(runId, JOB, "INTERNAL_PURGE", startedMs, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 0,
      error: errorMessage, checkpointAfter: null, details: {},
    });
    return Response.json({ ok: false, job: JOB, error: errorMessage }, { status: 502 });
  }
}
