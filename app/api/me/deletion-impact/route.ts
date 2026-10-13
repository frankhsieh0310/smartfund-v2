// Read-only preview of what DELETE /api/me will affect, for the app to show a confirmation screen
// before the user commits to deleting their account.

import { getAccountForRequest } from "@/lib/auth/userService";
import { describeAccountDeletionImpact } from "@/lib/accountDeletion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const account = await getAccountForRequest(request);
  if (!account) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const impact = await describeAccountDeletionImpact(account.id);
  return Response.json(impact, { headers: { "Cache-Control": "no-store" } });
}
