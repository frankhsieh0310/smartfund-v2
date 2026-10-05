import { getTwoLatestSnapshots, coverageDepthOf, type ProductType, type HoldingRow } from "@/lib/data-platform/holdingsHistory";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

type Entry = { key: string; name: string; oldWeightPct: number | null; newWeightPct: number | null; deltaPct: number | null };

export async function GET(_req: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params;
  const productType = type.toUpperCase() === "ETF" ? "ETF" : type.toUpperCase() === "FUND" ? "FUND" : null;
  if (!productType || !id) return Response.json({ ok: false, error: "INVALID_PRODUCT" }, { status: 400, headers });

  const { latest, previous, latestRows, previousRows, latestSource, previousSource } = await getTwoLatestSnapshots(productType as ProductType, id);

  if (!latest || !previous) {
    return Response.json({
      ok: true, productType, productId: id, hasEnoughHistory: false,
      reason: !latest ? "NO_SNAPSHOT" : "ONLY_ONE_SNAPSHOT",
      previousDate: previous, latestDate: latest || null,
      added: [], increased: [], decreased: [], removed: [],
    }, { headers });
  }

  const byKey = (rows: HoldingRow[]) => new Map(rows.map((r) => [r.key, r]));
  const prevMap = byKey(previousRows);
  const latestMap = byKey(latestRows);
  const allKeys = new Set([...prevMap.keys(), ...latestMap.keys()]);

  const added: Entry[] = [], removed: Entry[] = [], increased: Entry[] = [], decreased: Entry[] = [];
  for (const key of allKeys) {
    const prev = prevMap.get(key);
    const cur = latestMap.get(key);
    const name = cur?.name ?? prev?.name ?? key;
    if (!prev && cur) added.push({ key, name, oldWeightPct: null, newWeightPct: cur.weightPct, deltaPct: cur.weightPct });
    else if (prev && !cur) removed.push({ key, name, oldWeightPct: prev.weightPct, newWeightPct: null, deltaPct: -prev.weightPct });
    else if (prev && cur) {
      const delta = cur.weightPct - prev.weightPct;
      const entry: Entry = { key, name, oldWeightPct: prev.weightPct, newWeightPct: cur.weightPct, deltaPct: delta };
      if (delta > 0.001) increased.push(entry);
      else if (delta < -0.001) decreased.push(entry);
    }
  }

  // FULL_VS_FULL only when both snapshots came from the one source this codebase already treats as a
  // verified-complete daily snapshot; any other pairing is reported CONSERVATIVE rather than implying
  // a completeness guarantee the data doesn't actually carry.
  const bothFull = coverageDepthOf(latestSource) === "FULL" && coverageDepthOf(previousSource) === "FULL";
  const level: "FULL_VS_FULL" | "CONSERVATIVE" = bothFull ? "FULL_VS_FULL" : "CONSERVATIVE";

  return Response.json({
    ok: true, productType, productId: id, hasEnoughHistory: true,
    previousDate: previous, latestDate: latest,
    added, increased, decreased, removed,
    newlyDisclosed: added, noLongerDisclosed: removed,
    comparability: {
      level,
      reason: level === "FULL_VS_FULL" ? "兩期皆為完整持股快照" : "至少一期非完整持股，比較結果僅供參考",
      warning: level === "CONSERVATIVE" ? "目前兩期持股資料完整度不同，只比較共同持股的比重變化。" : null,
    },
  }, { headers });
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
