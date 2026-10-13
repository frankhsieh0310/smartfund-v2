import {
  AuthenticatedUserConflictError,
  getAccountForRequest,
} from "@/lib/auth/userService";
import { deleteOwnAccount, ForumContentBlocksAccountDeletionError } from "@/lib/accountDeletion";

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

/**
 * Deletes the caller's entire SmartMatch account (Apple App Store Review Guideline 5.1.1(v)).
 * Does NOT cancel any Apple/Google subscription -- the client must tell the user to cancel it
 * themselves in the App Store/Play Store before calling this, and that deleting the account will
 * not stop billing on its own.
 */
export async function DELETE(request: Request) {
  try {
    const account = await getAccountForRequest(request);
    if (!account) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await deleteOwnAccount(account.id);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ForumContentBlocksAccountDeletionError) {
      return Response.json({ error: error.message }, { status: 409 });
    }

    console.error("DELETE /api/me failed", error);
    return Response.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
