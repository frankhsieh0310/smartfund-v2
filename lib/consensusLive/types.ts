// 大佬雷達 V1 — "最新觀點" live data line. Deliberately independent of the old consensus_events /
// AI-Gateway-classifier / aggregate-flip-performance pipeline: no DB table, no backfill, no ranking.
// Each API call fetches the current WallStreetCN live feed fresh, qualifies + extracts + merges
// same-event items in memory, and returns cards. Nothing here is persisted.

export type TopicType = "STOCK" | "INDUSTRY" | "COMMODITY" | "MACRO" | "OTHER";
export type Stance = "POSITIVE" | "NEUTRAL" | "NEGATIVE" | "UNCLEAR";

// Raw WallStreetCN live-feed item (same shape as app/api/cron/consensus-wallstreetcn/route.ts's
// WscnItem — duplicated here deliberately so this module has zero dependency on the old pipeline).
export type RawFeedItem = {
  id: number;
  title: string;
  content_text: string;
  display_time: number; // unix seconds
  score: number;
  channels: string[];
  symbols: string[];
  uri: string;
};

// One item's extraction result (before merge). `qualifies=false` means it failed the QUALIFY gate
// (no named person/org, or no clear market/industry/commodity/macro opinion) and is dropped.
export type ExtractedOpinion = {
  qualifies: boolean;
  sourceItem: RawFeedItem;
  speakerName: string | null;
  organization: string | null;
  role: string | null;
  topicType: TopicType | null;
  topicName: string | null;
  ticker: string | null;
  stance: Stance | null;
  summaryZh: string | null;
  reasonZh: string | null;
  viewChanged: boolean;
};

// Final App-facing card DTO (post same-event merge). One event/interview = one card, even when
// WallStreetCN split it into several live-feed items.
export type QueryFn = <T = Record<string, unknown>>(sql: string, params: unknown[]) => Promise<T[]>;

export type LiveOpinionCard = {
  id: string;
  speakerName: string;
  organization: string;
  role: string | null;
  topicType: TopicType;
  topicName: string;
  ticker: string | null;
  stance: Stance;
  summaryZh: string;
  reasonZh: string;
  viewChanged: boolean;
  publishedAt: string; // ISO, latest member item's time
  sourceLabel: "華爾街見聞";
  sourceUrls: string[];
  sourceItemCount: number;
};
