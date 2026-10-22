import { PrismaClient } from "@prisma/client";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeAssetRuntimeStatus } from "../runtime-status/write-asset-runtime-status.ts";

type QueueItem = {
  gapId: string; priority: string; status: string; delegate: string; startWorker: boolean;
  attempts?: number; checkpoint?: string | null; started_at?: string | null; updated_at?: string | null;
  completed_at?: string | null; last_error?: string | null; transitions?: Array<{ state: string; at: string }>;
};
type GapQueue = { status: string; currentGapId: string | null; items: QueueItem[]; [key: string]: unknown };
type HoldingRow = { fundId: string; shareClassId: string | null; asOfDate: Date; securityKey: string; weight: unknown };

const queuePath = resolve("runtime/global-fund/depth-gap-work-queue.json");
const resultPath = resolve("runtime/global-fund/gap-results/holdings-overlap.json");
const eligible = new Set(["HOLDINGS_OVERLAP", "HISTORICAL_PERCENTILE_SEASONALITY", "FUND_EVENT_CALENDAR"]);
const iso = () => new Date().toISOString();

async function readQueue() { return JSON.parse(await readFile(queuePath, "utf8")) as GapQueue; }
async function atomic(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
async function transition(queue: GapQueue, item: QueueItem, state: string, patch: Partial<QueueItem> = {}) {
  const at = iso(); Object.assign(item, patch, { status: state, updated_at: at });
  item.transitions = [...(item.transitions ?? []), { state, at }];
  queue.currentGapId = item.gapId; queue.status = state; await atomic(queuePath, { ...queue, updatedAt: at });
}

async function holdingsOverlap(prisma: PrismaClient) {
  const rows = await prisma.$queryRawUnsafe<HoldingRow[]>(`
    WITH latest AS (
      SELECT fund_id, MAX(as_of_date) AS as_of_date
      FROM holdings
      WHERE asset_type='FUND' AND fund_id IS NOT NULL AND weight IS NOT NULL
      GROUP BY fund_id
      ORDER BY fund_id
      LIMIT 50
    )
    SELECT h.fund_id AS "fundId", h.share_class_id AS "shareClassId", h.as_of_date AS "asOfDate",
      COALESCE(h.security_id::text,h.isin,h.cusip,h.ticker,h.holding_code,h.holding_name) AS "securityKey",
      h.weight::float8 AS weight
    FROM holdings h JOIN latest l ON l.fund_id=h.fund_id AND l.as_of_date=h.as_of_date
    WHERE h.asset_type='FUND' AND h.weight IS NOT NULL
    ORDER BY h.fund_id, "securityKey"
    LIMIT 10000`);
  const funds = new Map<string, { asOfDate: string; positions: Map<string, number> }>();
  for (const row of rows) {
    if (!row.securityKey) continue;
    const current = funds.get(row.fundId) ?? { asOfDate: new Date(row.asOfDate).toISOString().slice(0, 10), positions: new Map<string, number>() };
    current.positions.set(row.securityKey, Number(row.weight)); funds.set(row.fundId, current);
  }
  const ids = [...funds.keys()]; const pairs = [];
  for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
    const left = funds.get(ids[leftIndex])!, right = funds.get(ids[rightIndex])!;
    let overlap = 0, shared = 0;
    for (const [key, leftWeight] of left.positions) { const rightWeight = right.positions.get(key); if (rightWeight === undefined) continue; shared += 1; overlap += Math.min(leftWeight, rightWeight); }
    pairs.push({ leftFundId: ids[leftIndex], rightFundId: ids[rightIndex], leftAsOfDate: left.asOfDate, rightAsOfDate: right.asOfDate, sharedPositions: shared, overlapWeightPercent: Number(overlap.toFixed(6)) });
  }
  if (ids.length < 2 || pairs.length < 1) throw new Error("WAITING_DEPENDENCY:AT_LEAST_TWO_CURRENT_HOLDINGS_PORTFOLIOS_REQUIRED");
  return { gapId: "HOLDINGS_OVERLAP", calculatedAt: iso(), methodology: "SUM_MIN_SOURCE_REPORTED_WEIGHT_BY_CANONICAL_SECURITY_KEY", fundCount: ids.length, pairCount: pairs.length, sourceRows: rows.length, pairs };
}

export async function consumeNextFundGap() {
  const queue = await readQueue();
  const item = queue.items.find((candidate) => eligible.has(candidate.gapId) && ["PENDING", "QUEUED", "RETRY_WAIT"].includes(candidate.status));
  if (!item) return { status: "IDLE", gapId: null, attempts: 0, checkpoint: null };
  const started = iso();
  await transition(queue, item, "RUNNING", { attempts: Number(item.attempts ?? 0) + 1, started_at: item.started_at ?? started, completed_at: null, last_error: null });
  const prisma = new PrismaClient();
  try {
    if (item.gapId !== "HOLDINGS_OVERLAP") {
      await transition(queue, item, "WAITING_DEPENDENCY", { last_error: "EXISTING_LIFECYCLE_DELEGATE_NOT_YET_BOUND" });
      return { status: item.status, gapId: item.gapId, attempts: item.attempts, checkpoint: item.checkpoint ?? null };
    }
    const result = await holdingsOverlap(prisma); await atomic(resultPath, result);
    await transition(queue, item, "CHECKPOINT", { checkpoint: "runtime/global-fund/gap-results/holdings-overlap.json" });
    await transition(queue, item, "COMPLETE", { completed_at: iso(), last_error: null });
    const nextGapId = queue.items.find((candidate) => ["PENDING", "QUEUED", "RETRY_WAIT"].includes(candidate.status))?.gapId ?? null;
    queue.currentGapId = item.gapId; queue.nextGapId = nextGapId;
    queue.status = nextGapId ? "QUEUED" : "COMPLETE"; await atomic(queuePath, { ...queue, updatedAt: iso() });
    await writeAssetRuntimeStatus("FUND", {
      DEPTH_AUDIT_STATUS: "COMPLETE", CURRENT_GAP_ID: queue.currentGapId, GAP_QUEUE_STATUS: queue.status,
      GAP_CONSUMER_STATUS: "CHECKPOINT_COMPLETE", GAPS_COMPLETED: queue.items.filter((candidate) => candidate.status === "COMPLETE").length,
      LAST_PROGRESS_AT: iso(), LAST_PROGRESS: `HOLDINGS_OVERLAP completed: ${result.fundCount} funds, ${result.pairCount} pairs, ${result.sourceRows} current holdings rows`,
      CHECKPOINT: "runtime/global-fund/gap-results/holdings-overlap.json", CONTINUING: "YES",
    });
    return { status: item.status, gapId: item.gapId, attempts: item.attempts, checkpoint: item.checkpoint };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = message.startsWith("WAITING_DEPENDENCY:") ? "WAITING_DEPENDENCY" : "RETRY_WAIT";
    await transition(queue, item, state, { last_error: message });
    await writeAssetRuntimeStatus("FUND", { CURRENT_GAP_ID: item.gapId, GAP_QUEUE_STATUS: state, GAP_CONSUMER_STATUS: state, BLOCKER: message, CONTINUING: "YES" });
    return { status: state, gapId: item.gapId, attempts: item.attempts, checkpoint: item.checkpoint ?? null, error: message };
  } finally { await prisma.$disconnect(); }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("consume-fund-depth-gap.ts")) {
  consumeNextFundGap().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error); process.exitCode = 1; });
}
