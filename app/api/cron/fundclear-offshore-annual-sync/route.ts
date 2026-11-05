// 境外基金年度費用率／報酬率 —— 獨立新排程（2026-11-05使用者核准），不動sitca-nav-sync或任何
// 既有排程。寫入開關預設關閉：FUNDCLEAR_OFFSHORE_ANNUAL_WRITE。
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { runFundclearOffshoreAnnualSync } from "@/lib/fundclear-annual-sync/writerOffshore";

export const runtime = "nodejs";
export const maxDuration = 280;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const result = await runFundclearOffshoreAnnualSync();
  return Response.json({ job: "FUNDCLEAR_OFFSHORE_ANNUAL_RATE_SYNC", ...result });
}
