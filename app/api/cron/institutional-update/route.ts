import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { updateInstitutional } from "@/lib/cron/institutionalUpdate";
export const maxDuration = 300;
export async function GET(request: Request) { if (!isAuthorizedCron(request)) return unauthorizedCron(); const date=new URL(request.url).searchParams.get("date")??undefined; return Response.json({ok:true,task:"institutional-update",result:await updateInstitutional(date)}); }
