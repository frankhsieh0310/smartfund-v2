// SmartMatch 共識雷達 — in-app notification center feed (Phase 8). Anonymous, keyed by installation_id.
//   GET  /api/consensus/notifications?installation_id=&unread=1&limit=50   -> list + unread_count
//   POST /api/consensus/notifications/read  { installation_id, ids?: [], all?: true }   (see ./read/route.ts)

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}
const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p);

export async function GET(request: Request) {
  const u = new URL(request.url);
  const installationId = String(u.searchParams.get("installation_id") ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(installationId))
    return Response.json({ ok: false, error: "invalid installation_id" }, { status: 400, headers: cors });
  const unreadOnly = u.searchParams.get("unread") === "1";
  const limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit")) || 50));

  const rows = await q<Record<string, unknown>>(
    `select id, category, symbol, title, body, route, flip_signal_id, is_read, created_at
       from consensus_inapp_notifications
      where installation_id = $1 ${unreadOnly ? "and not is_read" : ""}
      order by created_at desc
      limit ${limit}`,
    installationId,
  );
  const unread = (await q<{ c: number }>(
    `select count(*)::int c from consensus_inapp_notifications where installation_id = $1 and not is_read`,
    installationId,
  ))[0]?.c ?? 0;

  return Response.json(
    {
      ok: true,
      installation_id: installationId,
      unread_count: Number(unread),
      notifications: rows.map((r) => ({
        id: String(r.id), category: String(r.category), symbol: String(r.symbol),
        title: String(r.title), body: String(r.body),
        route: r.route ?? {}, flip_signal_id: (r.flip_signal_id as string) ?? null,
        is_read: Boolean(r.is_read),
        created_at: r.created_at ? new Date(r.created_at as string).toISOString() : null,
      })),
    },
    { headers: { ...cors, "Cache-Control": "no-store" } },
  );
}
