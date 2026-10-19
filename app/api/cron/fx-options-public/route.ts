// FX options public volatility — fetches CBOE's official 30-day implied-volatility index CSVs
// (EVZ/JYVIX/BPVIX, plain public CDN, no auth, no browser) and writes FX_OPTION_IMPLIED_VOL_INDEX_30D
// rows into fx_metrics. Same source + parsing + upsert as
// scripts/data/fx-options/run-public-fx-options-volatility.ts; ported to run on Vercel cron instead of a
// Windows Scheduled Task (see CLAUDE.md "正式資料排程一律在雲端執行") — logic unchanged, only the local
// health/checkpoint JSON files are replaced by production_scheduler_runs.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "GLOBAL_FX_ORCHESTRATOR";
const PROVIDER = "CBOE_OFFICIAL";

const SOURCES = [
  { pair: "EURUSD", symbol: "EVZ", url: "https://cdn.cboe.com/api/global/us_indices/daily_prices/EVZ_History.csv" },
  { pair: "USDJPY", symbol: "JYVIX", url: "https://cdn.cboe.com/api/global/us_indices/daily_prices/JYVIX_History.csv" },
  { pair: "GBPUSD", symbol: "BPVIX", url: "https://cdn.cboe.com/api/global/us_indices/daily_prices/BPVIX_History.csv" },
] as const;
const REQUESTED = ["EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "USDCNH", "USDKRW", "USDTWD"];

function parseCsv(text: string): { date: string; value: number }[] {
  const lines = text.trim().split(/\r?\n/).slice(1);
  return lines.flatMap((line) => {
    const [rawDate, rawValue] = line.split(",");
    const value = Number(rawValue);
    if (!rawDate || !Number.isFinite(value) || value <= 0) return [];
    const [month, day, year] = rawDate.split("/");
    return [{ date: `${year}-${month}-${day}`, value }];
  });
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const runKey = hourBucketKey("fx-options-public");
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: SOURCES.length, batchSize: SOURCES.length, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey });

  const completed: Record<string, { symbol: string; rows: number; earliest?: string; latest?: string; status: string }> = {};
  let failedSources = 0;
  try {
    const before = (await prisma.$queryRawUnsafe<{ rows: number }[]>(
      `SELECT COUNT(*)::int rows FROM fx_metrics WHERE metric='FX_OPTION_IMPLIED_VOL_INDEX_30D' AND source='CBOE_OFFICIAL'`,
    ))[0].rows;

    for (const source of SOURCES) {
      try {
        const response = await fetch(source.url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`${source.symbol}:HTTP_${response.status}`);
        const rows = parseCsv(await response.text());
        const payload = JSON.stringify(rows.map((row) => ({ pair: source.pair, date: row.date, value: row.value, symbol: source.symbol, url: source.url })));
        await prisma.$executeRawUnsafe(
          `INSERT INTO fx_metrics(pair_symbol,interval,metric,observed_at,value,payload,source,computed_at)
           SELECT x.pair,'30D','FX_OPTION_IMPLIED_VOL_INDEX_30D',x.date::date,x.value,
             jsonb_build_object('providerSymbol',x.symbol,'measure','30_DAY_EXPECTED_VOLATILITY_INDEX','sourceReported',true,
               'atmQuote',false,'riskReversal',false,'butterfly',false,'sourceUrl',x.url,'officialStatus','OFFICIAL_EXCHANGE_INDEX'),
             'CBOE_OFFICIAL',NOW()
           FROM jsonb_to_recordset($1::jsonb) AS x(pair text,date text,value numeric,symbol text,url text)
           ON CONFLICT(pair_symbol,interval,metric,observed_at) DO NOTHING`,
          payload,
        );
        completed[source.pair] = { symbol: source.symbol, rows: rows.length, earliest: rows.at(0)?.date, latest: rows.at(-1)?.date, status: "COMPLETE_CURRENT" };
      } catch (sourceError) {
        failedSources++;
        completed[source.pair] = { symbol: source.symbol, rows: 0, status: `FAILED: ${sourceError instanceof Error ? sourceError.message : String(sourceError)}` };
      }
    }

    const stats = (await prisma.$queryRawUnsafe<{ pairs: number; rows: number; earliest: string | null; latest: string | null }[]>(
      `SELECT COUNT(DISTINCT pair_symbol)::int pairs, COUNT(*)::int rows, MIN(observed_at)::text earliest, MAX(observed_at)::text latest
         FROM fx_metrics WHERE metric='FX_OPTION_IMPLIED_VOL_INDEX_30D' AND source='CBOE_OFFICIAL'`,
    ))[0];
    const sourceLimited = REQUESTED.filter((pair) => !SOURCES.some((s) => s.pair === pair));
    const rowsAdded = Math.max(0, stats.rows - before);

    await finishRun(runId, JOB, PROVIDER, startedMs, {
      status: failedSources > 0 ? "PARTIAL" : "COMPLETED", attempted: SOURCES.length, completed: SOURCES.length - failedSources,
      inserted: rowsAdded, updated: 0, failed: failedSources, retryableFailures: failedSources, checkpointAfter: null,
      details: { before, after: stats.rows, fxOptionsPairs: stats.pairs, sourceLimited, completed, earliest: stats.earliest, latest: stats.latest },
    });

    return Response.json({ ok: true, job: JOB, runId, before, after: stats.rows, rowsAdded, fxOptionsPairs: stats.pairs, sourceLimited, completed, failedSources, runtimeMs: Date.now() - startedMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, JOB, PROVIDER, startedMs, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 0, checkpointAfter: null, error: message });
    return Response.json({ ok: false, job: JOB, runId, error: message }, { status: 500 });
  }
}
