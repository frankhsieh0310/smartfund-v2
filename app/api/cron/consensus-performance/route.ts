// Cloud consensus performance worker (Phase 5) — daily historical accuracy update. No AI.
//
// For each CLASSIFIED bullish/bearish consensus_stock_link that has no perf row yet, or whose
// 1M/3M/6M horizon may now have matured, recompute entry + forward returns + benchmark alpha
// from the production price stores (stock_history / index_history) and upsert
// consensus_signal_performance. Bounded batch; never a full-table recompute.
//
// Trigger: 08:00 Asia/Taipei via cloud scheduler -> GET Authorization: Bearer <CRON_SECRET>.
//   ?batch=<n>  (default 500)   ?full=1  (also revisit already-mature rows)

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun } from "@/lib/cloud-ingestion/runContext";
import { computeSignalPerformance, addMonthsISO } from "@/lib/consensus/performance";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_CONSENSUS_PERFORMANCE";
const DEFAULT_BATCH = 500;
const TIME_BUDGET_MS = 250_000;

const query = (sql: string, params: unknown[]) => prisma.$queryRawUnsafe(sql, ...params) as Promise<never[]>;

type LinkRow = {
  link_id: string; event_id: string; person_id: string; stock_id: string | null;
  symbol: string; relation_type: "DIRECT" | "INFERRED"; stance: "BULLISH" | "BEARISH";
  source_grade: string | null; exchange: string | null; country: string | null;
  event_at: string; agreement: number;
};

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const batch = Math.min(2000, Math.max(1, Number(url.searchParams.get("batch")) || DEFAULT_BATCH));
  const full = url.searchParams.get("full") === "1";
  const started = Date.now();

  const runKey = `consensus-performance:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "CONSENSUS", runKey, universeCount: 0, batchSize: batch, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, task: "consensus-performance", skipped: true });

  try {
    const today = new Date().toISOString().slice(0, 10);
    const links = (await query(
      `select sl.id as link_id, sl.event_id, e.person_id, sl.stock_id, sl.symbol,
              sl.relation_type, sl.stance, s.source_grade,
              st.exchange, st.country, e.event_at,
              (select count(distinct e2.person_id)::int
                 from consensus_stock_links sl2
                 join consensus_events e2 on e2.id = sl2.event_id
                where sl2.symbol = sl.symbol
                  and sl2.stance = sl.stance
                  and e2.extraction_status = 'CLASSIFIED'
                  and e2.event_at between e.event_at - interval '3 days' and e.event_at + interval '3 days'
              ) as agreement
         from consensus_stock_links sl
         join consensus_events e on e.id = sl.event_id
         left join consensus_sources s on s.id = e.source_id
         left join stocks st on st.id = sl.stock_id
         left join consensus_signal_performance p on p.stock_link_id = sl.id
        where e.extraction_status = 'CLASSIFIED'
          and sl.stance in ('BULLISH','BEARISH')
          and (
            p.id is null
            ${full ? "or true" : `
            or (p.hit_1m is null and (p.entry_trade_date is not null) and (p.entry_trade_date + interval '1 month')::date <= $1::date)
            or (p.hit_3m is null and (p.entry_trade_date is not null) and (p.entry_trade_date + interval '3 months')::date <= $1::date)
            or (p.hit_6m is null and (p.entry_trade_date is not null) and (p.entry_trade_date + interval '6 months')::date <= $1::date)
            or (p.entry_trade_date is null)`}
          )
        order by e.event_at asc
        limit ${batch}`,
      [today],
    )) as unknown as LinkRow[];

    let computed = 0, matured1m = 0, matured3m = 0, matured6m = 0, withEntry = 0, benchmarked = 0;
    for (const l of links) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      const perf = await computeSignalPerformance(query as never, {
        stockId: l.stock_id, exchange: l.exchange, country: l.country,
        stance: l.stance, eventAtIso: new Date(l.event_at).toISOString(),
      });
      if (perf.entry_trade_date) withEntry++;
      if (perf.benchmark_symbol) benchmarked++;
      if (perf.h1m.hit) matured1m++;
      if (perf.h3m.hit) matured3m++;
      if (perf.h6m.hit) matured6m++;

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
         Number(l.agreement) || 1, new Date(l.event_at).toISOString(), perf.entry_trade_date, perf.entry_price, perf.benchmark_symbol,
         perf.h1m.price_date, perf.h1m.price, perf.h1m.stock_return, perf.h1m.benchmark_return, perf.h1m.alpha, perf.h1m.hit,
         perf.h3m.price_date, perf.h3m.price, perf.h3m.stock_return, perf.h3m.benchmark_return, perf.h3m.alpha, perf.h3m.hit,
         perf.h6m.price_date, perf.h6m.price, perf.h6m.stock_return, perf.h6m.benchmark_return, perf.h6m.alpha, perf.h6m.hit],
      );
      computed++;
    }

    const totals = (await query(
      `select
         count(*)::int total,
         count(*) filter (where hit_1m is not null)::int m1,
         count(*) filter (where hit_3m is not null)::int m3,
         count(*) filter (where hit_6m is not null)::int m6,
         count(*) filter (where alpha_1m is not null or alpha_3m is not null or alpha_6m is not null)::int with_alpha
       from consensus_signal_performance`, [],
    ))[0] as unknown as { total: number; m1: number; m3: number; m6: number; with_alpha: number };

    const details = {
      scanned: links.length, computed, withEntry, benchmarked,
      newlyMature: { m1: matured1m, m3: matured3m, m6: matured6m },
      perfTable: totals, addMonthsExample: addMonthsISO(today, 1), runtimeMs: Date.now() - started,
    };
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "COMPLETED", attempted: links.length, completed: computed, inserted: computed, updated: 0,
      failed: 0, retryableFailures: 0, checkpointAfter: null, details,
    });
    return Response.json({ ok: true, task: "consensus-performance", ...details });
  } catch (e) {
    await finishRun(runId, JOB, "CONSENSUS", started, {
      status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1,
      retryableFailures: 1, checkpointAfter: null, error: (e as Error).message,
    });
    return Response.json({ ok: false, task: "consensus-performance", error: (e as Error).message }, { status: 500 });
  }
}
