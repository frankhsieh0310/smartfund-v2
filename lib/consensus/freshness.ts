// SmartMatch 共識雷達 — backend freshness / coverage monitor (Phase 2, STEP 13/14).
// Pure: takes any query(sql, params) -> rows.

import { retryableSql } from "./reviewRetry";
import { consensusBackfillStatus } from "./backfill";

export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;
const num = (v: unknown) => (v == null ? 0 : Number(v));

export async function consensusFreshness(query: QueryFn) {
  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await query<T>(sql, params))[0];

  const events = await one<{ e24: unknown; e7: unknown; total: unknown; latest: string | null }>(
    `select
       count(*) filter (where event_at >= now() - interval '24 hours')::int as e24,
       count(*) filter (where event_at >= now() - interval '7 days')::int   as e7,
       count(*)::int as total,
       max(event_at) as latest
     from consensus_events where extraction_status = 'CLASSIFIED'`,
  );
  const ai = await one<{ pending: unknown; failed: unknown }>(
    `select
       count(*) filter (where extraction_status = 'NEEDS_REVIEW')::int as pending,
       count(*) filter (where extraction_status = 'REJECTED')::int     as failed
     from consensus_events`,
  );
  const sources = await one<{ total: unknown; active: unknown; degraded: unknown; last_success: string | null; last_event: string | null }>(
    `select count(*)::int as total,
            count(*) filter (where status = 'ACTIVE')::int as active,
            count(*) filter (where status = 'DEGRADED')::int as degraded,
            max(last_success_at) as last_success,
            max(last_published_at) as last_event
       from consensus_sources where is_active`,
  );
  const perSource = await query<Record<string, unknown>>(
    `select slug, source_grade, status, consecutive_failures,
            last_success_at, last_published_at, last_error, processed_count
       from consensus_sources where is_active order by source_grade, slug`,
    [],
  );
  const aggregate = await one<{ last: string | null }>(
    `select max(completed_at) as last from production_scheduler_runs
      where job_id = 'CLOUD_CONSENSUS_AGGREGATE' and status = 'COMPLETED'`,
  );
  const lastIngest = await one<{ last: string | null }>(
    `select max(completed_at) as last from production_scheduler_runs
      where job_id = 'CLOUD_CONSENSUS_INGEST'`,
  );
  const coverage = await one<{ people: unknown; sources: unknown }>(
    `select
       (select count(distinct person_id)::int from consensus_events where extraction_status='CLASSIFIED') as people,
       (select count(distinct source_id)::int  from consensus_events where extraction_status='CLASSIFIED') as sources`,
  );

  // Phase 3 — per-person source coverage matrix. A person "has an auto source" if there is an
  // active, non-DISABLED source tied to them (person_id) OR named in their source_priorities whose
  // fetch_method is machine-readable (RSS / API / SEC_EDGAR).
  const AUTO = `('RSS','API','SEC_EDGAR')`;
  const matrixRows = await query<Record<string, unknown>>(
    `with best as (
       select p.id, p.slug, p.display_name, p.category, p.priority,
              s.slug as src_slug, s.source_grade, s.fetch_method, s.status, s.last_success_at,
              row_number() over (
                partition by p.id
                order by (case when s.fetch_method in ${AUTO} then 0 else 1 end),
                         (case s.source_grade when 'A' then 0 when 'B' then 1 else 2 end),
                         s.last_success_at desc nulls last
              ) rn
       from consensus_people p
       left join consensus_sources s
         on s.is_active and s.status <> 'DISABLED'
        and (s.person_id = p.id or s.slug = any (
               select jsonb_array_elements_text(coalesce(p.source_priorities, '[]'::jsonb))))
       where p.is_active
     )
     select id, slug, display_name, category, src_slug, source_grade, fetch_method, status, last_success_at
     from best where rn = 1 order by category, priority, display_name`,
    [],
  );
  const matrix = matrixRows.map((r) => {
    const method = (r.fetch_method as string) ?? null;
    const auto = ["RSS", "API", "SEC_EDGAR"].includes(method ?? "");
    return {
      person: String(r.display_name),
      slug: String(r.slug),
      category: String(r.category),
      primary_source: (r.src_slug as string) ?? null,
      source_grade: (r.source_grade as string) ?? null,
      fetch_method: method,
      parser_status: (r.status as string) ?? null,
      last_success: r.last_success_at ? new Date(r.last_success_at as string).toISOString() : null,
      auto_fetchable: auto,
    };
  });
  const withA = matrix.filter((m) => m.source_grade === "A").length;
  const withB = matrix.filter((m) => m.source_grade === "B").length;
  const withAuto = matrix.filter((m) => m.auto_fetchable).length;
  const srcRoll = await one<{ fetchable: unknown; degraded: unknown; no_access: unknown }>(
    `select
       count(*) filter (where fetch_method in ${AUTO} and status <> 'DISABLED')::int as fetchable,
       count(*) filter (where status = 'DEGRADED')::int as degraded,
       count(*) filter (where fetch_method = 'SKIP_NO_ACCESS')::int as no_access
     from consensus_sources where is_active`,
  );
  const cand24 = await one<{ c: unknown }>(
    `select coalesce(sum((details->>'candidatesSeen')::int),0)::int c
       from production_scheduler_runs
      where job_id = 'CLOUD_CONSENSUS_INGEST' and started_at >= now() - interval '24 hours'`,
  );

  // Phase 4 — review-queue health + AI gateway state
  const queue = await one<{ raw: unknown; classified: unknown; nr: unknown; retry: unknown; oldest_retry: string | null }>(
    `select
       count(*)::int as raw,
       count(*) filter (where extraction_status = 'CLASSIFIED')::int as classified,
       count(*) filter (where extraction_status = 'NEEDS_REVIEW')::int as nr,
       count(*) filter (where extraction_status = 'NEEDS_REVIEW' and ${retryableSql()})::int as retry,
       min(created_at) filter (where extraction_status = 'NEEDS_REVIEW' and ${retryableSql()}) as oldest_retry
     from consensus_events`,
  );
  const aiMeta = await one<{ value: { status?: string; probed_at?: string; last_success_at?: string; detail?: string } }>(
    `select value from consensus_meta where key = 'ai_health'`,
  );
  const callsToday = await one<{ c: unknown }>(
    `select count(*)::int c from consensus_ai_cache where created_at >= date_trunc('day', now())`,
  );
  const nrTotal = num(queue?.nr);
  const retryTotal = num(queue?.retry);

  // Phase 8 — push delivery health
  const push = await one<Record<string, unknown>>(
    `select
       (select count(*)::int from consensus_push_installations) as installs_total,
       (select count(*)::int from consensus_push_installations where notifications_enabled and not invalid_token) as installs_enabled,
       (select count(*)::int from consensus_push_installations where invalid_token) as invalid_tokens,
       (select count(*)::int from consensus_alert_candidates where delivered_at is null) as pending_alert_candidates,
       (select count(*)::int from consensus_push_deliveries where status = 'PENDING') as pending_push_deliveries,
       (select count(*)::int from consensus_push_deliveries where status = 'DELIVERED' and delivered_at >= now() - interval '24 hours') as push_delivered_24h,
       (select count(*)::int from consensus_push_deliveries where status in ('FAILED','INVALID_TOKEN') and created_at >= now() - interval '24 hours') as push_failed_24h,
       (select max(completed_at) from production_scheduler_runs where job_id = 'CLOUD_CONSENSUS_PUSH') as last_push_run_at,
       (select count(*)::int from consensus_inapp_notifications) as inapp_notifications_total`,
  );

  // Phase 9 — historical backfill status
  const backfill = await consensusBackfillStatus(query);

  const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);
  return {
    ...backfill,
    people_total: matrix.length,
    people_with_a_source: withA,
    people_with_b_source: withB,
    people_with_any_auto_source: withAuto,
    people_without_auto_source: matrix.length - withAuto,
    auto_source_coverage_pct: matrix.length ? Math.round((withAuto / matrix.length) * 1000) / 10 : 0,
    sources_fetchable: num(srcRoll?.fetchable),
    sources_no_access: num(srcRoll?.no_access),
    last_24h_candidates: num(cand24?.c),
    // Phase 4 — review queue + AI gateway
    raw_events_total: num(queue?.raw),
    classified_events_total: num(queue?.classified),
    needs_review_total: nrTotal,
    retryable_review_total: retryTotal,
    non_retryable_review_total: nrTotal - retryTotal,
    ai_gateway_status: aiMeta?.value?.status ?? "UNKNOWN",
    ai_gateway_detail: aiMeta?.value?.detail ?? null,
    ai_calls_today: num(callsToday?.c),
    oldest_retryable_review_at: iso(queue?.oldest_retry),
    last_ai_success_at: iso(aiMeta?.value?.last_success_at),
    last_ai_probe_at: iso(aiMeta?.value?.probed_at),
    push_installations_total: num(push?.installs_total),
    push_installations_enabled: num(push?.installs_enabled),
    invalid_tokens: num(push?.invalid_tokens),
    pending_alert_candidates: num(push?.pending_alert_candidates),
    pending_push_deliveries: num(push?.pending_push_deliveries),
    push_delivered_24h: num(push?.push_delivered_24h),
    push_failed_24h: num(push?.push_failed_24h),
    last_push_run_at: iso(push?.last_push_run_at as string),
    inapp_notifications_total: num(push?.inapp_notifications_total),
    people_source_matrix: matrix,
    events_24h: num(events?.e24),
    events_7d: num(events?.e7),
    events_total: num(events?.total),
    latest_source_event_at: iso(events?.latest),
    ai_pending: num(ai?.pending),
    ai_failed: num(ai?.failed),
    source_last_success: iso(sources?.last_success),
    source_last_event: iso(sources?.last_event),
    sources_total: num(sources?.total),
    sources_active: num(sources?.active),
    sources_degraded: num(sources?.degraded),
    coverage_people: num(coverage?.people),
    coverage_sources: num(coverage?.sources),
    aggregate_last_success: iso(aggregate?.last),
    ingest_last_run: iso(lastIngest?.last),
    per_source: perSource.map((s) => ({
      slug: String(s.slug),
      grade: String(s.source_grade),
      status: String(s.status),
      consecutive_failures: num(s.consecutive_failures),
      last_success_at: iso(s.last_success_at as string),
      last_published_at: iso(s.last_published_at as string),
      processed_count: num(s.processed_count),
      last_error: (s.last_error as string) ?? null,
    })),
  };
}
