// Cloud consensus ingest worker (Phase D + Phase 2) — bounded, incremental, resumable, self-healing.
//
// Per invocation, for each ACTIVE source that is due (or ?source=<slug>):
//   checkpoint (production_scheduler_checkpoints key consensus:<slug>) -> since = max(cp, now-Nh)
//   -> fetch feed candidates for [since, now]              (lib/consensus/sourceFetch)
//   -> hydrate top candidate bodies (bounded)
//   -> strict person attribution                           (lib/consensus/attribution) — no attribution => skip
//   -> classify via Vercel AI Gateway OIDC + DB cache      (lib/consensus/extractionContract + aiCache)
//   -> persist with canonical-key dedup + DIRECT/INFERRED  (lib/consensus/persistEvent)
//   -> advance checkpoint; update source health (3 consecutive failures => DEGRADED, others keep running)
// No full-history re-fetch. No AI re-run on a cached content hash. Bounded batch + time budget.
//
// Trigger: every 3h via Vercel Workflow (or GitHub Actions) -> GET Authorization: Bearer <CRON_SECRET>.
//   ?source=<slug>  ?dry=1  ?lookbackHours=4  ?maxCandidates=20

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";
import { fetchSourceCandidates, hydrateBody, type SourceRow } from "@/lib/consensus/sourceFetch";
import { classifyConsensusEvent } from "@/lib/consensus/extractionContract";
import { dbAiCache } from "@/lib/consensus/aiCache";
import { attributePerson, type PersonRef } from "@/lib/consensus/attribution";
import { persistConsensusEvent, type QueryFn } from "@/lib/consensus/persistEvent";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_CONSENSUS_INGEST";
const DEFAULT_LOOKBACK_H = 4;
const DEFAULT_MAX_CANDIDATES = 20;
const HARD_MAX_CANDIDATES = 60;
const TIME_BUDGET_MS = 250_000;

const query: QueryFn = (sql, params) => prisma.$queryRawUnsafe(sql, ...(params as unknown[])) as Promise<never[]>;

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const url = new URL(request.url);
  const onlySlug = url.searchParams.get("source");
  const dry = url.searchParams.get("dry") === "1";
  const lookbackH = Math.min(72, Math.max(1, Number(url.searchParams.get("lookbackHours")) || DEFAULT_LOOKBACK_H));
  const maxCandidates = Math.min(HARD_MAX_CANDIDATES, Math.max(1, Number(url.searchParams.get("maxCandidates")) || DEFAULT_MAX_CANDIDATES));
  const started = Date.now();

  const runKey = `consensus-ingest:${onlySlug ?? "all"}:${new Date().toISOString().slice(0, 13)}`;
  const { runId, skipped } = await beginRun({
    jobName: JOB, provider: "CONSENSUS", runKey, universeCount: 0, batchSize: maxCandidates, checkpointBefore: null,
  });
  if (skipped) return Response.json({ ok: true, task: "consensus-ingest", skipped: true });

  const people = (await query<PersonRef & { aliases: unknown }>(
    `select id, slug, display_name as "displayName", country, aliases from consensus_people where is_active`, [],
  )).map((p) => ({ ...p, aliases: Array.isArray(p.aliases) ? (p.aliases as string[]) : [] })) as PersonRef[];

  const sources = (await query<SourceRow & { status: string; next_retry_at: string | null; consecutive_failures: number }>(
    `select id, slug, source_type, source_name, source_grade, canonical_url, person_id, is_official,
            fetch_method, status, next_retry_at, consecutive_failures
       from consensus_sources
      where is_active and status <> 'DISABLED'
        ${onlySlug ? "and slug = $1" : "and fetch_method in ('RSS','API','SEC_EDGAR')"}
        ${onlySlug ? "" : "and (next_retry_at is null or next_retry_at <= now())"}
      order by case source_grade when 'A' then 1 when 'B' then 2 else 3 end, slug`,
    onlySlug ? [onlySlug] : [],
  )) as Array<SourceRow & { status: string; consecutive_failures: number }>;

  const cache = dbAiCache(query);
  const nowIso = new Date().toISOString();
  const perSource: Array<Record<string, unknown>> = [];
  let candidatesSeen = 0, attributed = 0, notAttributed = 0, eventsWritten = 0, deduped = 0;
  let aiClassified = 0, aiCacheHits = 0, aiNeedsReview = 0, aiCalls = 0;
  let directLinks = 0, inferredLinks = 0, sourceFailures = 0, checkpointsAdvanced = 0;
  const unmapped = new Set<string>();

  for (const src of sources) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const cpKey = `consensus:${src.slug}`;
    const cp = await readCheckpoint(cpKey);
    const cpSince = cp?.lastSymbol ? Date.parse(cp.lastSymbol) : 0;
    const lookbackSince = Date.now() - lookbackH * 3_600_000;
    const sinceIso = new Date(Math.max(cpSince || lookbackSince, lookbackSince)).toISOString();

    const outcome = await fetchSourceCandidates(src, sinceIso);
    let srcWritten = 0, srcAttributed = 0, srcClassified = 0;

    if (!outcome.ok) {
      sourceFailures++;
      const cf = (src.consecutive_failures ?? 0) + 1;
      const degraded = cf >= 3;
      if (!dry) await query(
        `update consensus_sources set consecutive_failures=$2, last_error=$3, last_error_at=now(),
           status = case when $4 then 'DEGRADED' else status end,
           next_retry_at = case when $4 then now() + interval '6 hours' else now() + interval '30 minutes' end
         where id=$1`,
        [src.id, cf, (outcome.error ?? "fetch failed").slice(0, 300), degraded],
      );
      perSource.push({ slug: src.slug, ok: false, error: outcome.error, consecutive_failures: cf, degraded });
      continue;
    }

    const ownerPerson = src.person_id ? people.find((p) => p.id === src.person_id) ?? null : null;
    for (const cand of outcome.candidates) {
      if (candidatesSeen >= maxCandidates || Date.now() - started > TIME_BUDGET_MS) break;
      candidatesSeen++;
      let text = cand.text;
      if (text.length < 400) {
        const body = await hydrateBody(cand.url);
        if (body && body.length > text.length) text = body;
      }
      const attr = attributePerson({
        title: cand.title, text, people,
        ownerPersonId: src.person_id, sourceIsOfficial: Boolean(src.is_official), sourceType: src.source_type,
      });
      if (!attr.attributed || !attr.person) { notAttributed++; continue; }
      attributed++; srcAttributed++;
      const person = attr.person;

      const classification = dry
        ? ({ status: "NEEDS_REVIEW", reason: "dry run", model: "-", version: "-", contentHash: "-" } as const)
        : await classifyConsensusEvent(
            { personDisplayName: person.displayName, personRole: null, sourceName: src.source_name,
              sourceGrade: src.source_grade, sourceUrl: cand.url, eventAt: cand.publishedAt ?? nowIso,
              title: cand.title, rawText: text },
            cache,
          );
      if (!dry) {
        if ("cached" in classification && classification.cached) aiCacheHits++;
        else aiCalls++;
      }
      if (classification.status === "CLASSIFIED") { aiClassified++; srcClassified++; } else aiNeedsReview++;
      if (dry) continue;

      const res = await persistConsensusEvent(query, {
        personId: person.id, personSlug: person.slug, personCountry: person.country,
        sourceId: src.id, sourceGrade: src.source_grade,
        eventAt: cand.publishedAt ?? nowIso, publishedAt: cand.publishedAt, eventType: null,
        sourceUrl: cand.url, sourceTitle: cand.title, rawText: text, classification,
      });
      if (res.deduped) deduped++; else { eventsWritten++; srcWritten++; }
      directLinks += res.directLinks; inferredLinks += res.inferredLinks;
      res.unmappedSymbols.forEach((s) => unmapped.add(s));
    }

    const newestPub = outcome.newestPublishedAt ?? nowIso;
    if (!dry) {
      await writeCheckpoint(JOB, cpKey, runId, {
        lastSymbol: newestPub, processed: (cp?.processed ?? 0) + outcome.candidates.length,
        succeeded: (cp?.succeeded ?? 0) + srcWritten, failed: cp?.failed ?? 0,
      });
      checkpointsAdvanced++;
      await query(
        `update consensus_sources set status = case when status='DEGRADED' then 'ACTIVE' else status end,
           consecutive_failures = 0, last_error = null, next_retry_at = null,
           last_success_at = now(), last_published_at = greatest(coalesce(last_published_at, 'epoch'::timestamptz), $2::timestamptz),
           last_item_url = coalesce($3, last_item_url), processed_count = processed_count + $4
         where id = $1`,
        [src.id, newestPub, outcome.candidates[0]?.url ?? null, outcome.candidates.length],
      );
    }
    perSource.push({
      slug: src.slug, grade: src.source_grade, ok: true, candidates: outcome.candidates.length,
      attributed: srcAttributed, classified: srcClassified, written: srcWritten, newestPublishedAt: outcome.newestPublishedAt,
      skipped: outcome.skippedReason,
    });
  }

  const details = {
    sources: sources.length, candidatesSeen, attributed, notAttributed,
    eventsWritten, deduped, aiClassified, aiNeedsReview, aiCalls, aiCacheHits,
    directLinks, inferredLinks, unmappedSymbols: [...unmapped], checkpointsAdvanced, sourceFailures,
    aiEnabled: Boolean(process.env.VERCEL_OIDC_TOKEN || process.env.AI_GATEWAY_API_KEY),
    dry, lookbackH, maxCandidates, runtimeMs: Date.now() - started, perSource,
  };
  await finishRun(runId, JOB, "CONSENSUS", started, {
    status: sourceFailures > 0 && eventsWritten === 0 ? "PARTIAL" : "COMPLETED",
    attempted: candidatesSeen, completed: eventsWritten + deduped, inserted: eventsWritten, updated: deduped,
    failed: sourceFailures, retryableFailures: sourceFailures, checkpointAfter: null, details,
  });
  return Response.json({ ok: true, task: "consensus-ingest", ...details });
}
