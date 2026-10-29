// CLOUD_TW_BANK_RATE_SYNC — TWD risk-free rate proxy for Sharpe ratio: the official "五大銀行"
// (Bank of Taiwan, Land Bank of Taiwan, Taiwan Cooperative Bank, First Bank, Hua Nan Bank — the
// definition used since 97年11月, per the dataset's own documentation) average 1-year fixed
// deposit rate, from the Central Bank of Taiwan's open-data platform.
//
// Official source, no bot-bypass: rate.bot.com.tw's posted-rate page is behind a proof-of-work
// bot challenge and was deliberately NOT used (CLAUDE.md's standing anti-evasion rule). This uses
// cpx.cbc.gov.tw's documented OpenData API instead (set_id=10359, "五大銀行存放款利率歷史月資
// 料"), confirmed working via a plain fetch with a contact-email User-Agent.
//
// VERIFIED 2026-10-29: the other 4 of the 5 current banks (臺灣銀行/合作金庫/第一銀行/華南銀行)
// stop reporting into this specific CBC dataset after 民國114年11月(2025-11); only 土地銀行's own
// rows continue past that. This route always averages whichever of the 5 banks have a row for the
// MOST RECENT month where at least 3 of them report (so one bank's own faster cadence never masks
// the other four having gone stale) and records that actual month plainly — never backdated or
// disguised as "current".
//
// SHADOW MODE BY DEFAULT: unless TW_BANK_RATE_SYNC_WRITE is exactly "on", fetches and parses but
// writes nothing.
import { prisma } from "@/lib/prisma";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { isTwBankRateSyncWriteEnabled } from "@/lib/cron/twBankRateWriteGate";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_TW_BANK_RATE_SYNC";
const PROVIDER = "CBC_OPEN_DATA";
const FIVE_BANKS = ["臺灣銀行", "土地銀行", "合作金庫", "第一銀行", "華南銀行"];
const MIN_BANKS_FOR_MONTH = 3;

type RawRow = { "銀行": string; "年月": string; "定存利率-一年期-機動": string };

function rocYmToIso(rocYm: string): string {
  const rocYear = Number(rocYm.slice(0, 3));
  const month = rocYm.slice(3, 5);
  return `${rocYear + 1911}-${month}-01`;
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const writeEnabled = isTwBankRateSyncWriteEnabled();
  const runKey = `cloud-tw-bank-rate-sync:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: FIVE_BANKS.length, batchSize: FIVE_BANKS.length, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, runKey });

  try {
    const response = await fetch("https://cpx.cbc.gov.tw/api/OpenData/DataSet?set_id=10359&index=0", {
      headers: { "User-Agent": process.env.SEC_USER_AGENT ?? "SmartFund data platform contact@smartfund.app", Accept: "application/json" },
    });
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      await finishRun(runId, JOB, PROVIDER, startedMs, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: `HTTP_${response.status}` });
      return Response.json({ ok: false, job: JOB, error: `HTTP_${response.status}` }, { status: 502 });
    }
    const rows: RawRow[] = await response.json();

    const byMonth = new Map<string, RawRow[]>();
    for (const row of rows) {
      if (!FIVE_BANKS.includes(row["銀行"])) continue;
      const list = byMonth.get(row["年月"]) ?? [];
      list.push(row);
      byMonth.set(row["年月"], list);
    }
    const monthsDesc = [...byMonth.keys()].sort().reverse();
    const targetMonth = monthsDesc.find((m) => byMonth.get(m)!.length >= MIN_BANKS_FOR_MONTH);

    if (!targetMonth) {
      await finishRun(runId, JOB, PROVIDER, startedMs, { status: "SKIPPED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0, checkpointAfter: null, details: { reason: "NO_MONTH_WITH_ENOUGH_BANKS" } });
      return Response.json({ ok: true, job: JOB, status: "SKIPPED", reason: "NO_MONTH_WITH_ENOUGH_BANKS" });
    }

    const monthRows = byMonth.get(targetMonth)!;
    const rates = monthRows.map((r) => Number(r["定存利率-一年期-機動"])).filter(Number.isFinite);
    const avgRate = rates.reduce((sum, v) => sum + v, 0) / rates.length;
    const observationDate = rocYmToIso(targetMonth);

    if (writeEnabled) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO treasury_fiscal_observations
           (id, country, metric_code, metric_name, observation_date, value, unit, currency, frequency, source, source_record_id, source_url, created_at, updated_at, verification_status)
         VALUES (gen_random_uuid()::text, 'TW', 'CBC_5BANK_1Y_DEPOSIT_AVG', '五大銀行新臺幣一年期定存機動利率平均', $1::date, $2, 'PERCENT_PER_ANNUM', 'TWD', 'MONTHLY', 'CENTRAL_BANK_OF_TAIWAN', $3, 'https://cpx.cbc.gov.tw/api/OpenData/DataSet?set_id=10359', NOW(), NOW(), 'VERIFIED_OFFICIAL')
         ON CONFLICT (country, metric_code, observation_date, source) DO UPDATE SET value = EXCLUDED.value, source_record_id = EXCLUDED.source_record_id, updated_at = NOW()`,
        observationDate, avgRate, `CBC_5BANK_1Y_DEPOSIT_AVG:${targetMonth}`,
      );
    }

    await finishRun(runId, JOB, PROVIDER, startedMs, {
      status: "COMPLETED", attempted: monthRows.length, completed: monthRows.length, inserted: writeEnabled ? 1 : 0, updated: 0, failed: 0, retryableFailures: 0,
      checkpointAfter: null, details: { writeEnabled, targetMonth, observationDate, avgRate, bankCount: monthRows.length, banks: monthRows.map((r) => r["銀行"]) },
    });
    return Response.json({ ok: true, job: JOB, writeEnabled, targetMonth, observationDate, avgRate, bankCount: monthRows.length });
  } catch (error) {
    await finishRun(runId, JOB, PROVIDER, startedMs, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: null, error: (error as Error).message });
    return Response.json({ ok: false, job: JOB, error: (error as Error).message }, { status: 500 });
  }
}
