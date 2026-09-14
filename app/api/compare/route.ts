import { compareAssets, parseCompareContract, type CompareContract } from "@/lib/data-platform/web/compareService";
import { errorResponse } from "@/lib/data-platform/web/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return Response.json(await compareAssets(parseCompareContract(new URL(request.url))), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const result = errorResponse(error);
    return Response.json(result.body, { status: result.status });
  }
}

export async function POST(request: Request) {
  try {
    const contract = await request.json() as CompareContract;
    return Response.json(await compareAssets(contract), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const result = errorResponse(error);
    return Response.json(result.body, { status: result.status });
  }
}
