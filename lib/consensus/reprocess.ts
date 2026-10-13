// SmartMatch 共識雷達 — autonomous NEEDS_REVIEW backlog drain (Phase 4, STEP 1/4/5).
//
// Picks retryable NEEDS_REVIEW events (oldest first), re-runs classification through the AI cache,
// and on success updates THE SAME event row in place (never a second event) + rebuilds only that
// event's consensus_stock_links (DIRECT verbatim guard still applies; ambiguous symbol -> NULL).
// Bounded by batchCap and a daily AI-call cap. Returns the symbols/sectors it touched so the caller
// can re-aggregate just those.

import { classifyConsensusEvent, type CachePort, type ExtractionInput } from "./extractionContract";
import { resolveSymbol } from "./stockMapping";
import { retryableSql } from "./reviewRetry";

export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;

export type DrainResult = {
  candidates: number;
  reclassified: number;
  stillPending: number;
  aiCalls: number;
  cacheHits: number;
  directLinks: number;
  inferredLinks: number;
  unmappedSymbols: string[];
  affectedSymbols: string[];
  affectedSectors: string[];
  capHit: "BATCH" | "DAILY" | null;
};

type BacklogRow = {
  id: string;
  person_display_name: string;
  person_slug: string;
  person_country: string | null;
  source_name: string | null;
  source_grade: "A" | "B" | "C" | null;
  source_url: string;
  source_title: string | null;
  original_text: string | null;
  event_at: string;
};

export async function drainReviewBacklog(
  query: QueryFn,
  cache: CachePort,
  opts: { batchCap: number; remainingDailyCalls: number },
): Promise<DrainResult> {
  const res: DrainResult = {
    candidates: 0, reclassified: 0, stillPending: 0, aiCalls: 0, cacheHits: 0,
    directLinks: 0, inferredLinks: 0, unmappedSymbols: [], affectedSymbols: [], affectedSectors: [], capHit: null,
  };
  const limit = Math.max(0, Math.min(opts.batchCap, opts.remainingDailyCalls + opts.batchCap)); // cache hits don't cost a call
  if (limit === 0) { res.capHit = "DAILY"; return res; }

  const rows = (await query<BacklogRow>(
    `select e.id,
            p.display_name as person_display_name, p.slug as person_slug, p.country as person_country,
            s.source_name, s.source_grade, e.source_url, e.source_title, e.original_text, e.event_at
       from consensus_events e
       join consensus_people p on p.id = e.person_id
       left join consensus_sources s on s.id = e.source_id
      where e.extraction_status = 'NEEDS_REVIEW'
        and ${retryableSql()}
      order by e.created_at asc
      limit ${limit}`,
    [],
  )) as BacklogRow[];
  res.candidates = rows.length;

  const symbols = new Set<string>();
  const sectors = new Set<string>();

  for (const row of rows) {
    if (res.aiCalls >= opts.remainingDailyCalls) { res.capHit = "DAILY"; break; }

    const input: ExtractionInput = {
      personDisplayName: row.person_display_name,
      personRole: null,
      sourceName: row.source_name ?? "unknown",
      sourceGrade: (row.source_grade ?? "B") as "A" | "B" | "C",
      sourceUrl: row.source_url,
      eventAt: new Date(row.event_at).toISOString(),
      title: row.source_title,
      rawText: row.original_text ?? row.source_title ?? "",
    };

    const outcome = await classifyConsensusEvent(input, cache);
    if ("cached" in outcome && outcome.cached) res.cacheHits++; else res.aiCalls++;

    if (outcome.status !== "CLASSIFIED") {
      await query(
        `update consensus_events
            set needs_review_reason = $2,
                content_hash = coalesce($3, content_hash),
                extraction_version = coalesce($4, extraction_version),
                updated_at = now()
          where id = $1`,
        [row.id, (outcome as { reason?: string }).reason ?? "reclassify failed",
         "contentHash" in outcome ? outcome.contentHash : null,
         "version" in outcome ? outcome.version : null],
      );
      res.stillPending++;
      continue;
    }

    const r = outcome.result;
    // 1) update the SAME event row
    await query(
      `update consensus_events set
         stance = $2, confidence = $3, statement_strength = $4, sector = $5, theme = $6, summary_zh = $7,
         direct_stock_symbols = $8::jsonb, inferred_stock_symbols = $9::jsonb,
         extraction_status = 'CLASSIFIED', extraction_model = $10, extraction_version = $11,
         content_hash = $12, needs_review_reason = null, updated_at = now()
       where id = $1`,
      [row.id, r.stance, r.confidence, r.statement_strength, r.sector, r.theme, r.summary_zh,
       JSON.stringify(r.direct_mentions.map((d) => d.symbol)),
       JSON.stringify(r.inferred_relations.map((x) => x.symbol)),
       outcome.model, outcome.version, outcome.contentHash],
    );
    // 2) rebuild ONLY this event's links
    await query(`delete from consensus_stock_links where event_id = $1`, [row.id]);
    const linkRows = [
      ...r.direct_mentions.map((d) => ({ symbol: d.symbol, relation: "DIRECT" as const, company: d.company, reason: d.evidence, conf: r.confidence })),
      ...r.inferred_relations.map((x) => ({ symbol: x.symbol, relation: "INFERRED" as const, company: undefined, reason: x.reason, conf: Math.min(0.7, x.confidence) })),
    ];
    for (const lr of linkRows) {
      const resolved = await resolveSymbol(lr.symbol, { companyHint: lr.company ?? null, countryHint: row.person_country });
      if (!resolved.stockId) res.unmappedSymbols.push(lr.symbol);
      await query(
        `insert into consensus_stock_links (event_id, stock_id, symbol, exchange, relation_type, stance, confidence, reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (event_id, symbol, relation_type) do update set
           stock_id = excluded.stock_id, exchange = excluded.exchange, stance = excluded.stance,
           confidence = excluded.confidence, reason = excluded.reason`,
        [row.id, resolved.stockId, resolved.symbol, resolved.exchange, lr.relation, r.stance, lr.conf, lr.reason ?? null],
      );
      if (lr.relation === "DIRECT") res.directLinks++; else res.inferredLinks++;
      symbols.add(resolved.symbol);
    }
    if (r.sector) sectors.add(r.sector);
    res.reclassified++;
    if (!res.capHit && res.reclassified + res.stillPending >= opts.batchCap) { res.capHit = "BATCH"; break; }
  }

  res.affectedSymbols = [...symbols];
  res.affectedSectors = [...sectors];
  res.unmappedSymbols = [...new Set(res.unmappedSymbols)];
  return res;
}
