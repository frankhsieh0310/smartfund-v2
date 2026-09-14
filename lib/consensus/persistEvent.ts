// SmartMatch 共識雷達 — persist one classified (or needs-review) event (Phases E/F/K).
//
// - dedup on canonical_event_key (one original statement = one event, N source refs)
// - always keep source_url / published_at / person / original_text (evidence)
// - stock links only when CLASSIFIED; DIRECT vs INFERRED preserved; ambiguous symbol -> stock_id NULL
// - NO_VIEW (UNCLEAR + no mentions) writes the event but creates NO stock link (NO_VIEW != NEUTRAL)

import { canonicalEventKey } from "./canonicalKey";
import { resolveSymbol } from "./stockMapping";
import type { ClassifyOutcome, Stance } from "./extractionContract";

export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;

export type PersistInput = {
  personId: string;
  personSlug: string;
  personCountry: string | null;
  sourceId: string | null;
  sourceGrade: "A" | "B" | "C";
  eventAt: string; // ISO
  publishedAt?: string | null;
  eventType?: string | null;
  sourceUrl: string;
  sourceTitle?: string | null;
  rawText: string;
  language?: string;
  topic?: string | null;
  classification: ClassifyOutcome;
  extraSourceUrls?: string[]; // other outlets that ran the same original statement
};

export type PersistResult = {
  eventId: string;
  canonicalEventKey: string;
  deduped: boolean;
  status: "CLASSIFIED" | "NEEDS_REVIEW" | "REJECTED";
  directLinks: number;
  inferredLinks: number;
  unmappedSymbols: string[];
};

export async function persistConsensusEvent(query: QueryFn, input: PersistInput): Promise<PersistResult> {
  const key = canonicalEventKey({
    personSlug: input.personSlug,
    eventAt: input.eventAt,
    quote: input.rawText,
    topic: input.topic ?? (input.classification.status === "CLASSIFIED" ? input.classification.result.theme : null),
  });

  const c = input.classification;
  const stance: Stance = c.status === "CLASSIFIED" ? c.result.stance : "UNCLEAR";
  const status = c.status;
  const confidence = c.status === "CLASSIFIED" ? c.result.confidence : 0.5;
  const strength = c.status === "CLASSIFIED" ? c.result.statement_strength : 0.5;
  const sector = c.status === "CLASSIFIED" ? c.result.sector : null;
  const theme = c.status === "CLASSIFIED" ? c.result.theme : null;
  const summaryZh = c.status === "CLASSIFIED" ? c.result.summary_zh : null;
  const model = "model" in c ? c.model : null;
  const contentHash = "contentHash" in c ? c.contentHash : null;
  const extractionVersion = "version" in c ? c.version : null;
  const reviewReason = c.status === "CLASSIFIED" ? null : (c as { reason?: string }).reason ?? null;
  const directSyms = c.status === "CLASSIFIED" ? c.result.direct_mentions.map((d) => d.symbol) : [];
  const inferredSyms = c.status === "CLASSIFIED" ? c.result.inferred_relations.map((r) => r.symbol) : [];

  const existing = (await query<{ id: string }>(
    `select id from consensus_events where canonical_event_key = $1 limit 1`,
    [key],
  ))[0];

  let eventId: string;
  let deduped = false;
  if (existing) {
    eventId = existing.id;
    deduped = true;
    // fill in a classification if the prior row was only NEEDS_REVIEW
    if (c.status === "CLASSIFIED") {
      await query(
        `update consensus_events set
           stance=$2, confidence=$3, statement_strength=$4, sector=$5, theme=$6, summary_zh=$7,
           direct_stock_symbols=$8::jsonb, inferred_stock_symbols=$9::jsonb,
           extraction_status='CLASSIFIED', extraction_model=$10, updated_at=now()
         where id=$1 and extraction_status <> 'CLASSIFIED'`,
        [eventId, stance, confidence, strength, sector, theme, summaryZh,
         JSON.stringify(directSyms), JSON.stringify(inferredSyms), model],
      );
    }
  } else {
    const inserted = (await query<{ id: string }>(
      `insert into consensus_events
        (person_id, source_id, canonical_event_key, event_at, published_at, event_type, source_url,
         source_title, original_text, summary_zh, language, stance, confidence, statement_strength,
         sector, theme, direct_stock_symbols, inferred_stock_symbols, extraction_status, extraction_model,
         content_hash, extraction_version, needs_review_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23)
       returning id`,
      [input.personId, input.sourceId, key, input.eventAt, input.publishedAt ?? null,
       input.eventType ?? null, input.sourceUrl, input.sourceTitle ?? null, input.rawText.slice(0, 12000),
       summaryZh, input.language ?? "en", stance, confidence, strength, sector, theme,
       JSON.stringify(directSyms), JSON.stringify(inferredSyms), status, model,
       contentHash, extractionVersion, reviewReason],
    ))[0];
    eventId = inserted.id;
  }

  // source references (this URL + any syndication URLs) — dedups on (event_id, url)
  const urls = [input.sourceUrl, ...(input.extraSourceUrls ?? [])];
  for (const u of urls) {
    await query(
      `insert into consensus_event_sources (event_id, source_id, url, source_grade, published_at)
       values ($1,$2,$3,$4,$5) on conflict (event_id, url) do nothing`,
      [eventId, input.sourceId, u, input.sourceGrade, input.publishedAt ?? null],
    );
  }

  let directLinks = 0;
  let inferredLinks = 0;
  const unmapped: string[] = [];

  if (c.status === "CLASSIFIED") {
    const rows: Array<{ symbol: string; relation: "DIRECT" | "INFERRED"; company?: string; reason?: string; conf: number }> = [
      ...c.result.direct_mentions.map((d) => ({ symbol: d.symbol, relation: "DIRECT" as const, company: d.company, reason: d.evidence, conf: confidence })),
      ...c.result.inferred_relations.map((r) => ({ symbol: r.symbol, relation: "INFERRED" as const, company: undefined, reason: r.reason, conf: Math.min(0.7, r.confidence) })),
    ];
    for (const r of rows) {
      const resolved = await resolveSymbol(r.symbol, { companyHint: r.company ?? null, countryHint: input.personCountry });
      if (!resolved.stockId) unmapped.push(r.symbol);
      await query(
        `insert into consensus_stock_links (event_id, stock_id, symbol, exchange, relation_type, stance, confidence, reason)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (event_id, symbol, relation_type) do update set
           stock_id=excluded.stock_id, exchange=excluded.exchange, stance=excluded.stance,
           confidence=excluded.confidence, reason=excluded.reason`,
        [eventId, resolved.stockId, resolved.symbol, resolved.exchange, r.relation, stance, r.conf, r.reason ?? null],
      );
      if (r.relation === "DIRECT") directLinks++; else inferredLinks++;
    }
  }

  return { eventId, canonicalEventKey: key, deduped, status, directLinks, inferredLinks, unmappedSymbols: unmapped };
}
