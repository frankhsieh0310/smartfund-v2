// Background ingest for consensusLive. Fetches ONE bounded window of the live feed, extracts ONLY
// items never seen before (the dedupe ledger in consensus_live_source_items is the source of truth
// — "0 new items" is the overwhelmingly common case and must cost exactly 0 AI calls), and
// creates/updates merged cards in consensus_live_cards. No polling, no retry loop: one pass, return.
import { fetchLatestLiveFeed } from "./fetchFeed";
import { extractOpinion, synthesizeMergedCard } from "./extract";
import { ensureConsensusLiveSchema } from "./schema";
import {
  createCard, filterUnseenIds, findMergeCandidateCard, loadCardMembers,
  readPersistedCards, recordProcessedItem, updateCard,
} from "./store";
import type { ExtractedOpinion, LiveOpinionCard, QueryFn } from "./types";

export type IngestResult = {
  fetched: number;
  newItems: number;
  aiCallCount: number;
  qualifiedCount: number;
  cardsCreated: number;
  cardsUpdated: number;
};

export async function runConsensusLiveIngest(query: QueryFn, opts: { channel?: string; windowSize?: number } = {}): Promise<IngestResult> {
  await ensureConsensusLiveSchema(query);

  const items = await fetchLatestLiveFeed({ channel: opts.channel, limit: opts.windowSize ?? 30 });
  const unseenIds = await filterUnseenIds(query, items.map((i) => i.id));

  if (unseenIds.size === 0) {
    return { fetched: items.length, newItems: 0, aiCallCount: 0, qualifiedCount: 0, cardsCreated: 0, cardsUpdated: 0 };
  }

  const unseen = items.filter((i) => unseenIds.has(i.id));
  let qualifiedCount = 0, cardsCreated = 0, cardsUpdated = 0;

  for (const item of unseen) {
    // Exactly one extraction call per never-before-seen source item id — this loop body runs once
    // per id for the lifetime of that id, enforced by filterUnseenIds reading the ledger above.
    const extracted: ExtractedOpinion = await extractOpinion(item);

    if (!extracted.qualifies || !extracted.speakerName || !extracted.organization || !extracted.topicType) {
      await recordProcessedItem(query, extracted, null);
      continue;
    }
    qualifiedCount++;

    const publishedAtIso = new Date(item.display_time * 1000).toISOString();
    const candidate = await findMergeCandidateCard(query, {
      speakerName: extracted.speakerName, organization: extracted.organization,
      topicType: extracted.topicType, topicName: extracted.topicName ?? "", publishedAtIso,
    });

    if (!candidate) {
      const card: LiveOpinionCard = {
        id: `live-${item.id}`,
        speakerName: extracted.speakerName, organization: extracted.organization, role: extracted.role,
        topicType: extracted.topicType, topicName: extracted.topicName ?? "", ticker: extracted.ticker,
        stance: extracted.stance ?? "UNCLEAR", summaryZh: extracted.summaryZh ?? "", reasonZh: extracted.reasonZh ?? "",
        viewChanged: extracted.viewChanged, publishedAt: publishedAtIso, sourceLabel: "華爾街見聞",
        sourceUrls: [item.uri], sourceItemCount: 1,
      };
      await createCard(query, card);
      await recordProcessedItem(query, extracted, card.id);
      cardsCreated++;
      continue;
    }

    // Same event, already has a card from an earlier window (or earlier in this same window) —
    // re-run the merge judgment over ALL members (existing + this new one), never "latest wins".
    const priorMembers = await loadCardMembers(query, candidate.id);
    const allMembers = [...priorMembers, extracted];
    const merged = await synthesizeMergedCard(allMembers);
    const sortedByTime = allMembers.slice().sort((a, b) => b.sourceItem.display_time - a.sourceItem.display_time);
    await updateCard(query, candidate.id, {
      topicName: merged.topicName || extracted.topicName || "",
      stance: merged.stance ?? "UNCLEAR",
      summaryZh: merged.summaryZh,
      reasonZh: merged.reasonZh,
      viewChanged: allMembers.some((m) => m.viewChanged),
      publishedAt: new Date(sortedByTime[0].sourceItem.display_time * 1000).toISOString(),
      sourceUrls: allMembers.map((m) => m.sourceItem.uri),
      sourceItemCount: allMembers.length,
    });
    await recordProcessedItem(query, extracted, candidate.id);
    cardsUpdated++;
  }

  return { fetched: items.length, newItems: unseen.length, aiCallCount: unseen.length, qualifiedCount, cardsCreated, cardsUpdated };
}

export async function getLiveCards(query: QueryFn, opts: { type: Parameters<typeof readPersistedCards>[1]["type"]; limit: number }) {
  return readPersistedCards(query, opts);
}
