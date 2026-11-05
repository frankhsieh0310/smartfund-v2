// Cloud fund-holdings worker — bounded, idempotent, resumable via DB checkpoint.
//
// provider=MONEYDJ  -> MoneyDJ fund disclosure (reuses lib/cloud-ingestion/moneydjFundDisclosure.ts;
//                      writes `holdings` asset_type='FUND', source MONEYDJ_PUBLIC_DISCLOSURE).
// provider=NPORT    -> not cloud-compatible yet (see lib/cloud-ingestion/fundHoldings.ts) -> SKIPPED.
// provider=ALL      -> MONEYDJ only for now.
//
// Trigger: GitHub Actions schedule -> GET with `Authorization: Bearer <CRON_SECRET>`.
// One invocation: read the provider ROLLING checkpoint -> next <=BATCH mapped fund codes by fund id
// -> fetch -> incremental 資料月份 compare -> only-newer write -> advance checkpoint -> run log ->
// return. 403/429 => 2s backoff + stop + PARTIAL, never clears existing data. No loop.
//
// MASTER-AWARE (Phase 1): funds linked to a fund_master are fetched only via the master's
// representative_fund_id; other linked share classes are excluded from the universe
// (MASTER_NON_REPRESENTATIVE) and read holdings through holdings_by_master. Unlinked funds (Tier B/C
// and everything not in a candidate group) keep the per-code behaviour. Selection lives in
// lib/cloud-ingestion/fundHoldings.ts; the loop also dedups fallback classes per master per run.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import {
  fetchMoneydjDisclosure,
  MoneydjHttpError,
  persistMoneydjDisclosure,
} from "@/lib/cloud-ingestion/moneydjFundDisclosure";
import {
  moneydjFundUniverseCount,
  nextMoneydjFundTargets,
  targetMonthEndIso,
  NPORT_CLOUD_COMPATIBLE,
  NPORT_DEFERRAL_REASON,
} from "@/lib/cloud-ingestion/fundHoldings";
import {
  beginRun,
  finishRun,
  hourBucketKey,
  readCheckpoint,
  writeCheckpoint,
  type CheckpointRow,
} from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_FUND_HOLDINGS";
// 2026-11-05（使用者核准定案，取代上面「Task X11」那版每小時全速跑的設計）: VERIFIED
// 基金持股一個月才更新一次，舊設計卻是每小時300檔、一天24次（上限7,200次/天），對同一批「這個月
// 還沒公布」的基金天天24次重複檢查，也是MoneyDJ天天固定時段回429的主因之一。改成：
//   1) 這支cron的基礎排程(vercel.json)還是每小時觸發，但這裡用「每天一個run_key」把23次多餘的
//      整點呼叫擋掉（beginRun的skipped機制，跟野村費率同步用的是同一招）——當天只有第一次呼叫會
//      真的開始處理。
//   2) 候選池改成「資料還沒到上個月底」(targetMonthEndIso)，不是滾動25天。
//   3) 每一次成功請求之間一定間隔>=3秒（見下方迴圈），絕不一次送出多個並行請求。
//   4) 收到一次429/403立刻整批停止（沿用原有行為，不变）。
const DEFAULT_BATCH = 300;
const MAX_BATCH = 300;
const MIN_REQUEST_SPACING_MS = 3_000;
const TIME_BUDGET_MS = 240_000;

function resolveProvider(raw: string | null): "MONEYDJ" | "NPORT" | "ALL" {
  const v = (raw ?? "ALL").toUpperCase();
  return v === "NPORT" ? "NPORT" : v === "MONEYDJ" ? "MONEYDJ" : "ALL";
}
const checkpointKey = (p: string) => `cloud-fund-holdings:${p}`;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const url = new URL(request.url);
  const provider = resolveProvider(url.searchParams.get("provider"));
  const batch = Math.min(MAX_BATCH, Math.max(1, Number(url.searchParams.get("batch") ?? DEFAULT_BATCH)));
  const startedMs = Date.now();

  if (provider === "NPORT" || (provider === "ALL" && url.searchParams.get("provider")?.toUpperCase() === "NPORT")) {
    return Response.json({
      ok: true,
      job: JOB,
      provider: "NPORT",
      status: "SKIPPED",
      nportCloudCompatible: NPORT_CLOUD_COMPATIBLE,
      reason: NPORT_DEFERRAL_REASON,
    });
  }

  // ---- MONEYDJ (also the ALL default for now) ----
  const CHECKPOINT_KEY = checkpointKey("MONEYDJ");
  const universeCount = await moneydjFundUniverseCount(prisma);
  const before = await readCheckpoint(CHECKPOINT_KEY);
  // 2026-11-05 使用者更正（上一輪「整支程式一天只跑一次、最多約80檔」改過頭了，追不上月初幾千檔
  // 候選）: 排程還是照原本每小時觸發（hourBucketKey），但「每檔基金一天最多檢查一次」改成靠
  // cursor本身保證，不用新增資料表/欄位：一輪完整掃過候選清單(cursor從頭跑到reachedEnd=true)，
  // 期間每檔基金在這一輪裡最多只會被嘗試一次；reachedEnd之後，不像舊邏輯立刻把cursor清空重新
  // 開始掃，而是把lastSymbol標記成"DONE:<today>"，當天後面的整點呼叫一律直接skip、完全不查
  // DB也不發任何請求，等到隔天日期變了才重新開始新一輪——這樣同一檔基金當天最多只會在「這一輪
  // 掃過去的那一次」被檢查，不會因為清單掃完又立刻重掃而被打第二次。
  const dayKey = new Date().toISOString().slice(0, 10);
  const doneSentinel = `DONE:${dayKey}`;
  if (before?.lastSymbol === doneSentinel) {
    return Response.json({ ok: true, job: JOB, provider: "MONEYDJ", skipped: true, reason: "already completed one full pass today", doneSentinel });
  }
  const runKey = hourBucketKey(`CLOUD_FUND_HOLDINGS:MONEYDJ`);
  const { runId, skipped } = await beginRun({
    jobName: `${JOB}:MONEYDJ`,
    provider: "MONEYDJ",
    runKey,
    universeCount,
    batchSize: batch,
    checkpointBefore: before,
  });
  if (skipped) {
    return Response.json({ ok: true, job: JOB, provider: "MONEYDJ", skipped: true, reason: "run_key already present this hour", runKey });
  }

  const targetMonthEnd = targetMonthEndIso();
  // lastSymbol從上一個DONE:sentinel或是昨天留下的真實cursor都可能帶進來——不是DONE:今天的情況下
  // 一律當成「還在掃同一輪」繼續往下，就算字串是前一天的DONE:sentinel也一樣視為"從頭開始"
  // （cursor比對用indexOf找不到會自然從0開始，行為等同cursor=""）。
  let cursor = before?.lastSymbol && !before.lastSymbol.startsWith("DONE:") ? before.lastSymbol : "";
  let wrapped = false;
  let targets = await nextMoneydjFundTargets(prisma, cursor, batch, targetMonthEnd);
  if (targets.length === 0 && cursor !== "") {
    wrapped = true;
    cursor = "";
    targets = await nextMoneydjFundTargets(prisma, cursor, batch, targetMonthEnd);
  }

  let attempted = 0;
  let initialWrite = 0;
  let updated = 0;
  let noChange = 0;
  let staleSkip = 0;
  let emptyHoldings = 0;
  let parseFailed = 0;
  let failed = 0;
  let retryable = 0;
  let http403 = 0;
  let http429 = 0;
  let holdingsTotal = 0;
  let masterAlreadyFetched = 0;
  let backoffStop = false;
  let timeBudgetStop = false;
  const failures: Array<{ code: string; reason: string }> = [];
  const masterDoneThisRun = new Set<string>();
  let lastId = cursor;
  let lastRequestAt = 0; // 2026-11-05: 每檔基金的請求之間強制間隔 MIN_REQUEST_SPACING_MS，一次只送一個。

  for (const t of targets) {
    if (Date.now() - startedMs > TIME_BUDGET_MS) {
      timeBudgetStop = true;
      break;
    }
    lastId = t.fundId;
    // Master fallback dedup: once a master's holdings landed in this run (via representative or a
    // fallback class), skip any further class of the same master.
    if (t.masterFundId && masterDoneThisRun.has(t.masterFundId)) {
      masterAlreadyFetched++;
      continue;
    }
    if (lastRequestAt > 0) {
      const waitMs = MIN_REQUEST_SPACING_MS - (Date.now() - lastRequestAt);
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    }
    lastRequestAt = Date.now();
    attempted++;
    try {
      const disclosure = await fetchMoneydjDisclosure(t.moneydjCode);
      if (!disclosure.holdings.length) {
        emptyHoldings++;
        continue;
      }
      if (t.dbDate) {
        if (disclosure.date < t.dbDate) {
          staleSkip++;
          continue;
        }
        if (disclosure.date === t.dbDate) {
          noChange++;
          continue;
        }
      }
      const res = await persistMoneydjDisclosure(prisma, {
        fundId: t.fundId,
        shareClassId: null,
        moneydjCode: t.moneydjCode,
        disclosure,
      });
      holdingsTotal += res.rowsPersisted;
      if (t.masterFundId) masterDoneThisRun.add(t.masterFundId);
      if (t.dbDate) updated++;
      else initialWrite++;
    } catch (error) {
      if (error instanceof MoneydjHttpError) {
        if (error.httpStatus === 403) http403++;
        else http429++;
        failed++;
        retryable++;
        failures.push({ code: t.moneydjCode, reason: `HTTP_${error.httpStatus}` });
        await new Promise((r) => setTimeout(r, 2_000));
        backoffStop = true;
        break;
      }
      const message = String(error).slice(0, 300);
      if (/DISCLOSED_HOLDINGS_MISSING|DISCLOSURE_DATE_MISSING/.test(message)) {
        parseFailed++;
      } else if (/READBACK_FAILED|SINGLE_WRITER_LOCKED/.test(message)) {
        retryable++;
        failed++;
      } else {
        failed++;
      }
      failures.push({ code: t.moneydjCode, reason: message });
    }
  }

  const reachedEnd = !backoffStop && !timeBudgetStop && targets.length < batch;
  // 2026-11-05: 完整掃過一輪之後，不立刻清空cursor讓同一天後面的整點呼叫馬上重新掃一輪（那正是
  // 「每檔基金一天被打好幾次」的根因）——改成標記DONE:<today>，今天後面的呼叫會在最上面直接
  // 整個skip、連DB都不查；等明天dayKey變了才會被視為"不是今天的DONE"而重新從頭掃一輪。
  const nextCursor = reachedEnd ? doneSentinel : lastId;
  const after: CheckpointRow = {
    lastSymbol: nextCursor,
    processed: (before?.processed ?? 0) + attempted,
    succeeded: (before?.succeeded ?? 0) + initialWrite + updated,
    failed: (before?.failed ?? 0) + failed,
    updatedAt: new Date().toISOString(),
  };
  await writeCheckpoint(`${JOB}:MONEYDJ`, CHECKPOINT_KEY, runId, {
    lastSymbol: nextCursor,
    processed: after.processed,
    succeeded: after.succeeded,
    failed: after.failed,
  });

  const wrote = initialWrite + updated;
  const status = backoffStop || (failed > 0 && wrote === 0) ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, `${JOB}:MONEYDJ`, "MONEYDJ", startedMs, {
    status,
    attempted,
    completed: attempted - failed,
    inserted: holdingsTotal,
    updated: wrote,
    failed,
    retryableFailures: retryable,
    checkpointAfter: after,
    error: failures.length ? `${failures.length} failures; e.g. ${failures[0]?.reason}` : null,
    details: {
      checkpoint_before: before,
      batch_size: batch,
      wrapped,
      reached_end: reachedEnd,
      backoff_stop: backoffStop,
      time_budget_stop: timeBudgetStop,
      window_size: targets.length,
      initial_write: initialWrite,
      updated,
      no_change: noChange,
      stale_skip: staleSkip,
      parse_failed: parseFailed,
      empty_holdings: emptyHoldings,
      http_403: http403,
      http_429: http429,
      http_5xx: 0,
      master_already_fetched: masterAlreadyFetched,
      master_aware: true,
      sample_failures: failures.slice(0, 5),
    },
  });

  return Response.json({
    ok: true,
    job: JOB,
    provider: "MONEYDJ",
    runId,
    httpStatus: 200,
    checked: attempted,
    initialWrite,
    updated,
    noChange,
    staleSkip,
    emptyHoldings,
    parseFailed,
    failed,
    retryableFailures: retryable,
    masterAlreadyFetched,
    masterAware: true,
    holdingsTotal,
    canonicalMapped: 0,
    unmapped: holdingsTotal,
    mappingPct: 0,
    http403,
    http429,
    backoffStop,
    timeBudgetStop,
    checkpointBefore: before?.lastSymbol ?? null,
    checkpointAfter: nextCursor || "(wrapped to start)",
    wrapped,
    reachedEnd,
    universeCount,
    runtimeMs: Date.now() - startedMs,
    status,
    duplicateShareClassFetchRisk: true,
  });
}
