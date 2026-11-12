// Task X12 (round-6 instruction 四-8): backend for the App's "開始穿透分析" button
// (app/results.tsx -> src/portfolio/lookThrough.ts), which has existed since before this QA
// engagement calling /api/holdings/portfolio-analysis -- a route that was never built, so the button
// was hidden. Reuses getLatestSnapshot (the same function the already-live
// /api/holdings/[type]/[id]/table route uses) per product, weights each holding by the product's own
// portfolio weight, and aggregates -- no new pipeline, no new table.
import { prisma } from "@/lib/prisma";
import { getLatestSnapshot, coverageDepthOf, type ProductType, type CoverageDepth } from "./holdingsHistory";

export type AllocationMode = "AMOUNT" | "WEIGHT";
export type SelectedProductInput = { assetType: "ETF" | "FUND"; id: string; value: number };

type ProductResult = {
  ref: string; assetType: "ETF" | "FUND"; id: string; code: string | null; name: string | null; weightPct: number; included: boolean;
  coverageDepth: CoverageDepth | null; presentRowCount: number; declaredCount: number | null; asOfDate: string | null; holdingsCoveredPct: number | null;
};

// 2026-10-31（使用者核准，商品範圍最高原則）: 「組合穿透」文件開頭已經明確說過濾只套用在
// 「使用者挑選商品」這一層（不套用在商品本身揭露的持股內容）——但這裡原本完全沒有這一層檢查，
// 任何人只要知道一個非APPROVED商品的id，都能把它當成items傳進來分析。補上跟
// compareService.ts/publicReadiness.ts/reverseHoldings.ts同一個APPROVED檢查，非APPROVED視同
// NOT_FOUND，不透露存在、不耗費任何額外查詢在範圍外商品上。
async function fetchName(assetType: "ETF" | "FUND", id: string): Promise<{ code: string | null; name: string | null; currency: string | null } | null> {
  const table = assetType === "ETF" ? "etfs" : "funds";
  const rows = await prisma.$queryRawUnsafe<Array<{ code: string | null; name: string | null; currency: string | null; approved: number }>>(
    `SELECT f.code, f.name, f.currency,
       (SELECT count(*)::int FROM tw_purchasable_classification c WHERE c.asset_type = $2 AND c.asset_id = f.id AND c.status = 'APPROVED') AS approved
     FROM ${table} f WHERE f.id = $1`,
    id, assetType,
  );
  const row = rows[0];
  if (!row || row.approved === 0) return null;
  return { code: row.code, name: row.name, currency: row.currency };
}

// 2026-11-13（ChatGPT第三輪審查第4項，VERIFIED實測發現的真實bug）: AMOUNT模式（「我的組合」頁的
// 「持有金額」輸入）原本直接拿使用者輸入的原始數字算weightPct = value/totalRaw，完全不管每檔
// 商品實際計價幣別——0050是台幣、VOO是美元，使用者在兩個輸入框都看到同一個「元」單位，混著輸入
// 等於把「50000元」跟「500美元」當同一個單位相加，組合權重會嚴重失真。改成AMOUNT模式下，不同
// 幣別的金額先用yahoo即時匯率（fx_latest_quotes，跟fxService.ts同一張表，非自算/非猜測）換算成
// 台幣等值再算權重；只有一種幣別或WEIGHT模式（直接輸入百分比，不是金額）時完全不受影響。查不到
// 匯率的幣別維持原始數值、不猜，並非靜默失敗——這是本次審查沒有要求、但驗證過程中查出的真實
// 不一致，依使用者指示直接修正，不是只回報。
async function convertAmountsToTwd(items: SelectedProductInput[], currencies: Map<string, string | null>): Promise<Map<number, number>> {
  const converted = new Map<number, number>();
  const neededCurrencies = new Set<string>();
  items.forEach((item, idx) => {
    const ccy = currencies.get(`${item.assetType}:${item.id}`) ?? null;
    if (ccy && ccy !== "TWD") neededCurrencies.add(ccy);
  });
  const rateByCurrency = new Map<string, number>();
  if (neededCurrencies.size) {
    const pairSymbols = [...neededCurrencies].map((c) => `${c}TWD`);
    const rows = await prisma.fxLatestQuote.findMany({ where: { pairSymbol: { in: pairSymbols } } });
    for (const r of rows) rateByCurrency.set(r.pairSymbol.replace(/TWD$/, ""), Number(r.mid));
  }
  items.forEach((item, idx) => {
    const ccy = currencies.get(`${item.assetType}:${item.id}`) ?? null;
    const rate = ccy && ccy !== "TWD" ? rateByCurrency.get(ccy) : 1;
    // 查不到匯率就用原始數值（不猜造一個假匯率），同時這代表這筆AMOUNT輸入沒有被正確換算成台幣。
    converted.set(idx, rate != null ? item.value * rate : item.value);
  });
  return converted;
}

export async function computePortfolioLookThrough(items: SelectedProductInput[], mode: AllocationMode) {
  const excludedProducts: Array<{ ref: string; label: string; name: string | null; reason: "NO_HOLDINGS" | "NOT_FOUND" }> = [];
  const incompleteProducts: Array<{ ref: string; label: string; coverageDepth: CoverageDepth; presentRowCount: number; declaredCount: number | null }> = [];
  const products: ProductResult[] = [];

  // stockKey -> { name, ticker, exposurePct, holders: Set<ref>, contributions }
  type Agg = { name: string; nameZh: string | null; ticker: string | null; sector: string | null; country: string | null; exposurePct: number; holders: Map<string, number> };
  const stocks = new Map<string, Agg>();
  let lookedThroughPct = 0;
  // 2026-11-11（組合持股分析補完第2項，使用者核准）: 重疊矩陣要用「商品自己的持股權重」（例如
  // 這檔股票佔這檔ETF本身8%），不是上面已經乘過組合配置比重的contributionPct——跟exposurePct
  // 分開存一份，只給overlapMatrix用。
  const productOwnWeights = new Map<string, Map<string, number>>();

  // 2026-11-11 使用者回報核實：穿透分析載入15–20秒。量過：每檔商品原本是fetchName+
  // getLatestSnapshot(=listSnapshotDates+fetchSnapshot，各一次DB往返)依序await，彼此互不依賴
  // 卻完全沒平行——10檔商品 x 最多3次往返 x 遠端Postgres延遲，疊加起來就是15–20秒。這裡只改成
  // 平行抓資料（Promise.all），聚合邏輯本身完全不動、結果不變，之後再依items原始順序寫入
  // products/excludedProducts等陣列，維持跟原本一致的顯示順序。
  const fetched = await Promise.all(items.map(async (item) => {
    const basics = await fetchName(item.assetType, item.id);
    if (!basics) return { item, basics: null, snapshot: null };
    const snapshot = await getLatestSnapshot(item.assetType as ProductType, item.id);
    return { item, basics, snapshot };
  }));

  // AMOUNT模式下才需要換算成同一幣別再算權重比例；WEIGHT模式輸入的本來就是百分比，沒有幣別問題。
  const currencies = new Map(fetched.map(({ item, basics }) => [`${item.assetType}:${item.id}`, basics?.currency ?? null]));
  const effectiveValues = mode === "AMOUNT" ? await convertAmountsToTwd(items, currencies) : new Map(items.map((_, idx) => [idx, items[idx].value]));
  const totalRaw = items.reduce((acc, _, idx) => acc + (Number.isFinite(effectiveValues.get(idx)) ? (effectiveValues.get(idx) as number) : 0), 0);
  const weightSumOk = totalRaw > 0;

  for (const [idx, { item, basics, snapshot }] of fetched.entries()) {
    const ref = `${item.assetType}:${item.id}`;
    const effectiveValue = effectiveValues.get(idx) ?? item.value;
    const weightPct = weightSumOk ? (effectiveValue / totalRaw) * 100 : 0;
    if (!basics) {
      excludedProducts.push({ ref, label: ref, name: null, reason: "NOT_FOUND" });
      products.push({ ref, assetType: item.assetType, id: item.id, code: null, name: null, weightPct, included: false, coverageDepth: null, presentRowCount: 0, declaredCount: null, asOfDate: null, holdingsCoveredPct: null });
      continue;
    }
    const label = basics.name ?? basics.code ?? ref;
    if (!snapshot || snapshot.rows.length === 0) {
      excludedProducts.push({ ref, label, name: basics.name, reason: "NO_HOLDINGS" });
      products.push({ ref, assetType: item.assetType, id: item.id, code: basics.code, name: basics.name, weightPct, included: false, coverageDepth: null, presentRowCount: 0, declaredCount: null, asOfDate: null, holdingsCoveredPct: null });
      continue;
    }
    const coverageDepth = coverageDepthOf(snapshot.source);
    if (coverageDepth !== "FULL") incompleteProducts.push({ ref, label, coverageDepth, presentRowCount: snapshot.rows.length, declaredCount: null });

    const rowsSumPct = snapshot.rows.reduce((acc, r) => acc + r.weightPct, 0);
    products.push({
      ref, assetType: item.assetType, id: item.id, code: basics.code, name: basics.name, weightPct, included: true,
      coverageDepth, presentRowCount: snapshot.rows.length, declaredCount: null, asOfDate: snapshot.asOfDate, holdingsCoveredPct: rowsSumPct,
    });
    lookedThroughPct += weightPct;

    const ownWeights = new Map<string, number>();
    for (const row of snapshot.rows) {
      const contributionPct = (weightPct * row.weightPct) / 100;
      const existing = stocks.get(row.key);
      if (existing) {
        existing.exposurePct += contributionPct;
        existing.holders.set(ref, (existing.holders.get(ref) ?? 0) + contributionPct);
      } else {
        stocks.set(row.key, { name: row.name, nameZh: row.nameZh, ticker: row.ticker, sector: row.sector, country: row.country, exposurePct: contributionPct, holders: new Map([[ref, contributionPct]]) });
      }
      ownWeights.set(row.key, (ownWeights.get(row.key) ?? 0) + row.weightPct);
    }
    productOwnWeights.set(ref, ownWeights);
  }

  // 2026-11-11（組合持股分析補完第2項）: 兩兩共同持股比重——標準做法（跟Morningstar Portfolio
  // X-Ray同一個定義）：對兩檔商品都持有的每一檔股票，取min(商品A自己的權重,商品B自己的權重)再
  // 加總，不是用contributionPct（那已經乘過使用者輸入的組合配置比重，答的是不同問題）。只算
  // included=true的商品之間的配對，沒有持股資料的商品不會出現在矩陣裡。
  const includedRefs = products.filter((p) => p.included).map((p) => p.ref);
  const overlapMatrix: Array<{ refA: string; refB: string; overlapPct: number }> = [];
  for (let i = 0; i < includedRefs.length; i++) {
    for (let j = i + 1; j < includedRefs.length; j++) {
      const refA = includedRefs[i], refB = includedRefs[j];
      const weightsA = productOwnWeights.get(refA) ?? new Map();
      const weightsB = productOwnWeights.get(refB) ?? new Map();
      let overlapPct = 0;
      for (const [key, wA] of weightsA) {
        const wB = weightsB.get(key);
        if (wB != null) overlapPct += Math.min(wA, wB);
      }
      overlapMatrix.push({ refA, refB, overlapPct });
    }
  }

  const toStock = (agg: Agg, key: string) => ({
    name: agg.name, nameZh: agg.nameZh, ticker: agg.ticker, exposurePct: agg.exposurePct, holderCount: agg.holders.size,
    contributions: [...agg.holders.entries()].map(([productRef, contributionPct]) => ({ productRef, label: products.find((p) => p.ref === productRef)?.name ?? productRef, contributionPct })),
    key,
  });
  const sortedStocks = [...stocks.entries()].map(([key, agg]) => toStock(agg, key)).sort((a, b) => b.exposurePct - a.exposurePct);
  const top10 = sortedStocks.slice(0, 10);
  const top20 = sortedStocks.slice(0, 20);
  const duplicateStocks = sortedStocks.filter((s) => s.holderCount > 1);
  const duplicatesExposurePct = duplicateStocks.reduce((acc, s) => acc + s.exposurePct, 0);

  // 2026-11-12（ChatGPT審查第5項）: sector/country原本的unclassifiedPct只是「有拿到持股資料、但
  // 查不到產業/國家分類」那一塊，分母其實是lookedThroughPct（已取得持股的那部分），不是整個組合——
  // 加總起來看起來像100%，但那其實只是「已穿透部分的100%」，容易被誤讀成「整個組合的100%」。
  // 新增undisclosedPct = 整個組合裡「完全沒拿到持股資料」的那一塊（跟notLookedThroughPct同一個
  // 分子，只是換算成跟這裡其他桶一樣的「整個組合」分母），讓畫面上all+unclassified+undisclosed
  // 三者加總才等於整個組合的100%，並在畫面上寫明分母。
  function bucketBy(field: "sector" | "country"): { hasClassifiedData: boolean; largest: { label: string; exposurePct: number } | null; top3: Array<{ label: string; exposurePct: number }>; unclassifiedPct: number; undisclosedPct: number; all: Array<{ label: string; exposurePct: number }> } {
    const totals = new Map<string, number>();
    let unclassified = 0;
    for (const [, agg] of stocks) {
      const label = agg[field];
      if (!label) { unclassified += agg.exposurePct; continue; }
      totals.set(label, (totals.get(label) ?? 0) + agg.exposurePct);
    }
    const all = [...totals.entries()].map(([label, exposurePct]) => ({ label, exposurePct })).sort((a, b) => b.exposurePct - a.exposurePct);
    const undisclosedPct = Math.max(0, 100 - all.reduce((s, b) => s + b.exposurePct, 0) - unclassified);
    return { hasClassifiedData: all.length > 0, largest: all[0] ?? null, top3: all.slice(0, 3), unclassifiedPct: unclassified, undisclosedPct, all };
  }

  const notLookedThroughPct = Math.max(0, 100 - lookedThroughPct);
  // 2026-11-10（上架前審查第5項，使用者核准）: lookedThroughPct只回答「這個商品有沒有拿到持股
  // 資料」（商品資料取得率），不是「拿到的持股清單本身蓋了多少比重」——一檔基金只公開前十大
  // 持股、加總可能只有60%，lookedThroughPct仍然把它算進「已穿透」，畫面上「已穿透100%」會
  // 誤導成「全部持股都看到了」。新增一個獨立的加權指標：每個已納入商品的holdingsCoveredPct
  // （該商品自己揭露清單的權重合計）乘以該商品在組合裡的weightPct，加總起來才是真正的「持股
  // 涵蓋率」——跟商品資料取得率是兩個不同的數字，畫面要分開顯示，不能互相取代。沿用既有欄位
  // 不動，只新增，不影響任何既有呼叫端。
  const holdingsCoverageWeightedPct = products.reduce(
    (acc, p) => acc + (p.included ? (p.weightPct / 100) * (p.holdingsCoveredPct ?? 0) : 0),
    0,
  );
  return {
    ok: true,
    mode,
    itemCount: items.length,
    weights: { totalWeightPct: weightSumOk ? 100 : 0, totalAmount: mode === "AMOUNT" ? totalRaw : null, weightSumOk, warning: weightSumOk ? null : "尚未輸入有效的金額或比例" },
    products: products.map(({ ref, assetType, id, code, name, weightPct, included, coverageDepth, presentRowCount, declaredCount, asOfDate, holdingsCoveredPct }) => ({ ref, assetType, id, code, name, weightPct, included, coverageDepth, presentRowCount, declaredCount, asOfDate, holdingsCoveredPct })),
    completeness: {
      isPartialAnalysis: incompleteProducts.length > 0 || excludedProducts.length > 0,
      basisNote: incompleteProducts.length > 0 ? "部分標的僅公開前十大或部分持股，穿透結果可能低估實際曝險" : "基於可取得的完整持股計算",
      incompleteProducts, excludedProducts, excludedCount: excludedProducts.length,
      lookedThroughPct, notLookedThroughPct,
      // 「商品資料取得率」= lookedThroughPct（有沒有拿到這個商品的持股資料，不等於資料本身完整）；
      // 「持股涵蓋率」= holdingsCoverageWeightedPct（已揭露持股清單合計占整個組合的比重，誠實反映
      // 「只公開前十大」這種部分揭露）。畫面必須分開顯示這兩個數字，不要合併成一個「已穿透%」。
      holdingsCoverageWeightedPct,
    },
    hasAnyHoldings: stocks.size > 0,
    stockExposure: {
      top10: top10.map(({ key: _key, ...rest }) => rest), top20: top20.map(({ key: _key, ...rest }) => rest),
      top10SumPct: top10.reduce((a, s) => a + s.exposurePct, 0), top20SumPct: top20.reduce((a, s) => a + s.exposurePct, 0),
      distinctStocks: stocks.size,
    },
    duplicates: {
      count: duplicateStocks.length, exposurePct: duplicatesExposurePct,
      shareOfLookedThroughPct: lookedThroughPct > 0 ? (duplicatesExposurePct / lookedThroughPct) * 100 : 0,
      top10: duplicateStocks.slice(0, 10).map(({ key: _key, ...rest }) => rest),
    },
    sector: bucketBy("sector"),
    country: bucketBy("country"),
    overlapMatrix,
  };
}
