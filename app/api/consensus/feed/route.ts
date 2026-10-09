// Function 3 (大佬觀點・共識雷達) — read API over consensus_feed_items (WallStreetCN score>=2 items).
// Never fabricates a stance/direction that the source didn't state.
import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

const TECH_TICKERS = new Set(["NVDA", "AAPL", "MSFT", "GOOGL", "GOOG", "META", "TSM", "2330", "AMD", "AVGO", "MU", "INTC", "QCOM"]);

// Category labels derived from WallStreetCN's own `channel` tags (never invented) plus a ticker-based
// TECH heuristic (the source has no dedicated tech channel). A-share/Taiwan coverage on this source is
// predominantly mainland-China A-share news — labelled honestly as such, not claimed to be Taiwan-specific.
function categoriesOf(channel: string[], relatedTickers: string[]): string[] {
  const cats = new Set<string>();
  if (channel.includes("us-stock-channel")) cats.add("US");
  if (channel.includes("a-stock-channel")) cats.add("TW_A");
  if (channel.includes("forex-channel")) cats.add("FX");
  if (channel.some((c) => ["oil-channel", "commodity-channel", "goldc-channel"].includes(c))) cats.add("COMMODITY");
  if (channel.some((c) => ["global-channel", "internal", "bond-channel", "financing-channel"].includes(c))) cats.add("MACRO");
  if (relatedTickers.some((t) => TECH_TICKERS.has(t.toUpperCase()))) cats.add("TECH");
  return [...cats];
}

type FeedRow = {
  id: string; published_at: string; title: string; content: string; score: number; channel: string[];
  source_url: string; item_type: string; person_slug: string | null; person_display_name: string | null;
  related_tickers: string[]; related_companies: string[]; stance: string | null;
};

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const tab = q.get("tab") ?? "important";
  const category = q.get("category"); // US | TW_A | FX | COMMODITY | MACRO | TECH
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? 30)));

  if (tab === "important" || tab === "person") {
    const rows = await prisma.$queryRawUnsafe<FeedRow[]>(
      `SELECT id, published_at::text, title, content, score, channel, source_url, item_type,
              person_slug, person_display_name, related_tickers, related_companies, stance
         FROM consensus_feed_items
        WHERE ($1::text IS NULL OR item_type = $1)
        ORDER BY published_at DESC LIMIT $2`,
      tab === "person" ? "PERSON_VIEWPOINT" : null,
      limit,
    );
    const filtered = category
      ? rows.filter((r) => categoriesOf(r.channel, r.related_tickers).includes(category))
      : rows;
    return Response.json({
      tab, category: category ?? null,
      data: filtered.map((r) => ({
        id: r.id, publishedAt: r.published_at, title: r.title, content: r.content, score: r.score,
        channel: r.channel, categories: categoriesOf(r.channel, r.related_tickers), sourceUrl: r.source_url,
        sourceId: r.id, itemType: r.item_type, person: r.person_display_name,
        relatedTickers: r.related_tickers, relatedCompanies: r.related_companies.filter(Boolean),
        statement: r.item_type === "PERSON_VIEWPOINT" ? r.content : null,
        stance: r.stance ?? "未明確表態",
      })),
    }, { headers });
  }

  if (tab === "consensus") {
    // Real people who talked about the same ticker within the last 30 days, grouped — never a
    // fabricated BUY/SELL; direction is only ever "未明確表態" since this source gives no explicit stance.
    const rows = await prisma.$queryRawUnsafe<Array<{
      ticker: string; company: string | null; people_count: bigint; item_count: bigint;
      persons: string[]; latest_at: string;
    }>>(
      `SELECT t.ticker, MAX(f.related_companies[array_position(f.related_tickers, t.ticker)]) AS company,
              COUNT(DISTINCT f.person_slug) FILTER (WHERE f.person_slug IS NOT NULL) AS people_count,
              COUNT(*) AS item_count,
              array_agg(DISTINCT f.person_display_name) FILTER (WHERE f.person_display_name IS NOT NULL) AS persons,
              MAX(f.published_at)::text AS latest_at
         FROM consensus_feed_items f, unnest(f.related_tickers) AS t(ticker)
        WHERE f.item_type = 'PERSON_VIEWPOINT' AND f.published_at > now() - interval '30 days'
        GROUP BY t.ticker
        HAVING COUNT(DISTINCT f.person_slug) >= 1
        ORDER BY people_count DESC, item_count DESC LIMIT $1`,
      limit,
    );
    return Response.json({
      tab: "consensus",
      data: rows.map((r) => ({
        ticker: r.ticker, company: r.company, peopleCount: Number(r.people_count),
        itemCount: Number(r.item_count), persons: r.persons, latestAt: r.latest_at,
        direction: "未明確表態",
      })),
    }, { headers });
  }

  if (tab === "changes") {
    // 觀點變化 — for each person with >=2 stored items, show their latest vs previous item (topic
    // change over time). Never claims a direction flip the source didn't state.
    const rows = await prisma.$queryRawUnsafe<Array<{
      person_display_name: string; latest_title: string; latest_at: string; latest_ticker: string[];
      previous_title: string; previous_at: string; previous_ticker: string[];
    }>>(
      `WITH ranked AS (
         SELECT person_display_name, title, published_at, related_tickers,
                ROW_NUMBER() OVER (PARTITION BY person_slug ORDER BY published_at DESC) AS rn
           FROM consensus_feed_items WHERE item_type = 'PERSON_VIEWPOINT' AND person_slug IS NOT NULL
       )
       SELECT a.person_display_name, a.title AS latest_title, a.published_at::text AS latest_at, a.related_tickers AS latest_ticker,
              b.title AS previous_title, b.published_at::text AS previous_at, b.related_tickers AS previous_ticker
         FROM ranked a JOIN ranked b ON a.person_display_name = b.person_display_name AND b.rn = a.rn + 1
        WHERE a.rn = 1
        ORDER BY a.published_at DESC LIMIT $1`,
      limit,
    );
    return Response.json({ tab: "changes", data: rows }, { headers });
  }

  return Response.json({ error: "unknown tab" }, { status: 400, headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
