import { errorResponse } from "@/lib/data-platform/web/errors";
import { globalSearch, type SearchType } from "@/lib/data-platform/web/searchService";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  try {
    const limitValue = params.get("limit");
    const response = await globalSearch({ query: params.get("q") ?? "", type: (params.get("type")?.toUpperCase() ?? "ALL") as SearchType, limit: limitValue === null ? undefined : Number(limitValue) });
    return Response.json(response, { headers: { ...corsHeaders, "Cache-Control": "private, max-age=30" } });
  } catch (error) {
    const result = errorResponse(error);
    return Response.json(result.body, { status: result.status, headers: corsHeaders });
  }
}
