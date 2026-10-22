// FX global carry/CIP ranking — DB-side only, zero external fetch. Reads economic_series/economic_values
// (EFFR/ESTR/SONIA overnight rates, already ingested by the macro pipeline) and fx_pairs, materializes
// RATE_DIFFERENTIAL_HISTORY / CARRY_OBSERVATION / OVERNIGHT_RATE_RANK rows into fx_metrics. Same SQL as
// scripts/data/fx-carry-cip/materialize-global-carry-ranking.ts; ported to run on Vercel cron instead of
// a Windows Scheduled Task (see CLAUDE.md "正式資料排程一律在雲端執行") — logic unchanged.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, hourBucketKey } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "FX_CARRY_CIP_ANALYTICS";
const PROVIDER = "SMARTFUND_DERIVED";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const runKey = hourBucketKey("fx-global-carry-ranking");
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: 0, checkpointBefore: null });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "run_key already present this hour", runKey });

  try {
    const before = (await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT COUNT(*)::int n FROM fx_metrics WHERE metric IN ('RATE_DIFFERENTIAL_HISTORY','CARRY_OBSERVATION','OVERNIGHT_RATE_RANK')`,
    ))[0].n;

    await prisma.$executeRawUnsafe(
      `WITH selected(currency,provider,provider_series_id) AS (
           VALUES ('USD','Federal Reserve Bank of New York','EFFR'),
                  ('EUR','European Central Bank','ESTR'),
                  ('GBP','Bank of England','SONIA')
         ),
         r AS (SELECT x.currency,s.id,s.provider,s.series_id FROM selected x JOIN economic_series s ON s.provider=x.provider AND s.series_id=x.provider_series_id),
         pairs AS (SELECT symbol,base_currency,quote_currency FROM fx_pairs WHERE active AND base_currency IN ('USD','EUR','GBP') AND quote_currency IN ('USD','EUR','GBP')),
         d AS (
           SELECT q.symbol,q.base_currency,q.quote_currency,b.date,b.value::numeric base_rate,v.value::numeric quote_rate,
                  br.provider||':'||br.series_id base_source, qr.provider||':'||qr.series_id quote_source,
                  GREATEST(COALESCE(b.imported_at,b.updated_at),COALESCE(v.imported_at,v.updated_at)) known_at
             FROM pairs q
             JOIN r br ON br.currency=q.base_currency JOIN economic_values b ON b.series_id=br.id
             JOIN r qr ON qr.currency=q.quote_currency JOIN economic_values v ON v.series_id=qr.id AND v.date=b.date
         )
       INSERT INTO fx_metrics(pair_symbol,interval,metric,observed_at,value,payload,source,computed_at)
       SELECT symbol,'ON',m.metric,date,
         CASE m.metric WHEN 'RATE_DIFFERENTIAL_HISTORY' THEN base_rate-quote_rate ELSE sign(base_rate-quote_rate) END,
         jsonb_build_object('baseCurrency',base_currency,'quoteCurrency',quote_currency,'baseRate',base_rate,'quoteRate',quote_rate,
           'orientation','LONG_'||base_currency||'_SHORT_'||quote_currency,'rateType','OVERNIGHT_MONEY_MARKET',
           'baseSource',base_source,'quoteSource',quote_source,'knownAt',known_at,
           'calculationVersion','FX_GLOBAL_CARRY_V1','tradingSignal',false),
         'SMARTFUND_DERIVED',NOW()
       FROM d CROSS JOIN (VALUES('RATE_DIFFERENTIAL_HISTORY'),('CARRY_OBSERVATION')) m(metric)
       ON CONFLICT(pair_symbol,interval,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,payload=EXCLUDED.payload,computed_at=NOW()`,
    );

    await prisma.$executeRawUnsafe(
      `WITH selected(currency,provider,provider_series_id) AS (
           VALUES ('USD','Federal Reserve Bank of New York','EFFR'),
                  ('EUR','European Central Bank','ESTR'),
                  ('GBP','Bank of England','SONIA')
         ),
         r AS (SELECT x.currency,s.id,s.provider,s.series_id FROM selected x JOIN economic_series s ON s.provider=x.provider AND s.series_id=x.provider_series_id),
         x AS (SELECT r.currency,v.date,v.value,GREATEST(COALESCE(v.imported_at,v.updated_at),v.created_at) known_at,r.provider||':'||r.series_id source FROM r JOIN economic_values v ON v.series_id=r.id),
         ranked AS (
           SELECT *, dense_rank() over(partition by date order by value desc) rank_desc,
                  dense_rank() over(partition by date order by value asc) rank_asc,
                  count(*) over(partition by date) currencies
             FROM x
         )
       INSERT INTO fx_metrics(pair_symbol,interval,metric,observed_at,value,payload,source,computed_at)
       SELECT 'FX_CURRENCY_RANKING',currency,'OVERNIGHT_RATE_RANK',date,rank_desc,
         jsonb_build_object('currency',currency,'rate',value,'highest',rank_desc=1,'lowest',rank_asc=1,
           'currenciesCompared',currencies,'knownAt',known_at,'inputSource',source,
           'calculationVersion','FX_CURRENCY_RATE_RANK_V1','tradingSignal',false),
         'SMARTFUND_DERIVED',NOW()
       FROM ranked WHERE currencies>=2
       ON CONFLICT(pair_symbol,interval,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,payload=EXCLUDED.payload,computed_at=NOW()`,
    );

    const stats = (await prisma.$queryRawUnsafe<{
      differential_rows: number; carry_pairs: number; positive_rows: number; negative_rows: number;
      ranking_rows: number; earliest: string | null; latest: string | null; history_rows: number;
    }[]>(
      `SELECT COUNT(*) FILTER(WHERE metric='RATE_DIFFERENTIAL_HISTORY')::int differential_rows,
              COUNT(DISTINCT pair_symbol) FILTER(WHERE metric='RATE_DIFFERENTIAL_HISTORY')::int carry_pairs,
              COUNT(*) FILTER(WHERE metric='CARRY_OBSERVATION' AND value>0)::int positive_rows,
              COUNT(*) FILTER(WHERE metric='CARRY_OBSERVATION' AND value<0)::int negative_rows,
              COUNT(*) FILTER(WHERE metric='OVERNIGHT_RATE_RANK')::int ranking_rows,
              MIN(observed_at)::text earliest, MAX(observed_at)::text latest, COUNT(*)::int history_rows
         FROM fx_metrics WHERE metric IN ('RATE_DIFFERENTIAL_HISTORY','CARRY_OBSERVATION','OVERNIGHT_RATE_RANK')`,
    ))[0];
    const policy = (await prisma.$queryRawUnsafe<{ series: number }[]>(
      `SELECT COUNT(*)::int series FROM economic_series s WHERE enabled AND category IN ('POLICY_RATE','CENTRAL_BANK_POLICY_RATE')
         AND EXISTS(SELECT 1 FROM economic_values v WHERE v.series_id=s.id)`,
    ))[0].series;

    const after = stats.history_rows;
    const rowsAdded = Math.max(0, after - before);
    // 2026-10-22（使用者核准）：這支route之前不論rowsAdded是多少都無條件回報COMPLETED，造成
    // 上游economic_values（EFFR/ESTR/SONIA）從2026-08-10起就沒有新資料，但這個job每天照樣
    // 回報COMPLETED，連續40+天沒人發現——根因其實在上游（run-global-money-market.ts沒有任何
    // 排程或cron觸發它，也完全沒有log到production_scheduler_runs，是個孤兒腳本，見CLAUDE.md
    // 記錄）。這裡修正回報邏輯本身：寫入0筆新資料時一律回報SKIPPED（不是COMPLETED），讓既有
    // 的checkPipelineRunLog／freshness check能偵測到連續多天SKIPPED，不會再被無條件COMPLETED
    // 蓋掉。SQL本身沒有改（ON CONFLICT DO UPDATE的既有行為不變），只改回報狀態。
    const status = rowsAdded > 0 ? "COMPLETED" : "SKIPPED";
    await finishRun(runId, JOB, PROVIDER, startedMs, {
      status, attempted: after, completed: after, inserted: rowsAdded, updated: 0, failed: 0,
      retryableFailures: 0, checkpointAfter: null,
      details: {
        before, after, policyRateSeries: policy, ...stats,
        skippedReason: rowsAdded === 0 ? "NO_NEW_UPSTREAM_ECONOMIC_VALUES_ROWS" : null,
      },
    });

    return Response.json({ ok: true, job: JOB, runId, status, before, after, rowsAdded, policyRateSeries: policy, ...stats, runtimeMs: Date.now() - startedMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishRun(runId, JOB, PROVIDER, startedMs, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 0, checkpointAfter: null, error: message });
    return Response.json({ ok: false, job: JOB, runId, error: message }, { status: 500 });
  }
}
