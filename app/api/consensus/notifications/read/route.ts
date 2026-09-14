// Mark consensus in-app notifications read.  POST { installation_id, ids?: string[], all?: true }

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}
const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p);

export async function POST(request: Request) {
  let b: Record<string, unknown>;
  try { b = (await request.json()) as Record<string, unknown>; }
  catch { return Response.json({ ok: false, error: "bad json" }, { status: 400, headers: cors }); }
  const installationId = String(b.installation_id ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(installationId))
    return Response.json({ ok: false, error: "invalid installation_id" }, { status: 400, headers: cors });

  if (b.all) {
    await q(`update consensus_inapp_notifications set is_read = true, read_at = now() where installation_id = $1 and not is_read`, installationId);
  } else {
    const ids = Array.isArray(b.ids) ? (b.ids as unknown[]).map(String).slice(0, 200) : [];
    if (ids.length === 0) return Response.json({ ok: false, error: "ids or all required" }, { status: 400, headers: cors });
    await q(`update consensus_inapp_notifications set is_read = true, read_at = now() where installation_id = $1 and id = any($2)`, installationId, ids);
  }
  const unread = (await q<{ c: number }>(
    `select count(*)::int c from consensus_inapp_notifications where installation_id = $1 and not is_read`, installationId,
  )) as unknown as Array<{ c: number }>;
  return Response.json({ ok: true, unread_count: Number(unread[0]?.c ?? 0) }, { headers: cors });
}
