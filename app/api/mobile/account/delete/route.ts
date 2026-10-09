// SmartMatch Mobile account deletion. Apple Guideline 5.1.1(v): an app that supports account
// creation must offer in-app account deletion that actually removes the account, not just signs
// the user out or disables it.
//
// Two-step delete, scoped strictly to the authenticated caller's own identity:
// 1. Delete the local SmartMatch User row (prisma.user.delete). Every owned relation (portfolios,
//    alerts, favorites, notifications, saved filters, etc.) cascades via onDelete: Cascade in the
//    schema, except WatchlistMembershipEvent.actorUserId (onDelete: Restrict, a pure audit trail of
//    actions this user took on possibly-shared watchlists) — those rows are deleted explicitly
//    first so the cascade isn't blocked.
// 2. Delete the Supabase Auth user via the Admin API, which requires the service-role key — kept
//    server-side only, never shipped to the mobile client. If that key isn't configured, the
//    endpoint fails loudly (never silently "succeeds" while leaving the Auth account intact).
import { getAuthenticatedSupabaseUser } from "@/lib/auth/supabaseAuth";
import { resolveSmartMatchUser } from "@/lib/auth/userService";
import { prisma } from "@/lib/prisma";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

export async function POST(request: Request) {
  const identity = await getAuthenticatedSupabaseUser(request);
  if (!identity) {
    return Response.json({ data: null, error: { message: "Authentication required." } }, { status: 401, headers });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return Response.json(
      { data: null, error: { message: "Account deletion is not configured on the server." } },
      { status: 500, headers },
    );
  }

  try {
    const account = await resolveSmartMatchUser(identity);
    await prisma.watchlistMembershipEvent.deleteMany({ where: { actorUserId: account.id } });
    await prisma.user.delete({ where: { id: account.id } });
  } catch (error) {
    return Response.json(
      { data: null, error: { message: "Unable to delete SmartMatch account data." } },
      { status: 500, headers },
    );
  }

  const admin = createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await admin.auth.admin.deleteUser(identity.id);
  if (error) {
    // Local data is already gone at this point — surface this as a partial failure so the client
    // never reports success while the Supabase Auth account still exists.
    return Response.json(
      { data: null, error: { message: `SmartMatch data deleted, but Auth account removal failed: ${error.message}` } },
      { status: 500, headers },
    );
  }

  return Response.json({ data: { deleted: true }, error: null }, { status: 200, headers });
}
