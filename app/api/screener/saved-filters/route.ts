// 選股反查：儲存自訂條件（付費功能，2026-10-24使用者核准定案）。重用既有的SavedFilter模型
// （filters: Json 本來就是為了存任意篩選條件設計的，不新增schema/migration）——存screener的
// query string跟market，不是重新發明一個「screener filter」表。只有trial/paid能存（跟其他
// 付費功能同一套getAccountForRequest().accessTier判斷），免費使用者呼叫一律403。
import { prisma } from "@/lib/prisma";
import { getAccountForRequest } from "@/lib/auth/userService";

const headers = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Cache-Control": "no-store" };
export function OPTIONS() { return new Response(null, { status: 204, headers }); }
const ok = (data: unknown, status = 200) => Response.json({ data, error: null }, { status, headers });
const fail = (message: string, status: number) => Response.json({ data: null, error: { message } }, { status, headers });

async function paidAccount(request: Request) {
  const account = await getAccountForRequest(request);
  if (!account) return { error: fail("Unauthorized", 401) };
  if (account.accessTier === "free") return { error: fail("儲存自訂條件是付費功能，試用期或訂閱後才能使用。", 403) };
  return { account };
}

export async function GET(request: Request) {
  const { account, error } = await paidAccount(request);
  if (error) return error;
  const rows = await prisma.savedFilter.findMany({ where: { userId: account!.id }, orderBy: { createdAt: "desc" } });
  return ok(rows);
}

export async function POST(request: Request) {
  const { account, error } = await paidAccount(request);
  if (error) return error;
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  const query = typeof body.query === "string" ? body.query.trim() : "";
  const market = body.market === "TW" || body.market === "US" ? body.market : null;
  const alertEnabled = body.alertEnabled === true;
  if (!name || !query) return fail("name and query are required.", 400);

  const row = await prisma.savedFilter.create({
    data: { userId: account!.id, name, filters: { query, market, alertEnabled }, assetType: "STOCK" },
  });
  return ok(row, 201);
}

export async function DELETE(request: Request) {
  const { account, error } = await paidAccount(request);
  if (error) return error;
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const id = typeof body.id === "string" ? body.id : null;
  if (!id) return fail("id is required.", 400);
  const owned = await prisma.savedFilter.findFirst({ where: { id, userId: account!.id } });
  if (!owned) return fail("Not found.", 404);
  await prisma.savedFilter.delete({ where: { id } });
  return ok({ deleted: true });
}
