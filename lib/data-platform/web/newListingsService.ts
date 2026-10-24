// Shared by app/api/mobile/new-listings/route.ts and app/new-listings/page.tsx (the web page reads
// this directly instead of HTTP-fetching its own API route -- a Preview deployment's Deployment
// Protection blocks even a same-deployment server-side self-fetch, which is what the page's first
// version hit: VERIFIED live, HTTP 500 on Preview from that self-fetch, 200 when querying directly
// like every other server component page in this app already does).
import { prisma } from "@/lib/prisma";

export type ListingEvent = {
  code: string;
  name: string;
  listed_date: string | null;
  source: string;
  source_url: string | null;
  detail_available: boolean;
  product_id: string | null;
};

export async function getNewListingEvents(days = 30): Promise<{ upcoming: ListingEvent[]; recent: ListingEvent[]; window_days: number; generated_at: string }> {
  const boundedDays = Math.max(1, Math.min(90, days));
  const cutoff = new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  const events = await prisma.$queryRawUnsafe<
    { code: string; name: string; milestone_date: Date | null; source: string; source_url: string | null; product_id: string | null }[]
  >(
    `SELECT code, name, milestone_date, source, source_url, product_id
     FROM product_listing_events
     WHERE event_type = 'NEW_LISTING' AND (milestone_date IS NULL OR milestone_date >= $1)
     ORDER BY milestone_date DESC NULLS FIRST`,
    cutoff,
  );

  const shape = (e: (typeof events)[number]): ListingEvent => ({
    code: e.code,
    name: e.name,
    listed_date: e.milestone_date ? e.milestone_date.toISOString().slice(0, 10) : null,
    source: e.source,
    source_url: e.source_url,
    detail_available: Boolean(e.product_id),
    product_id: e.product_id,
  });

  return {
    upcoming: events.filter((e) => e.milestone_date && e.milestone_date > now).map(shape),
    recent: events.filter((e) => !e.milestone_date || e.milestone_date <= now).map(shape),
    window_days: boundedDays,
    generated_at: new Date().toISOString(),
  };
}
