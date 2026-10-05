// DB access for consensusLive. All writes are additive/idempotent upserts into the two tables
// defined in schema.ts — never touches lib/consensus/* (the old pipeline's tables).
import type { ExtractedOpinion, LiveOpinionCard, QueryFn, TopicType } from "./types";
import { normalizeTopicName, topicsOverlap } from "./topicMatch";

export type { QueryFn } from "./types";

// Which of the latest-fetched source item ids have NEVER been processed before (dedupe ledger
// check). A single query against the primary-key index — cheap even at scale.
export async function filterUnseenIds(query: QueryFn, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await query<{ source_item_id: string }>(
    `select source_item_id::text from consensus_live_source_items where source_item_id = any($1)`,
    [ids],
  );
  const seen = new Set(rows.map((r) => Number(r.source_item_id)));
  return new Set(ids.filter((id) => !seen.has(id)));
}

// Marks a source item as processed (qualified or not) and, if it joined a card, records which one.
// Called exactly once per source item, ever — this row's existence IS the dedupe guarantee: a later
// cron window that sees the same id again will find it via filterUnseenIds and skip extraction.
export async function recordProcessedItem(query: QueryFn, o: ExtractedOpinion, cardId: string | null): Promise<void> {
  await query(
    `insert into consensus_live_source_items
       (source_item_id, source_url, published_at, qualified, speaker_name, organization, role,
        topic_type, topic_name, ticker, stance, summary_zh, reason_zh, view_changed, card_id)
     values ($1,$2,$3::timestamptz,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (source_item_id) do nothing`,
    [
      o.sourceItem.id, o.sourceItem.uri, new Date(o.sourceItem.display_time * 1000).toISOString(), o.qualifies,
      o.speakerName, o.organization, o.role, o.topicType, o.topicName, o.ticker, o.stance,
      o.summaryZh, o.reasonZh, o.viewChanged, cardId,
    ],
  );
}

// Finds an existing card this NEW qualifying item could join: same speaker+org (exact, normalized),
// same topicType (auxiliary condition), overlapping topic_name (checked in JS via the same
// longest-common-substring rule merge.ts uses — kept identical via topicMatch.ts so the in-memory
// batch path and this persisted cross-window path can never silently diverge), and whose most recent
// member was published within MERGE_WINDOW_MINUTES of this new item.
const MERGE_WINDOW_MINUTES = 60;

export async function findMergeCandidateCard(
  query: QueryFn,
  o: { speakerName: string; organization: string; topicType: TopicType; topicName: string; publishedAtIso: string },
): Promise<{ id: string } | null> {
  // Candidates narrowed by the cheap, exact/indexable conditions first; topic overlap (not
  // expressible as a simple SQL predicate without a keyword table) is applied in JS below.
  const rows = await query<{ id: string; topic_name: string; published_at: string }>(
    `select id, topic_name, published_at::text from consensus_live_cards
      where lower(trim(speaker_name)) = lower(trim($1))
        and lower(trim(organization)) = lower(trim($2))
        and topic_type = $3
        and abs(extract(epoch from (published_at - $4::timestamptz))) <= $5 * 60
      order by published_at desc`,
    [o.speakerName, o.organization, o.topicType, o.publishedAtIso, MERGE_WINDOW_MINUTES],
  );
  const newTopic = normalizeTopicName(o.topicName);
  const match = rows.find((r) => topicsOverlap(newTopic, normalizeTopicName(r.topic_name)));
  return match ? { id: match.id } : null;
}

// All previously-processed member items for a card (used to fully re-run the merge-AI judgment over
// the cumulative set, not just the newly-arrived item — so a 3rd item joining can correctly flip an
// ambiguous 2-item UNCLEAR into a clear stance, etc.).
export async function loadCardMembers(query: QueryFn, cardId: string): Promise<ExtractedOpinion[]> {
  const rows = await query<{
    source_item_id: string; source_url: string; published_at: string; speaker_name: string | null;
    organization: string | null; role: string | null; topic_type: TopicType | null; topic_name: string | null;
    ticker: string | null; stance: ExtractedOpinion["stance"]; summary_zh: string | null; reason_zh: string | null;
    view_changed: boolean;
  }>(
    `select source_item_id::text, source_url, published_at::text, speaker_name, organization, role,
            topic_type, topic_name, ticker, stance, summary_zh, reason_zh, view_changed
       from consensus_live_source_items where card_id = $1 order by published_at asc`,
    [cardId],
  );
  return rows.map((r) => ({
    qualifies: true,
    sourceItem: { id: Number(r.source_item_id), title: "", content_text: "", display_time: Math.floor(Date.parse(r.published_at) / 1000), score: 0, channels: [], symbols: [], uri: r.source_url },
    speakerName: r.speaker_name, organization: r.organization, role: r.role, topicType: r.topic_type,
    topicName: r.topic_name, ticker: r.ticker, stance: r.stance, summaryZh: r.summary_zh, reasonZh: r.reason_zh,
    viewChanged: r.view_changed,
  }));
}

export async function createCard(query: QueryFn, card: LiveOpinionCard): Promise<void> {
  await query(
    `insert into consensus_live_cards
       (id, speaker_name, organization, role, topic_type, topic_name, ticker, stance, summary_zh,
        reason_zh, view_changed, published_at, source_label, source_urls, source_item_count, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13,$14::jsonb,$15,now())`,
    [
      card.id, card.speakerName, card.organization, card.role, card.topicType, card.topicName, card.ticker,
      card.stance, card.summaryZh, card.reasonZh, card.viewChanged, card.publishedAt, card.sourceLabel,
      JSON.stringify(card.sourceUrls), card.sourceItemCount,
    ],
  );
}

export async function updateCard(query: QueryFn, cardId: string, fields: {
  topicName: string; stance: LiveOpinionCard["stance"]; summaryZh: string; reasonZh: string;
  viewChanged: boolean; publishedAt: string; sourceUrls: string[]; sourceItemCount: number;
}): Promise<void> {
  await query(
    `update consensus_live_cards set
       topic_name = $2, stance = $3, summary_zh = $4, reason_zh = $5, view_changed = $6,
       published_at = $7::timestamptz, source_urls = $8::jsonb, source_item_count = $9, updated_at = now()
     where id = $1`,
    [cardId, fields.topicName, fields.stance, fields.summaryZh, fields.reasonZh, fields.viewChanged,
     fields.publishedAt, JSON.stringify(fields.sourceUrls), fields.sourceItemCount],
  );
}

export async function readPersistedCards(query: QueryFn, opts: { type: TopicType | "ALL"; limit: number }): Promise<LiveOpinionCard[]> {
  const rows = await query<{
    id: string; speaker_name: string; organization: string; role: string | null; topic_type: TopicType;
    topic_name: string; ticker: string | null; stance: LiveOpinionCard["stance"]; summary_zh: string;
    reason_zh: string; view_changed: boolean; published_at: string; source_label: string;
    source_urls: string[]; source_item_count: number;
  }>(
    `select id, speaker_name, organization, role, topic_type, topic_name, ticker, stance, summary_zh,
            reason_zh, view_changed, published_at::text, source_label, source_urls, source_item_count
       from consensus_live_cards
      where ($1::text is null or topic_type = $1)
      order by published_at desc
      limit $2`,
    [opts.type === "ALL" ? null : opts.type, opts.limit],
  );
  return rows.map((r) => ({
    id: r.id, speakerName: r.speaker_name, organization: r.organization, role: r.role,
    topicType: r.topic_type, topicName: r.topic_name, ticker: r.ticker, stance: r.stance,
    summaryZh: r.summary_zh, reasonZh: r.reason_zh, viewChanged: r.view_changed,
    publishedAt: new Date(r.published_at).toISOString(), sourceLabel: "華爾街見聞",
    sourceUrls: r.source_urls, sourceItemCount: r.source_item_count,
  }));
}
