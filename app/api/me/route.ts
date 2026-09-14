import {
  AuthenticatedUserConflictError,
  getAccountForRequest,
} from "@/lib/auth/userService";

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
