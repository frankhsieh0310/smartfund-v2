// 2026-10-23（使用者核准）: 範圍外資料（台灣買不到、不屬於四類核心母體）的清理排程。
//
// 2026-10-31（使用者核准，根因修正——誤刪真實ETF事故）: 原本的定義是「不是APPROVED就刪」，
// 把「還沒分類」（classify排程還沒跑到）跟「明確被排除」當成同一件事。VERIFIED事故：
// 009831/009832這兩檔2026-10-29才上市的ETF，自動建檔成功後還沒等到classify排程核准，
// 就被下一次out-of-scope-purge（每10分鐘一輪）當成「範圍外」砍掉；00793B/00847B這兩檔低流動性
// 公司債ETF，則是被「核准要求當天有收盤行情」這個過嚴的classify條件卡住（連續無成交量不代表
// 下市），同樣被這裡刪除。改成兩個條件都收緊：(1) 只刪tw_purchasable_classification裡明確是
// NOT_APPROVED或EXCLUDED_RETAIL_RESTRICTED的紀錄——沒有分類紀錄（代表還沒分類完、狀態未知）一律
// 不刪，這是跟classify.ts自己的設計原則一致（它本來就刻意「不比對到就不寫NOT_APPROVED」，見
// classify.ts開頭註解）；(2) 新建檔未滿14天的一律不刪，留時間給classify排程追上。
// classify.ts那邊「核准要求當天有收盤行情」的條件也一併拿掉，改成只要在證交所/櫃買中心官方
// t187ap47清單上就視為掛牌中（見該檔案的對應修正）。
//
// 2026-10-31（使用者核准，第二次修正——120秒逾時根因）: 上面那次修正把過濾條件從「NOT IN」改成
// 「EXISTS相關子查詢」，單獨對etf_history測試很快（有etf_id_date索引可用），但對fund_history
// VERIFIED一樣的pattern會逼postgres對fund_history（500萬+列、就算有(fund_id,date)索引）選擇
// Seq Scan——因為每個task tick（hasRemaining/batch delete）都要重新對「子查詢」evaluate一次，
// 子查詢本身雖然快（<10ms），但postgres規劃器看到「correlated subquery/EXISTS」驅動的semi-join
// 命中率預估沒有把握用索引、選擇對整張大表全表掃描，掃到120秒statement timeout被砍掉，
// 連LIMIT 1的hasRemaining()都救不回來（找不到符合的列時，LIMIT 1必須掃完全表才能確認真的是0筆）。
// 修法：範圍外的etf/fund id改成每次invocation「只算一次」（下面的loadOutOfScopeIds()，單獨測過
// <10ms），結果是一個小陣列，之後每個task的filterSql一律改成`xxx_id = ANY($1::text[])`這種
// 「對照具體陣列」的寫法，不再是「對照子查詢」——postgres對「欄位 = ANY(陣列參數)」搭配既有的
// (fund_id,date)/(etf_id,date)索引，可以穩定選到Bitmap Index Scan，不會再選seq scan。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { isOutOfScopePurgeWriteEnabled } from "@/lib/cron/outOfScopePurgeGate";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "OUT_OF_SCOPE_PURGE";
const TIME_BUDGET_MS = 280_000;

const ETF_OOS_SELECT = `SELECT e.id FROM etfs e WHERE EXISTS (SELECT 1 FROM tw_purchasable_classification c WHERE c.asset_type='ETF' AND c.asset_id=e.id AND c.status IN ('NOT_APPROVED','EXCLUDED_RETAIL_RESTRICTED')) AND e.created_at <= now() - interval '14 days' AND NOT (e.is_active=true AND e.exchange IN ('NYSE','NYSEArca','NYSE American','NasdaqGM','Nasdaq GIDS','Cboe US'))`;
const FUND_OOS_SELECT = `SELECT f.id FROM funds f WHERE EXISTS (SELECT 1 FROM tw_purchasable_classification c WHERE c.asset_type='FUND' AND c.asset_id=f.id AND c.status IN ('NOT_APPROVED','EXCLUDED_RETAIL_RESTRICTED')) AND f.created_at <= now() - interval '14 days'`;

async function loadOutOfScopeIds(): Promise<{ etfIds: string[]; fundIds: string[] }> {
  const [etfRows, fundRows] = await Promise.all([
    prisma.$queryRawUnsafe<{ id: string }[]>(ETF_OOS_SELECT),
    prisma.$queryRawUnsafe<{ id: string }[]>(FUND_OOS_SELECT),
  ]);
  return { etfIds: etfRows.map((r) => r.id), fundIds: fundRows.map((r) => r.id) };
}

type PurgeTask = { id: string; table: string; column: "etf_id" | "fund_id" | "id"; idsKey: "etf" | "fund"; batchSize: number };

// 子表先刪、父表（etfs/funds）最後刪，避免最後刪父表時觸發一次巨大的CASCADE交易。順序：
// ETF面 -> 基金面；每一面內先刪最大、最重的history表，再刪其他子表，再刪holdings，最後刪本體。
const TASKS: PurgeTask[] = [
  // --- ETF面 ---
  { id: "etf_history", table: "etf_history", column: "etf_id", idsKey: "etf", batchSize: 50_000 },
  { id: "etf_performances", table: "etf_performances", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_distribution_events", table: "etf_distribution_events", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_sector_allocations", table: "etf_sector_allocations", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_credit_rating_allocations", table: "etf_credit_rating_allocations", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_upcoming_exrights", table: "etf_upcoming_exrights", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_asset_metrics", table: "etf_asset_metrics", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "bond_etf_research_snapshot", table: "bond_etf_research_snapshot", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "bond_etf_technical_analytics", table: "bond_etf_technical_analytics", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_creation_redemptions", table: "etf_creation_redemptions", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_flow_aggregates", table: "etf_flow_aggregates", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_flow_coverage", table: "etf_flow_coverage", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_flows", table: "etf_flows", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_holding_snapshots", table: "etf_holding_snapshots", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_issuer_mappings", table: "etf_issuer_mappings", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_shares_outstanding", table: "etf_shares_outstanding", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_yahoo_observations", table: "etf_yahoo_observations", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etf_yahoo_terminal_status", table: "etf_yahoo_terminal_status", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  // holdings是範圍外ETF的持股明細——直接刪除這部分，不留fund_id/etf_id為NULL的孤兒列。
  { id: "holdings_etf_side", table: "holdings", column: "etf_id", idsKey: "etf", batchSize: 5_000 },
  { id: "etfs", table: "etfs", column: "id", idsKey: "etf", batchSize: 500 },

  // --- 基金面 ---
  // fund_history沒有另外封存（可從Yahoo重新取得的公開資料），直接刪除。
  { id: "fund_history", table: "fund_history", column: "fund_id", idsKey: "fund", batchSize: 50_000 },
  { id: "fund_annual_returns", table: "fund_annual_returns", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_manager_assignments", table: "fund_manager_assignments", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_distribution_observations", table: "fund_distribution_observations", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_profile_provenance", table: "fund_profile_provenance", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_classifications", table: "fund_classifications", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_documents", table: "fund_documents", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_flows", table: "fund_flows", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_holding_changes", table: "fund_holding_changes", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_holding_snapshot_metrics", table: "fund_holding_snapshot_metrics", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_holdings", table: "fund_holdings", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_holdings_name_only", table: "fund_holdings_name_only", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_mappings", table: "fund_mappings", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_performances", table: "fund_performances", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_provider_mappings", table: "fund_provider_mappings", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_risk_metrics", table: "fund_risk_metrics", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_security_ownership", table: "fund_security_ownership", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_share_classes", table: "fund_share_classes", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "fund_source_allocation_observations", table: "fund_source_allocation_observations", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "holdings_fund_side", table: "holdings", column: "fund_id", idsKey: "fund", batchSize: 5_000 },
  { id: "funds", table: "funds", column: "id", idsKey: "fund", batchSize: 500 },
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

function idsFor(task: PurgeTask, ids: { etfIds: string[]; fundIds: string[] }): string[] {
  return task.idsKey === "etf" ? ids.etfIds : ids.fundIds;
}

// 2026-10-31（120秒逾時根因修正，第二部分）: VERIFIED `xxx_id = ANY($1::text[])` 對fund_history
// 這種大表，陣列超過幾百個id時postgres planner會放棄既有的(fund_id,date)索引、改選Seq Scan（估計
// 選擇率太高，划不來用index），scan整張5百萬+列的表直接撞statement timeout。VERIFIED陣列縮小到
// 50個id左右，planner穩定選回Index Scan（34ms）。所以id陣列一律先切成小塊（CHUNK_SIZE），
// 每塊各自查/刪，不要一次丟全部id進同一個查詢。
const ID_CHUNK_SIZE = 100;
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 2026-10-23: COUNT(*)對etf_history/fund_history這種大表（VERIFIED一次plain COUNT(*)會撞到
// session層級2分鐘statement_timeout）太貴，而且task selection根本不需要知道「確切剩多少筆」，
// 只需要知道「還有沒有」——改用EXISTS，便宜很多。精確筆數只在dry-run報告（下面另外處理、自己
// 延長statement_timeout）才會真的去數。
async function hasRemaining(task: PurgeTask, taskIds: string[]): Promise<boolean> {
  for (const idChunk of chunk(taskIds, ID_CHUNK_SIZE)) {
    const rows = await prisma.$queryRawUnsafe<Array<{ found: number }>>(
      `SELECT 1 AS found FROM ${task.table} WHERE ${task.column} = ANY($1::text[]) LIMIT 1`,
      idChunk,
    );
    if (rows.length > 0) return true;
  }
  return false;
}

async function countRemainingSlow(task: PurgeTask, taskIds: string[]): Promise<number> {
  if (taskIds.length === 0) return 0;
  // 僅供dry-run使用——自己的連線延長statement_timeout（在一個交易內SET LOCAL，交易結束自動
  // 還原，不影響其他呼叫），因為這是人工觸發的查詢，可以接受比較久。一樣切小塊查詢、加總。
  let total = 0;
  for (const idChunk of chunk(taskIds, ID_CHUNK_SIZE)) {
    total += await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '60s'`);
      const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM ${task.table} WHERE ${task.column} = ANY($1::text[])`,
        idChunk,
      );
      return rows[0]?.n ?? 0;
    }, { timeout: 70_000 });
  }
  return total;
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const now = new Date();
  const writeEnabled = isOutOfScopePurgeWriteEnabled();
  const url = new URL(request.url);
  const forceDryRun = url.searchParams.get("dryRun") === "1" || !writeEnabled;

  const outOfScopeIds = await loadOutOfScopeIds();

  // dry-run：回報每個任務目前還剩多少筆，不實際刪除、不管時間窗口。用countRemainingSlow（延長
  // statement_timeout），因為這是人工觸發、偶爾才跑一次，可以接受比較久；平常task selection走的
  // hasRemaining則是便宜的EXISTS，兩者分開避免互相拖累。
  if (forceDryRun) {
    const counts: Record<string, number> = {};
    for (const task of TASKS) counts[task.id] = await countRemainingSlow(task, idsFor(task, outOfScopeIds));
    const totalRemaining = Object.values(counts).reduce((a, b) => a + b, 0);
    return Response.json({
      ok: true, job: JOB, mode: "DRY_RUN", writeEnabled, totalRemaining, counts,
      outOfScopeCount: { etf: outOfScopeIds.etfIds.length, fund: outOfScopeIds.fundIds.length },
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
    let activeTaskIds: string[] = [];
    for (const task of TASKS) {
      const taskIds = idsFor(task, outOfScopeIds);
      if (await hasRemaining(task, taskIds)) { activeTask = task; activeTaskIds = taskIds; break; }
    }

    if (!activeTask) {
      await finishRun(runId, JOB, "INTERNAL_PURGE", startedMs, {
        status: "COMPLETED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0,
        checkpointAfter: null, details: { allTasksComplete: true, outOfScopeCount: { etf: outOfScopeIds.etfIds.length, fund: outOfScopeIds.fundIds.length } },
      });
      return Response.json({ ok: true, job: JOB, status: "COMPLETED", allTasksComplete: true });
    }

    let deletedThisRun = 0;
    outer: for (const idChunk of chunk(activeTaskIds, ID_CHUNK_SIZE)) {
      while (Date.now() - startedMs < TIME_BUDGET_MS) {
        // VERIFIED根因(2026-10-28, OUT_OF_SCOPE_PURGE每輪都42703失敗卡住)：原本用id IN(...)分批，
        // 但bond_etf_research_snapshot/bond_etf_technical_analytics/etf_flow_coverage/
        // etf_issuer_mappings/etf_yahoo_observations/etf_yahoo_terminal_status這6張表的主鍵是
        // etf_id(或etf_id+其他欄位)複合鍵，根本沒有id欄位，DELETE WHERE id IN(...)直接噴
        // column "id" does not exist；而且因為TASKS是依序處理、卡在同一個task不會往下一個table
        // 跳，這6張表只要排到就會讓整支排程從那之後完全卡住。改用ctid（每張Postgres表都有的
        // 實體列位置），不需要知道每張表實際的主鍵欄位名稱，批次刪除邏輯不變。
        // 2026-10-31：id陣列一律先用上面的chunk()切成ID_CHUNK_SIZE小塊再查，見hasRemaining同一個
        // 註解——陣列太大時planner會放棄索引、整表掃描撞120秒逾時。
        const result = await prisma.$executeRawUnsafe(
          `WITH victims AS (SELECT ctid FROM ${activeTask.table} WHERE ${activeTask.column} = ANY($1::text[]) LIMIT ${activeTask.batchSize})
           DELETE FROM ${activeTask.table} WHERE ctid IN (SELECT ctid FROM victims)`,
          idChunk,
        );
        const deletedCount = typeof result === "number" ? result : Number(result);
        deletedThisRun += deletedCount;
        if (deletedCount === 0) break; // this chunk genuinely empty now, move to next chunk
        if (deletedCount < activeTask.batchSize) break; // last partial batch for this chunk
      }
      if (Date.now() - startedMs >= TIME_BUDGET_MS) break outer;
    }

    const stillHasMore = await hasRemaining(activeTask, activeTaskIds);
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
