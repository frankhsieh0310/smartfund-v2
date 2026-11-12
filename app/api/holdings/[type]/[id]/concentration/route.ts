import { getLatestSnapshot, coverageDepthOf, type ProductType } from "@/lib/data-platform/holdingsHistory";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

function bucketBy(rows: { weightPct: number; sector: string | null; country: string | null }[], field: "sector" | "country") {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const label = r[field];
    if (!label) continue;
    totals.set(label, (totals.get(label) ?? 0) + r.weightPct);
  }
  return [...totals.entries()].map(([label, weightPct]) => ({ label, weightPct })).sort((a, b) => b.weightPct - a.weightPct);
}

export async function GET(_req: Request, context: RouteContext<"/api/holdings/[type]/[id]/concentration">) {
  const { type, id } = await context.params;
  const productType = type.toUpperCase() === "ETF" ? "ETF" : type.toUpperCase() === "FUND" ? "FUND" : null;
  if (!productType || !id) return Response.json({ ok: false, error: "INVALID_PRODUCT" }, { status: 400, headers });

  const snapshot = await getLatestSnapshot(productType as ProductType, id);
  if (!snapshot || snapshot.rows.length === 0) {
    // 2026-11-11 使用者回報核實：沒有持股資料時原本回傳top10Pct/top20Pct:0，前端顯示成
    // 「0.00%」，看起來像「這檔ETF集中度是0」而不是「沒有資料」——改成null，呼叫端的
    // formatPct(null)本來就會顯示「—」，不用改前端。
    return Response.json({
      ok: true, productType, productId: id, asOfDate: snapshot?.asOfDate ?? null, coverageDepth: "UNKNOWN",
      isFullHoldings: false, basisNote: "目前沒有可用的持股資料，無法計算集中度。",
      top10Pct: null, top20Pct: null, largestHolding: null, sectorConcentration: [], countryConcentration: [],
    }, { headers });
  }

  const sorted = [...snapshot.rows].sort((a, b) => b.weightPct - a.weightPct);
  const sum = (rows: typeof sorted) => rows.reduce((acc, r) => acc + r.weightPct, 0);
  const coverageDepth = coverageDepthOf(snapshot.source);

  return Response.json({
    ok: true, productType, productId: id, asOfDate: snapshot.asOfDate, coverageDepth,
    isFullHoldings: coverageDepth === "FULL",
    basisNote: coverageDepth === "FULL" ? "依官方每日完整持股計算" : "依目前可取得的持股資料計算，可能非完整持股",
    // 2026-11-11 使用者回報核實：只有前十大持股時，top20Pct跟top10Pct算出同一個數字，畫面上
    // 看起來像「這就是前20大集中度」，誤導——改成持股檔數不滿20檔時top20Pct回null，呼叫端
    // formatPct(null)顯示「—」。
    top10Pct: sum(sorted.slice(0, 10)), top20Pct: sorted.length >= 20 ? sum(sorted.slice(0, 20)) : null,
    largestHolding: sorted[0] ? { key: sorted[0].key, ticker: sorted[0].ticker, name: sorted[0].name, nameZh: sorted[0].nameZh, weightPct: sorted[0].weightPct } : null,
    sectorConcentration: bucketBy(sorted, "sector"), countryConcentration: bucketBy(sorted, "country"),
  }, { headers });
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
