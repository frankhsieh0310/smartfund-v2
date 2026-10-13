import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { updateCurrentPrices } from "@/lib/cron/priceUpdate";
export const maxDuration = 300;
export async function GET(request: Request) { if (!isAuthorizedCron(request)) return unauthorizedCron(); const url=new URL(request.url),limit=Math.min(100,Math.max(1,Number(url.searchParams.get("limit")??40))); return Response.json({ok:true,task:"price-update",result:await updateCurrentPrices(limit)}); }
