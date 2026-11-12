// 主動式ETF每日持股追蹤 — 原本規劃好的核心功能（2026-11-11 使用者核准補做）。用既有的每日官方
// 持股快照（holdings表，source='ETF_OFFICIAL_DAILY_SNAPSHOT'）+ 既有的兩期比較邏輯
// （lib/data-platform/holdingsHistory.ts 的 getTwoLatestSnapshots，lib/data-platform/
// holdingsCompare.ts 的 EtfFundCompareSection 已經在用同一套邏輯比對兩檔不同商品），這裡複用
// 同一個底層函式，只是改成「同一檔主動式ETF自己前後兩天」，不新增資料抓取管線。
//
// 主動式ETF的認定：官方命名慣例以「主動」開頭（例如「主動野村臺灣優選」），不是自己猜的規則——
// 這是證交所/櫃買中心對這批商品的官方命名方式。
//
// 2026-11-13（使用者回報核實，第一次載入約15秒，目標3秒內）: 不帶code篩選（App實際用的那個
// 形狀）先查lib/data-platform/activeEtfChangesCache.ts的預先算好結果，命中直接回，不用即時算
// 一次；沒命中（含還沒部署快取表、或還沒排程算過）才照舊即時計算，快取本身出問題不會擋住這支
// route。帶code篩選的單檔查詢維持即時計算（用量小，不需要快取）。
import { computeActiveEtfDailyChanges, getCachedActiveEtfDailyChanges } from "@/lib/data-platform/activeEtfChangesCache";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "private, max-age=600" };

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const code = q.get("code");

  try {
    if (!code) {
      const cached = await getCachedActiveEtfDailyChanges();
      if (cached) return Response.json(cached, { headers: { ...headers, "Server-Timing": 'db;dur=0;desc="cache"' } });
    }
    const computed = await computeActiveEtfDailyChanges(code);
    return Response.json(computed, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "QUERY_FAILED";
    return Response.json({ ok: false, error: message }, { status: 500, headers });
  }
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
