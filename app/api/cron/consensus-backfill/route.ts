// Cloud consensus historical backfill worker (Phase 9). Bounded, checkpointed, resumable.
//
// Per invocation:
//   - probe AI gateway health once (reuse the 25-min cached probe)
//   - walk a bounded window of REAL public history (SEC EDGAR earnings exhibits + Fed / White House
//     feeds) for Tier-1 people -> attribution -> canonical dedup -> classify cache-first
//   - while AI is billing-blocked every genuine statement lands as a raw NEEDS_REVIEW event
//     (real URL, real historical event_at, evidence kept) — never a guessed stance, never synthetic
//   - incrementally rebuild 1D/7D/30D aggregates for the affected date span (chunked)
//   - refresh historical accuracy (matured 1M/3M/6M now computable) and run a FULL flip reconcile
//     (historical flips can be written but the ALERT_MAX_AGE_HOURS guard blocks any stale push)
//
// Trigger: workflow step (once per daily cycle) or GET Authorization: Bearer <CRON_SECRET>.
//   ?days=180  ?source=<slug>  ?dry=1  ?maxItems=100  ?maxEvents=100  ?skipDownstream=1

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { dbAiCache } from "@/lib/consensus/aiCache";
import { maybeProbe } from "@/lib/consensus/aiHealth";
import { runConsensusBackfill, BACKFILL_DEFAULT_DAYS } from "@/lib/consensus/backfill";
import { aggregateConsensusRange } from "@/lib/consensus/aggregate";
import { detectConsensusFlips, buildAlertCandidates } from "@/lib/consensus/flipDetect";
import { computeSignalPerformance } from "@/lib/consensus/performance";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_CONSENSUS_BACKFILL";
const query = <T = never>(sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<T[]>;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const days = Math.min(400, Math.max(7, Number(url.searchParams.get("days")) || BACKFILL_DEFAULT_DAYS));
  const onlySlug = url.searchParams.get("source");
  const dry = url.searchParams.get("dry") === "1";
  const skipDownstream = url.searchParams.get("skipDownstream") === "1";
  const maxItems = Number(url.searchParams.get("maxItems")) || undefined;
  const maxEvents = Number(url.searchParams.get("maxEvents")) || undefined;
  const started = Date.now();

  const runKey = `consensus-backfill:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "CONSENSUS", runKey, universeCount: 0, batchSize: maxEvents ?? 100, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, task: "consensus-backfill", skipped: true });

  try {
    const health = await maybeProbe(query as never, {});
    const aiBlocked = health.status !== "READY";
    const cache = dbAiCache(query as never);

    const backfill = await runConsensusBackfill(query as never, cache, {
      days, onlySlug, dry, maxItemsPerSource: maxItems, maxEvents, aiBlocked,
    });

    let aggregate: unknown = { skipped: true };
    let performance: unknown = { skipped: true };
    let flips: unknown = { skipped: true };

    if (!dry && !skipDownstream && (backfill.rawEvents > 0 || backfill.classified > 0)) {
      // incremental aggregate over the affected span (backfill-start -> today), daily chunk
      const fromDate = (backfill.oldestProcessedAt ?? backfill.startDateIso).slice(0, 10);
      aggregate = await aggregateConsensusRange(query as never, { fromDate, toDate: new Date().toISOString().slice(0, 10), maxDays: 200 });

      // historical accuracy — any signal whose 1M/3M/6M horizon has already matured gets a real return now
      const today = new Date().toISOString().slice(0, 10);
      const links = (await query<{
        link_id: string; event_id: string; person_id: string; stock_id: string | null;
        symbol: string; relation_type: "DIRECT" | "INFERRED"; stance: "BULLISH" | "BEARISH";
        source_grade: string | null; exchange: string | null; country: string | null; event_at: string;
      }>(
        `select sl.id as link_id, sl.event_id, e.person_id, sl.stock_id, sl.symbol, sl.relation_type,
                sl.stance, s.source_grade, st.exchange, st.country, e.event_at
           from consensus_stock_links sl
           join consensus_events e on e.id = sl.event_id
           left join consensus_sources s on s.id = e.source_id
           left join stocks st on st.id = sl.stock_id
           left join consensus_signal_performance p on p.stock_link_id = sl.id
          where e.extraction_status = 'CLASSIFIED' and sl.stance in ('BULLISH','BEARISH')
            and (p.id is null
                 or (p.hit_1m is null and p.entry_trade_date is not null and (p.entry_trade_date + interval '1 month')::date <= $1::date)
                 or (p.hit_3m is null and p.entry_trade_date is not null and (p.entry_trade_date + interval '3 months')::date <= $1::date)
                 or (p.hit_6m is null and p.entry_trade_date is not null and (p.entry_trade_date + interval '6 months')::date <= $1::date))
          order by e.event_at asc
          limit 1000`,
        [today],
      ));
      let perfComputed = 0, m1 = 0, m3 = 0, m6 = 0;
      for (const l of links) {
        const perf = await computeSignalPerformance(query as never, {
          stockId: l.stock_id, exchange: l.exchange, country: l.country,
          stance: l.stance, eventAtIso: new Date(l.event_at).toISOString(),
        });
        if (perf.h1m.hit) m1++;
        if (perf.h3m.hit) m3++;
        if (perf.h6m.hit) m6++;
        const agree = (await query<{ c: number }>(
          `select count(distinct e2.person_id)::int c
             from consensus_stock_links sl2 join consensus_events e2 on e2.id = sl2.event_id
            where sl2.symbol = $1 and sl2.stance = $2 and e2.extraction_status='CLASSIFIED'
              and e2.event_at between $3::timestamptz - interval '3 days' and $3::timestamptz + interval '3 days'`,
          [l.symbol, l.stance, new Date(l.event_at).toISOString()],
        ))[0]?.c ?? 1;
        await query(
          `insert into consensus_signal_performance
            (stock_link_id, event_id, person_id, stock_id, symbol, relation_type, stance, source_grade,
             consensus_agreement, event_at, entry_trade_date, entry_price, benchmark_symbol,
             price_1m_date, price_1m, return_1m, benchmark_return_1m, alpha_1m, hit_1m,
             price_3m_date, price_3m, return_3m, benchmark_return_3m, alpha_3m, hit_3m,
             price_6m_date, price_6m, return_6m, benchmark_return_6m, alpha_6m, hit_6m, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
                   $14,$15,$16,$17,$18,$19, $20,$21,$22,$23,$24,$25, $26,$27,$28,$29,$30,$31, now())
           on conflict (stock_link_id) do update set
             source_grade = excluded.source_grade, consensus_agreement = excluded.consensus_agreement,
             stock_id = excluded.stock_id, symbol = excluded.symbol,
             entry_trade_date = excluded.entry_trade_date, entry_price = excluded.entry_price,
             benchmark_symbol = excluded.benchmark_symbol,
             price_1m_date = excluded.price_1m_date, price_1m = excluded.price_1m, return_1m = excluded.return_1m,
             benchmark_return_1m = excluded.benchmark_return_1m, alpha_1m = excluded.alpha_1m, hit_1m = excluded.hit_1m,
             price_3m_date = excluded.price_3m_date, price_3m = excluded.price_3m, return_3m = excluded.return_3m,
             benchmark_return_3m = excluded.benchmark_return_3m, alpha_3m = excluded.alpha_3m, hit_3m = excluded.hit_3m,
             price_6m_date = excluded.price_6m_date, price_6m = excluded.price_6m, return_6m = excluded.return_6m,
             benchmark_return_6m = excluded.benchmark_return_6m, alpha_6m = excluded.alpha_6m, hit_6m = excluded.hit_6m,
             updated_at = now()`,
          [l.link_id, l.event_id, l.person_id, l.stock_id, l.symbol, l.relation_type, l.stance, l.source_grade,
           agree, new Date(l.event_at).toISOString(), perf.entry_trade_date, perf.entry_price, perf.benchmark_symbol,
           perf.h1m.price_date, perf.h1m.price, perf.h1m.stock_return, perf.h1m.benchmark_return, perf.h1m.alpha, perf.h1m.hit,
           perf.h3m.price_date, perf.h3m.price, perf.h3m.stock_return, perf.h3m.benchmark_return, perf.h3m.alpha, perf.h3m.hit,
           perf.h6m.price_date, perf.h6m.price, perf.h6m.stock_return, perf.h6m.benchmark_return, perf.h6m.alpha, perf.h6m.hit],
        );
        perfComputed++;
      }
      performance = { scanned: links.length, computed: perfComputed, newlyMature: { m1, m3, m6 } };

      // full flip reconciliation — historical flips get written; the age guard in flipDetect keeps
      // push_eligible=false for anything older than ALERT_MAX_AGE_HOURS, so no stale push fires.
      const detect = await detectConsensusFlips(query as never, { sinceIso: null });
      const alertCandidatesCreated = await buildAlertCandidates(query as never);
      const pushSuppressed = (await query<{ c: number }>(
        `select count(*)::int c from consensus_flip_signals
          where flip_type in ('BEAR_TO_BULL','BULL_TO_BEAR','NEUTRAL_TO_BULL','NEUTRAL_TO_BEAR')
            and not push_eligible and current_event_at < now() - interval '24 hours'`, [],
      ))[0]?.c ?? 0;
      flips = { ...detect, alertCandidatesCreated, historicalPushSuppressed: pushSuppressed };
    }

    const details = {
      days, dry, aiGateway: health.status, aiBlocked, backfill, aggregate, performance, flips,
      runtimeMs: Date.now() - started,
    };
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: backfill.sourcesRemaining.length > 0 ? "PARTIAL" : "COMPLETED",
      attempted: backfill.itemsFetched, completed: backfill.rawEvents + backfill.deduped,
      inserted: backfill.rawEvents, updated: backfill.deduped, failed: 0, retryableFailures: 0,
      checkpointAfter: null, details,
    });
    return Response.json({ ok: true, task: "consensus-backfill", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1,
      retryableFailures: 1, checkpointAfter: null, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "consensus-backfill", error: (e as Error).message }, { status: 500 });
  }
}
