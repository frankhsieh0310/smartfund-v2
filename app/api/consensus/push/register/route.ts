// SmartMatch 共識雷達 — push registration (Phase 8). No auth: keyed by an anonymous installation_id
// the App generates once and keeps. Never logs the push token.
//
//   POST /api/consensus/push/register
//     { installation_id, platform?, push_token?, owner_user_id?, notifications_enabled?,
//       preferences?: {flip?:bool, warming?:bool, watchlist_only?:bool}, symbols?: string[] }

import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
export function OPTIONS() {
  return new Response(null, { status: 204, headers: cors });
}

const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...p);
const normSym = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9.]/g, "");

export async function POST(request: Request) {
  let b: Record<string, unknown>;
  try { b = (await request.json()) as Record<string, unknown>; }
  catch { return Response.json({ ok: false, error: "bad json" }, { status: 400, headers: cors }); }

  const installationId = String(b.installation_id ?? "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(installationId))
    return Response.json({ ok: false, error: "invalid installation_id" }, { status: 400, headers: cors });

  const platform = ["ios", "android", "web"].includes(String(b.platform)) ? String(b.platform) : "unknown";
  const pushToken = b.push_token ? String(b.push_token).slice(0, 512) : null;
  const enabled = b.notifications_enabled == null ? Boolean(pushToken) : Boolean(b.notifications_enabled);
  const ownerUserId = b.owner_user_id ? String(b.owner_user_id) : null;
  const prefsIn = (b.preferences ?? {}) as Record<string, unknown>;
  const preferences = {
    flip: prefsIn.flip == null ? true : Boolean(prefsIn.flip),
    warming: Boolean(prefsIn.warming),
    watchlist_only: prefsIn.watchlist_only == null ? true : Boolean(prefsIn.watchlist_only),
  };
  const symbols = Array.isArray(b.symbols) ? [...new Set((b.symbols as unknown[]).map((s) => normSym(String(s))).filter(Boolean))].slice(0, 100) : null;

  await q(
    `insert into consensus_push_installations
       (installation_id, owner_user_id, platform, push_token, notifications_enabled, invalid_token, preferences, updated_at, last_seen_at)
     values ($1,$2,$3,$4,$5,false,$6::jsonb, now(), now())
     on conflict (installation_id) do update set
       owner_user_id = coalesce(excluded.owner_user_id, consensus_push_installations.owner_user_id),
       platform = excluded.platform,
       push_token = coalesce(excluded.push_token, consensus_push_installations.push_token),
       notifications_enabled = excluded.notifications_enabled,
       invalid_token = case when excluded.push_token is not null and excluded.push_token <> coalesce(consensus_push_installations.push_token,'')
                            then false else consensus_push_installations.invalid_token end,
       preferences = excluded.preferences,
       updated_at = now(), last_seen_at = now()`,
    installationId, ownerUserId, platform, pushToken, enabled, JSON.stringify(preferences),
  );

  if (symbols) {
    // replace the subscription set for this installation
    await q(`update consensus_push_symbol_subscriptions set is_active = false, updated_at = now() where installation_id = $1`, installationId);
    for (const sym of symbols) {
      await q(
        `insert into consensus_push_symbol_subscriptions (installation_id, symbol, is_active, updated_at)
         values ($1,$2,true, now())
         on conflict (installation_id, symbol) do update set is_active = true, updated_at = now()`,
        installationId, sym,
      );
    }
  }

  const counts = (await q<{ subs: number }>(
    `select count(*)::int subs from consensus_push_symbol_subscriptions where installation_id = $1 and is_active`,
    installationId,
  )) as unknown as Array<{ subs: number }>;

  return Response.json(
    { ok: true, installation_id: installationId, notifications_enabled: enabled, preferences,
      symbol_subscriptions: Number(counts[0]?.subs ?? 0), has_token: Boolean(pushToken) },
    { headers: cors },
  );
}
