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
  const installation = (await q<{ notifications_enabled: boolean; preferences: Record<string, unknown>; subscriptions: number }>(
    `select i.notifications_enabled,i.preferences,(select count(*)::int from consensus_push_symbol_subscriptions s where s.installation_id=i.installation_id and s.is_active) subscriptions
     from consensus_push_installations i where i.installation_id=$1`, installationId))[0];
  const owner=typeof installation?.preferences?.verified_owner_user_id==='string'?installation.preferences.verified_owner_user_id:null;
  const alertRules=owner ? (await q<{c:number}>("select count(*)::int c from alert_rules_p0 where owner_user_id=$1 and status in ('ACTIVE','COOLDOWN','TRIGGERED','PAUSED')",owner))[0]?.c??0:0;
  const configured = Boolean(alertRules>0 || (installation?.notifications_enabled &&
    (installation.preferences?.watchlist_only === false || installation.subscriptions > 0 || (Array.isArray(installation.preferences?.people)&&installation.preferences.people.length>0))));

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
  const alerts=owner ? await q<{id:string;asset_type:string;canonical_asset_id:string;trigger_value:string|null;threshold_value:string|null;triggered_at:string;acknowledged_at:string|null}>(
    `select a.id,a.asset_type,a.canonical_asset_id,a.trigger_value::text,a.threshold_value::text,a.triggered_at,a.acknowledged_at
     from alert_occurrences a join alert_rules_p0 r on r.id=a.rule_id where r.owner_user_id=$1
     ${unreadOnly?'and a.acknowledged_at is null':''} order by a.triggered_at desc limit $2`,owner,limit):[];
  const alertUnread=owner ? (await q<{c:number}>('select count(*)::int c from alert_occurrences a join alert_rules_p0 r on r.id=a.rule_id where r.owner_user_id=$1 and a.acknowledged_at is null',owner))[0]?.c??0:0;

  return Response.json(
    {
      ok: true,
      configured,
      installation_id: installationId,
      unread_count: Number(unread)+Number(alertUnread),
      notifications: [...rows.map((r) => ({
        id: String(r.id), category: String(r.category), symbol: String(r.symbol),
        title: String(r.title), body: String(r.body),
        route: r.route ?? {}, flip_signal_id: (r.flip_signal_id as string) ?? null,
        is_read: Boolean(r.is_read),
        created_at: r.created_at ? new Date(r.created_at as string).toISOString() : null,
      })),...alerts.map(a=>({id:`alert:${a.id}`,category:'ASSET_ALERT',symbol:a.canonical_asset_id,
        title:`${a.asset_type==='FUND'?'基金淨值':a.asset_type==='ETF'?'ETF':'股票'}關注條件已符合`,
        body:`${a.canonical_asset_id}｜觸發值 ${a.trigger_value??'未提供'}｜設定值 ${a.threshold_value??'未提供'}`,
        route:{screen:'notifications'},flip_signal_id:null,is_read:a.acknowledged_at!=null,
        created_at:new Date(a.triggered_at).toISOString()}))].sort((a,b)=>String(b.created_at??'').localeCompare(String(a.created_at??''))).slice(0,limit),
    },
    { headers: { ...cors, "Cache-Control": "no-store" } },
  );
}
