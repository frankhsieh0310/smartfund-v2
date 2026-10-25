// 緊急修復（2026-10-24事故）：見CLAUDE.md「資料庫」一節新增的規則。Claude對正式資料庫直接呼叫
// refresh_reverse_products(NULL, NULL)想重建reverse_current_positions，誤判函式語意，實際
// 效果是清空整張表、不寫回資料，導致選股反查的持股反查功能斷線。這支route是修復邏輯，不是
// 隨便一支腳本：
// - 只做「把APPROVED的ETF/基金塞進既有的reverse_refresh_queue，再用專案自己原本就有的drain
//   邏輯（跟scripts/recovery/install-reverse-current-index.ts完全一樣）分批處理」——不直接呼叫
//   refresh_reverse_products(NULL,NULL)。
// - 寫入開關：REVERSE_INDEX_RESTORE_WRITE（只限這一個變數），shadow mode預設關閉。
// - 2026-10-25（使用者核准修正）: Claude手上沒有Production的CRON_SECRET，改成排進
//   vercel.json自動排程（每10分鐘一次），每次分批處理；佇列清空、筆數恢復後用checkpoint記下
//   「已完成」，之後每次執行直接回報SKIPPED，不會無限重複重seed/drain。
// - 2026-10-25（第一次執行完成後發現的bug，使用者核准修正）: 第一次跑完markedDone:true，但
//   總筆數只有40,068（原本估計約113,000），基金只恢復123筆（原本估計約35,242筆）——VERIFIED
//   根因：refresh_reverse_products(etf_keys, fund_keys)的fund_keys參數要吃「裸UUID」（函式
//   內部自己會補"FUND:"前綴去比對product_key，而且要用fund_share_classes.master_fund_id
//   （多個share class會併成同一個product_key），不是每個fund.id各自一把）。原本seed SQL塞的是
//   'FUND:'||f.id（已經帶前綴、也沒有resolve master_fund_id），導致fund_keys跟實際product_key
//   對不起來，幾乎全部沒比對上。已修正seed SQL；ETF這邊的key格式本來就是對的（product_key直接
//   比對，不用額外前綴），但第一次只恢復2,831/6,971個product，原因還沒查清楚，標UNKNOWN，
//   這次重跑順便觀察結果。checkpoint key改版號（v2），讓修好的邏輯重新跑一輪，不用手動重置。
// - 每次執行限時（TIME_BUDGET_MS，比其他cron更保守）。避開01:00-05:30台北時間這件事故意不用
//   vercel.json的cron語法表示——vercel.json的排程時間是UTC，跟台北時間差8小時，用UTC硬湊
//   "01:00-05:30台北"反而容易湊錯；改成route自己內部用Asia/Taipei時區判斷(inForbiddenWindow)，
//   不管Vercel什麼時候觸發，該擋的時段一定擋得住。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { isReverseIndexRestoreWriteEnabled } from "@/lib/cron/reverseIndexRestoreWriteGate";

export const runtime = "nodejs";
export const maxDuration = 90;
export const dynamic = "force-dynamic";

const JOB = "RESTORE_REVERSE_INDEX_INCIDENT_20261024";
const CHECKPOINT_KEY = "restore-reverse-index:incident-20261024-v2";
const TIME_BUDGET_MS = 70_000;

function taipeiHour(): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  return Number(parts.find((p) => p.type === "hour")?.value ?? "12");
}
function inForbiddenWindow(): boolean {
  const h = taipeiHour();
  return h === 1 || h === 2 || h === 3 || h === 4 || (h === 5); // 01:00-05:59 台北時間，涵蓋使用者指定的01:00-05:30
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  if (inForbiddenWindow()) {
    return Response.json({ ok: false, job: JOB, skipped: true, reason: "FORBIDDEN_WINDOW_01_05_TAIPEI" });
  }
  const started = Date.now();
  const writeEnabled = isReverseIndexRestoreWriteEnabled();
  const before = await readCheckpoint(CHECKPOINT_KEY);
  if (before?.lastSymbol === "DONE") {
    return Response.json({ ok: true, job: JOB, skipped: true, reason: "ALREADY_RESTORED" });
  }
  const runKey = `restore-reverse-index:${new Date().toISOString().slice(0, 16)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "INTERNAL_PG_FUNCTION", runKey, universeCount: 0, batchSize: 100, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  try {
    if (!writeEnabled) {
      const pending = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT count(*)::int c FROM reverse_refresh_queue`);
      const positions = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT count(*)::int c FROM reverse_current_positions`);
      await finishRun(runId, JOB, "INTERNAL_PG_FUNCTION", started, { status: "SKIPPED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0, error: null, checkpointAfter: null, details: { writeEnabled: false, pendingQueue: pending[0].c, currentPositions: positions[0].c } });
      return Response.json({ ok: true, job: JOB, writeEnabled: false, pendingQueue: pending[0].c, currentPositions: positions[0].c });
    }

    // 只在佇列完全空的時候才灌入APPROVED清單——避免每次呼叫都重複塞一樣的key造成佇列膨脹；
    // 已經在佇列裡的（上一次呼叫沒處理完留下的）直接繼續drain，不重新灌。
    const existingQueueCount = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT count(*)::int c FROM reverse_refresh_queue`);
    let seeded = 0;
    if (existingQueueCount[0].c === 0) {
      const tx = Date.now();
      const seedResult = await prisma.$executeRawUnsafe(
        `INSERT INTO reverse_refresh_queue (tx, kind, product_key)
         SELECT $1, 'ETF', CASE WHEN e.code ~ '\\.(TW|TWO)$' OR coalesce(e.region,'') IN ('TW','Taiwan','TPEx') OR coalesce(e.exchange,'') IN ('TWSE','TPEx','TPEX','Taiwan')
             THEN 'ETF:TW:'||regexp_replace(e.code,'\\.(TW|TWO)$','')
             ELSE 'ETF:'||coalesce(nullif(e.isin,''),coalesce(e.exchange,'')||':'||e.code) END
           FROM etfs e
          WHERE e.is_active AND e.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='ETF' AND status='APPROVED')
         UNION
         SELECT $1, 'FUND', coalesce(sc.master_fund_id, f.id)
           FROM funds f
           LEFT JOIN fund_share_classes sc ON sc.fund_id = f.id
          WHERE f.is_active AND f.id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='FUND' AND status='APPROVED')`,
        tx,
      );
      seeded = seedResult;
    }

    let drainedBatches = 0, drainedRows = 0;
    while (Date.now() - started < TIME_BUDGET_MS) {
      const rows = await prisma.$queryRawUnsafe<{ tx: string; kind: string; product_key: string }[]>(
        `SELECT tx::text, kind, product_key FROM reverse_refresh_queue ORDER BY tx, kind, product_key LIMIT 100`,
      );
      if (rows.length === 0) break;
      const etfs = [...new Set(rows.filter((r) => r.kind === "ETF").map((r) => r.product_key))];
      const funds = [...new Set(rows.filter((r) => r.kind === "FUND").map((r) => r.product_key))];
      await prisma.$transaction([
        prisma.$executeRawUnsafe(`SELECT refresh_reverse_products($1::text[],$2::text[])`, etfs, funds),
        prisma.$executeRawUnsafe(
          `DELETE FROM reverse_refresh_queue q USING jsonb_to_recordset($1::jsonb) r(tx text,kind text,product_key text)
           WHERE q.tx=r.tx::bigint AND q.kind=r.kind AND q.product_key=r.product_key`,
          JSON.stringify(rows),
        ),
      ]);
      drainedBatches++;
      drainedRows += rows.length;
    }

    const remaining = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT count(*)::int c FROM reverse_refresh_queue`);
    const positions = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT count(*)::int c FROM reverse_current_positions`);
    const fullyRestored = remaining[0].c === 0 && positions[0].c > 0;
    const status = fullyRestored ? "COMPLETED" : "PARTIAL";
    if (fullyRestored) {
      await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: "DONE", processed: positions[0].c, succeeded: positions[0].c, failed: 0 });
    }
    await finishRun(runId, JOB, "INTERNAL_PG_FUNCTION", started, {
      status, attempted: drainedRows, completed: drainedRows, inserted: 0, updated: 0, failed: 0, retryableFailures: remaining[0].c,
      checkpointAfter: null, error: null,
      details: { writeEnabled: true, seeded, drainedBatches, drainedRows, remainingQueue: remaining[0].c, currentPositions: positions[0].c, markedDone: fullyRestored },
    });
    return Response.json({ ok: true, job: JOB, writeEnabled: true, seeded, drainedBatches, drainedRows, remainingQueue: remaining[0].c, currentPositions: positions[0].c, status, markedDone: fullyRestored });
  } catch (e) {
    await finishRun(runId, JOB, "INTERNAL_PG_FUNCTION", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (e as Error).message });
    return Response.json({ ok: false, job: JOB, error: (e as Error).message }, { status: 500 });
  }
}
