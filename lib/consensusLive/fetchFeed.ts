// Fetches the CURRENT WallStreetCN live feed directly from their public endpoint — never reads
// consensus_feed_items (the old pipeline's DB table, confirmed stale since 2026-09-26). Same
// endpoint contract as app/api/cron/consensus-wallstreetcn/route.ts, duplicated deliberately to
// keep this module independent.
import type { RawFeedItem } from "./types";

const WSCN_BASE = "https://api-one-wscn.awtmt.com/apiv1/content/lives";

export async function fetchLatestLiveFeed(opts: { channel?: string; limit?: number } = {}): Promise<RawFeedItem[]> {
  const channel = opts.channel ?? "global-channel";
  const limit = Math.min(50, Math.max(1, opts.limit ?? 30));
  const url = `${WSCN_BASE}?channel=${encodeURIComponent(channel)}&client=pc&limit=${limit}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`WSCN_HTTP_${r.status}`);
  const j = await r.json();
  if (j.code !== 20000) throw new Error(`WSCN_API_ERROR_${j.code}_${j.message}`);
  const items = (j.data?.items ?? []) as RawFeedItem[];
  // dedupe by item id (WallStreetCN's own primary key) — belt-and-suspenders, the feed itself
  // shouldn't repeat an id within one page, but never trust that silently.
  const seen = new Set<number>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}
