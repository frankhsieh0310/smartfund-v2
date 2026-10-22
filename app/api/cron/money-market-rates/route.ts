// Cloud cron for the 3 overnight policy-rate series FX_CARRY_CIP_ANALYTICS depends on
// (EFFR/ESTR/SONIA). Ported from the local-only, never-scheduled, never-logged script
// scripts/data/money-market/run-global-money-market.ts (see CLAUDE.md, item 二 2026-10-22):
// that script's own writer had no Windows Scheduled Task, no cloud cron, and never called
// production_scheduler_runs, so EFFR/ESTR/SONIA silently stopped updating on 2026-08-10/11 and
// nothing noticed for 40+ days. This route fetches directly from each series' own official
// administrator (no third-party aggregator, no self-calculated values):
//   - EFFR: Federal Reserve Bank of New York, https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json
//   - ESTR: European Central Bank, https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT?format=csvdata
//   - SONIA: Bank of England, https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp
// SHADOW MODE BY DEFAULT: unless MONEY_MARKET_RATES_WRITE is exactly "on" (lib/cron/
// moneyMarketWriteGate.ts), this route fetches and parses but writes nothing.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey } from "@/lib/cloud-ingestion/runContext";
import { isMoneyMarketWriteEnabled } from "@/lib/cron/moneyMarketWriteGate";
import { createHash } from "node:crypto";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "MONEY_MARKET_RATES";

type SeriesDef = {
  code: "EFFR" | "ESTR" | "SONIA";
  name: string;
  country: string;
  administrator: string;
  sourceUrl: (startDate: string, endDate: string) => string;
  parse: (body: string) => Array<{ date: string; value: number }>;
};

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

const SERIES: SeriesDef[] = [
  {
    code: "EFFR",
    name: "Effective Federal Funds Rate",
    country: "United States",
    administrator: "Federal Reserve Bank of New York",
    sourceUrl: (start, end) => `https://markets.newyorkfed.org/api/rates/unsecured/effr/search.json?startDate=${start}&endDate=${end}&type=rate`,
    parse: (body) => {
      const data = JSON.parse(body);
      const rows = data.refRates || data.rates || data.data || [];
      return rows
        .map((r: any) => ({ date: String(r.effectiveDate || r.effective_date || r.date || "").slice(0, 10), value: Number(r.percentRate ?? r.rate ?? r.value) }))
        .filter((r: any) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.value));
    },
  },
  {
    code: "ESTR",
    name: "Euro Short-Term Rate (€STR)",
    country: "Euro Area",
    administrator: "European Central Bank",
    sourceUrl: () => `https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT?format=csvdata`,
    parse: (body) => {
      const lines = body.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return [];
      const header = lines[0].split(",");
      const dateIdx = header.indexOf("TIME_PERIOD");
      const valueIdx = header.indexOf("OBS_VALUE");
      if (dateIdx < 0 || valueIdx < 0) return [];
      return lines.slice(1).map((line) => {
        const cols = line.split(",");
        return { date: cols[dateIdx], value: Number(cols[valueIdx]) };
      }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.value));
    },
  },
  {
    code: "SONIA",
    name: "Sterling Overnight Index Average",
    country: "United Kingdom",
    administrator: "Bank of England",
    sourceUrl: () => `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=01/Jan/2024&Dateto=now&SeriesCodes=IUDSOIA&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`,
    parse: (body) => {
      const lines = body.replace(/^﻿/, "").split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return [];
      const monthMap: Record<string, string> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
      return lines.slice(1).map((line) => {
        const [rawDate, rawValue] = line.split(",");
        const m = /^(\d{2}) (\w{3}) (\d{4})$/.exec((rawDate || "").trim());
        const date = m ? `${m[3]}-${monthMap[m[2]] ?? "00"}-${m[1]}` : "";
        return { date, value: Number(rawValue) };
      }).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.value));
    },
  },
];

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const writeEnabled = isMoneyMarketWriteEnabled();

  const runKey = hourBucketKey("money-market-rates");
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "OFFICIAL_CENTRAL_BANK_APIS", runKey,
    universeCount: SERIES.length, batchSize: SERIES.length, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey });

  // 2026-10-22（使用者核准）：8/10之後缺的資料用官方來源的歷史區段一次補齊，不是每天只抓最新
  // 一筆——每次執行都用寬一點的視窗（90天）重抓，ON CONFLICT讓已經有的日期單純覆寫同值，不會
  // 重複新增；真正判斷「有沒有寫入新資料」看的是下面insertedTotal，不是fetch到幾筆。
  const endDate = isoToday();
  const startDate = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);

  const results: Array<{ code: string; ok: boolean; fetched: number; written: number; latestDate: string | null; error?: string; httpStatus?: number }> = [];

  for (const series of SERIES) {
    const url = series.sourceUrl(startDate, endDate);
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json,text/csv,text/html", "user-agent": "SmartFund Money Market Rates/1.0" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        // 使用者明確核准：遇到401/403/429就停下來回報，不准繞過（換UA、代理等皆不行）。
        results.push({ code: series.code, ok: false, fetched: 0, written: 0, latestDate: null, error: `BLOCKED_HTTP_${res.status}`, httpStatus: res.status });
        continue;
      }
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      const body = await res.text();
      const records = series.parse(body).sort((a, b) => a.date.localeCompare(b.date));
      if (!records.length) throw new Error("NO_PARSEABLE_OFFICIAL_RECORDS");

      const canonical = await prisma.economicSeries.upsert({
        where: { provider_seriesId: { provider: series.administrator, seriesId: series.code } },
        create: {
          provider: series.administrator, seriesId: series.code, code: series.code, name: series.name,
          country: series.country, category: "MONEY_MARKET_RATE", frequency: "DAILY", importance: "MEDIUM",
          unit: "percent", source: series.administrator, apiUrl: url, lastUpdate: new Date(`${records.at(-1)!.date}T00:00:00Z`),
        },
        update: { lastUpdate: new Date(`${records.at(-1)!.date}T00:00:00Z`), apiUrl: url },
      });

      let written = 0;
      if (writeEnabled) {
        for (const record of records) {
          const date = new Date(`${record.date}T00:00:00Z`);
          const checksum = createHash("sha256").update(`${series.code}|${record.date}|${record.value}|${url}`).digest("hex");
          const existing = await prisma.economicValue.findUnique({ where: { seriesId_date: { seriesId: canonical.id, date } } });
          if (existing && existing.rawChecksum === checksum) continue; // 已經存在且同值，不算新寫入
          await prisma.economicValue.upsert({
            where: { seriesId_date: { seriesId: canonical.id, date } },
            create: { seriesId: canonical.id, date, value: record.value, sourceUrl: url, sourceVersion: "money-market-cloud-v1", rawChecksum: checksum, importedAt: new Date() },
            update: { value: record.value, sourceUrl: url, sourceVersion: "money-market-cloud-v1", rawChecksum: checksum, importedAt: new Date() },
          });
          written++;
        }
      }

      results.push({ code: series.code, ok: true, fetched: records.length, written, latestDate: records.at(-1)!.date });
    } catch (error: any) {
      results.push({ code: series.code, ok: false, fetched: 0, written: 0, latestDate: null, error: String(error?.message ?? error) });
    }
  }

  const totalWritten = results.reduce((s, r) => s + r.written, 0);
  const anyBlocked = results.some((r) => r.error?.startsWith("BLOCKED_HTTP_"));
  const anyFailed = results.some((r) => !r.ok && !r.error?.startsWith("BLOCKED_HTTP_"));
  // 寫入開關關閉（shadow mode）時，不能因為written=0就回報SKIPPED/FAILED——那只是預期行為，不是
  // 「該有新資料卻沒寫」。只有寫入開關已經是"on"、而且fetch本身成功時，written=0才算異常訊號。
  const status = anyBlocked ? "FAILED" : anyFailed ? "PARTIAL" : (!writeEnabled || totalWritten > 0) ? "COMPLETED" : "SKIPPED";

  await finishRun(runId, JOB, "OFFICIAL_CENTRAL_BANK_APIS", startedMs, {
    status, attempted: SERIES.length, completed: results.filter((r) => r.ok).length, inserted: totalWritten, updated: 0,
    failed: results.filter((r) => !r.ok).length, retryableFailures: 0, checkpointAfter: null,
    details: { writeEnabled, results, skippedReason: status === "SKIPPED" ? "NO_NEW_ROWS_WHILE_WRITE_ENABLED" : null },
  });

  return Response.json({ ok: !anyBlocked && !anyFailed, job: JOB, runId, status, writeEnabled, results, runtimeMs: Date.now() - startedMs });
}
