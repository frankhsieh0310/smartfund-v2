// SmartMatch 共識雷達 — push unregister (Phase 8). Disables all consensus push for an installation.
//   POST /api/consensus/push/unregister  { installation_id }

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

  await q(
    `update consensus_push_installations
        set notifications_enabled = false, push_token = null, updated_at = now(), last_seen_at = now()
      where installation_id = $1`,
    installationId,
  );
  await q(`update consensus_push_symbol_subscriptions set is_active = false, updated_at = now() where installation_id = $1`, installationId);

  return Response.json({ ok: true, installation_id: installationId, notifications_enabled: false }, { headers: cors });
}
