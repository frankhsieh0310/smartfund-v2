// 主動式ETF每日持股追蹤 — 原本規劃好的核心功能（2026-11-11 使用者核准補做）。用既有的每日官方
// 持股快照（holdings表，source='ETF_OFFICIAL_DAILY_SNAPSHOT'）+ 既有的兩期比較邏輯
// （lib/data-platform/holdingsHistory.ts 的 getTwoLatestSnapshots，lib/data-platform/
// holdingsCompare.ts 的 EtfFundCompareSection 已經在用同一套邏輯比對兩檔不同商品），這裡複用
// 同一個底層函式，只是改成「同一檔主動式ETF自己前後兩天」，不新增資料抓取管線。
//
// 主動式ETF的認定：官方命名慣例以「主動」開頭（例如「主動野村臺灣優選」），不是自己猜的規則——
// 這是證交所/櫃買中心對這批商品的官方命名方式。
import { prisma } from "@/lib/prisma";
import { getTwoLatestSnapshots, coverageDepthOf } from "@/lib/data-platform/holdingsHistory";

// 2026-11-13（ChatGPT審查第8項，載入速度）: 這支route對每檔「主動」ETF各自呼叫一次
// getTwoLatestSnapshots（每次都是holdingsHistory.ts那套winning_source多CTE查詢），ETF檔數一多
// 就慢；資料本身只跟著每日官方持股快照更新（一天最多變一次），原本no-store完全沒有快取，同一
// 使用者短時間內重新打開這頁也要整個重算一次。改成私有快取10分鐘——不影響資料正確性（當天資料
// 本來就不會中途變），只避免同一天內重複重算。
const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "private, max-age=600" };

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const code = q.get("code");

  try {
    const etfs = await prisma.$queryRawUnsafe<Array<{ id: string; code: string; name: string }>>(
      `SELECT id, code, name FROM etfs WHERE name LIKE '主動%' AND is_active
         AND id IN (SELECT asset_id FROM tw_purchasable_classification WHERE asset_type='ETF' AND status='APPROVED')
         ${code ? "AND code = $1" : ""}
       ORDER BY code`,
      ...(code ? [code] : []),
    );

    const results = await Promise.all(
      etfs.map(async (etf) => {
        const diff = await getTwoLatestSnapshots("ETF", etf.id);
        if (!diff.previous) {
          return { id: etf.id, code: etf.code, name: etf.name, hasEnoughHistory: false as const, latestDate: diff.latest || null };
        }
        const prevMap = new Map(diff.previousRows.map((r) => [r.key, r]));
        const latestMap = new Map(diff.latestRows.map((r) => [r.key, r]));
        const allKeys = new Set([...prevMap.keys(), ...latestMap.keys()]);
        const added: Array<{ name: string; ticker: string | null; weightPct: number }> = [];
        const removed: Array<{ name: string; ticker: string | null; weightPct: number }> = [];
        const increased: Array<{ name: string; ticker: string | null; deltaPct: number }> = [];
        const decreased: Array<{ name: string; ticker: string | null; deltaPct: number }> = [];
        for (const key of allKeys) {
          const prev = prevMap.get(key);
          const cur = latestMap.get(key);
          if (!prev && cur) added.push({ name: cur.name, ticker: cur.ticker, weightPct: cur.weightPct });
          else if (prev && !cur) removed.push({ name: prev.name, ticker: prev.ticker, weightPct: prev.weightPct });
          else if (prev && cur) {
            const delta = cur.weightPct - prev.weightPct;
            if (delta > 0.001) increased.push({ name: cur.name, ticker: cur.ticker, deltaPct: delta });
            else if (delta < -0.001) decreased.push({ name: cur.name, ticker: cur.ticker, deltaPct: delta });
          }
        }
        added.sort((a, b) => b.weightPct - a.weightPct);
        removed.sort((a, b) => b.weightPct - a.weightPct);
        increased.sort((a, b) => b.deltaPct - a.deltaPct);
        decreased.sort((a, b) => a.deltaPct - b.deltaPct);
        const latestDepth = coverageDepthOf(diff.latestSource);
        const prevDepth = coverageDepthOf(diff.previousSource);
        return {
          id: etf.id, code: etf.code, name: etf.name, hasEnoughHistory: true as const,
          previousDate: diff.previous, latestDate: diff.latest,
          comparabilityLevel: latestDepth === "FULL" && prevDepth === "FULL" ? "FULL_VS_FULL" as const : "CONSERVATIVE" as const,
          warning: latestDepth === "FULL" && prevDepth === "FULL" ? null : "其中一期不是完整持股，異動比較僅供參考",
          counts: { added: added.length, increased: increased.length, decreased: decreased.length, removed: removed.length },
          added: added.slice(0, 10), removed: removed.slice(0, 10), increased: increased.slice(0, 10), decreased: decreased.slice(0, 10),
        };
      }),
    );

    return Response.json({ ok: true, count: results.length, results, basisNote: "本程式計算：依既有每日官方持股快照比對前後兩個交易日的持股異動。" }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "QUERY_FAILED";
    return Response.json({ ok: false, error: message }, { status: 500, headers });
  }
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
