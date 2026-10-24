// 新商品上架 (App section). Reads ONLY from product_listing_events, which is populated solely by
// lib/cron/newListingDetection.ts from the official TWSE/TPEx feed — never estimated. Two zones:
//   - upcoming: NEW_LISTING events whose milestone_date (上市日期) is still in the future
//     (申報生效/募集中/成立但未掛牌) — i.e. detected via 成立日期 already passed but not yet listed.
//   - recent: NEW_LISTING events listed within the last `days` (default 30, query param ?days=N).
// product_id is null until the brand-provider auto-match resolves it (see newListingDetection.ts);
// such rows link to the official source only, not to a product detail page, until resolved.
//
// 2026-10-24: query logic moved to lib/data-platform/web/newListingsService.ts so
// app/new-listings/page.tsx can call it directly instead of HTTP-fetching this route.
import { getNewListingEvents } from "@/lib/data-platform/web/newListingsService";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const days = Number(url.searchParams.get("days")) || 30;
  const data = await getNewListingEvents(days);
  return Response.json(data, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
