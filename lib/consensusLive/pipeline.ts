// Orchestrates the whole V1 "最新觀點" line: fetch -> extract/qualify -> merge same-event -> sort.
// Stateless — every call re-fetches the live feed; nothing is cached or persisted.
import { fetchLatestLiveFeed } from "./fetchFeed";
import { extractOpinion } from "./extract";
import { mergeIntoCards } from "./merge";
import type { LiveOpinionCard, TopicType } from "./types";

export async function buildLiveOpinionCards(opts: { channel?: string; windowSize?: number } = {}): Promise<{
  cards: LiveOpinionCard[];
  totalFetched: number;
  qualifiedCount: number;
}> {
  const items = await fetchLatestLiveFeed({ channel: opts.channel, limit: opts.windowSize ?? 30 });
  const extracted = await Promise.all(items.map((item) => extractOpinion(item)));
  const qualifiedCount = extracted.filter((e) => e.qualifies).length;
  const cards = await mergeIntoCards(extracted);
  return { cards, totalFetched: items.length, qualifiedCount };
}

export function filterByType(cards: LiveOpinionCard[], type: TopicType | "ALL"): LiveOpinionCard[] {
  if (type === "ALL") return cards;
  return cards.filter((c) => c.topicType === type);
}
