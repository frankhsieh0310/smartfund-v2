import {
  AuthenticatedUserConflictError,
  getAccountForRequest,
} from "@/lib/auth/userService";
import { getAuthenticatedSupabaseUser } from "@/lib/auth/supabaseAuth";
import { createSupabaseAdminClient } from "@/lib/auth/supabaseAdmin";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request) {
  try {
    const account = await getAccountForRequest(request);

    if (!account) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    return Response.json(account, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof AuthenticatedUserConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }

    console.error("GET /api/me failed", error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

// Account deletion. Deletes the Supabase auth identity first (via the admin API -- requires
// SUPABASE_SERVICE_ROLE_KEY; VERIFIED set on Production via `vercel env ls` as of 2026-10-16, so
// this route no longer 500s for that reason), then our own `User` row. Most of User's relations
// (watchlists, portfolios, push devices, alerts, etc. -- see prisma/schema.prisma) already carry
// `onDelete: Cascade`, so deleting the User row cleans those up at the DB level. A few relations
// are optional (`userId String?`, no cascade) -- deleting those rows' user reference is NOT
// separately handled here; not exhaustively audited this round, disclosed as a known gap.
export async function DELETE(request: Request) {
  const identity = await getAuthenticatedSupabaseUser(request);
  if (!identity) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const dbUser = await prisma.user.findUnique({ where: { supabaseId: identity.id } });

  try {
    const admin = createSupabaseAdminClient();
    const { error } = await admin.auth.admin.deleteUser(identity.id);
    if (error) throw error;
  } catch (error) {
    console.error("DELETE /api/me: failed to delete Supabase auth identity", error);
    return Response.json({ error: "Failed to delete account (auth identity)" }, { status: 500 });
  }

  if (dbUser) {
    try {
      await prisma.user.delete({ where: { id: dbUser.id } });
    } catch (error) {
      // Auth identity is already gone at this point -- the user can no longer sign in, but our
      // own row/data survived. Logged loudly since this is a partial-failure state worth noticing.
      console.error("DELETE /api/me: Supabase identity deleted but DB user row delete failed", error);
      return Response.json({ error: "Account sign-in removed, but some data cleanup failed" }, { status: 500 });
    }
  }

  // Not a 204: the shared mobile API client always parses the response body as JSON, which
  // throws on an empty 204 body.
  return Response.json({ ok: true });
}
