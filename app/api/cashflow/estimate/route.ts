// Function 5 (配息目標試算). Reuses the exact same Yahoo-direct yield layer as Function 6
// (lib/yahoo/distributionYield.ts) — this route was the one piece of "Function 5" never wired to an
// endpoint (confirmed: genuinely 404 in Production until now). No trailing-12M/NAV, no self-estimated
// yield: if Yahoo has no direct yield for this product, the response says so honestly.
import { getEtfYahooYieldByCode, getFundYahooYieldByCode } from "@/lib/yahoo/distributionYield";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const type = q.get("type") === "fund" ? "fund" : q.get("type") === "etf" ? "etf" : null;
  const code = q.get("code");
  const target = Number(q.get("target"));

  if (!type || !code) return Response.json({ ok: false, error: "INVALID_PRODUCT" }, { status: 400, headers });
  if (!Number.isFinite(target) || target <= 0) return Response.json({ ok: false, error: "INVALID_TARGET" }, { status: 400, headers });

  try {
    const row = type === "etf" ? await getEtfYahooYieldByCode(code) : await getFundYahooYieldByCode(code);
    if (!row) return Response.json({ ok: true, type, code, available: false, reason: "PRODUCT_NOT_FOUND" }, { headers });
    if (row.yahooYieldPct == null || !Number.isFinite(row.yahooYieldPct) || row.yahooYieldPct <= 0) {
      return Response.json({ ok: true, type, code, name: row.name, available: false, reason: "NO_YAHOO_DIRECT_YIELD" }, { headers });
    }
    const principalNeeded = target / (row.yahooYieldPct / 100);
    return Response.json({
      ok: true, type, code, name: row.name, available: true,
      yahooYieldPct: row.yahooYieldPct, targetAnnual: target, principalNeeded,
      // 2026-11-08（使用者核准定案，庚項）: 配息率旁邊要標資料日期——ETF 有最近一次除息日
      // （etf_distribution_events，見 distributionYield.ts）可用；基金這條路徑沒有對應資料，誠實
      // 回傳 null，前端顯示「資料日期未提供」，不假造一個日期。
      asOfDate: row.latestExDate ?? null,
    }, { headers });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500, headers });
  }
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
