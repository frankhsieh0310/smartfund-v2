// 新商品上架 (App section). Reads ONLY from product_listing_events, which is populated solely by
// lib/cron/newListingDetection.ts from the official TWSE/TPEx feed — never estimated. Two zones:
//   - upcoming: NEW_LISTING events whose milestone_date (上市日期) is still in the future
//     (申報生效/募集中/成立但未掛牌) — i.e. detected via 成立日期 already passed but not yet listed.
//   - recent: NEW_LISTING events listed within the last `days` (default 30, query param ?days=N).
// product_id is null until the brand-provider auto-match resolves it (see newListingDetection.ts);
// such rows link to the official source only, not to a product detail page, until resolved.
import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days")) || 30));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
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

  const upcoming = events.filter((e) => e.milestone_date && e.milestone_date > now);
  const recent = events.filter((e) => !e.milestone_date || e.milestone_date <= now);

  const shape = (e: (typeof events)[number]) => ({
    code: e.code,
    name: e.name,
    listed_date: e.milestone_date ? e.milestone_date.toISOString().slice(0, 10) : null,
    source: e.source,
    source_url: e.source_url,
    detail_available: Boolean(e.product_id),
    product_id: e.product_id,
  });

  return Response.json(
    { upcoming: upcoming.map(shape), recent: recent.map(shape), window_days: days, generated_at: new Date().toISOString() },
    { headers },
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
