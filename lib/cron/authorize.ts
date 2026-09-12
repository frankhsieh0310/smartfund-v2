export function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export function unauthorizedCron(): Response {
  return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}
