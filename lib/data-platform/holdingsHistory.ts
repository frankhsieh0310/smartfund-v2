// Per-product historical holdings (table / concentration / diff) for the mobile app's
// /api/holdings/[type]/[id]/{table,concentration,diff} routes. Reuses the SAME `holdings` table and
// the SAME "prefer ETF_OFFICIAL_DAILY_SNAPSHOT when present" dedup guard already proven correct in
// /api/mobile/current-holdings — no second holdings pipeline, no mock/fabricated snapshots.
import { prisma } from "@/lib/prisma";
import { classifyCategory } from "@/lib/data-platform/categoryClassification";

export type ProductType = "ETF" | "FUND";
export type CoverageDepth = "TOP_N" | "PARTIAL" | "FULL" | "UNKNOWN";

export type HoldingRow = {
  key: string;
  name: string;
  ticker: string | null;
  weightPct: number;
  sector: string | null;
  country: string | null;
};

// One snapshot's full row set for a product, honestly reporting which source produced it. `source`
// drives the coverage-depth call: ETF_OFFICIAL_DAILY_SNAPSHOT is the one source this codebase already
// treats as a verified-complete daily snapshot (Function 2); everything else is reported as UNKNOWN
// coverage rather than guessed, since the `holdings` table alone carries no completeness signal.
//
// 2026-11-10（上架前審查第2項，使用者核准）: 原本的WHERE只鎖fund_id/etf_id+as_of_date，沒有限定
// source——同一天如果有兩個來源各自揭露一份（例如48790067同一天FUBON_OFFICIAL_MONTHLY 10筆、
// MONEYDJ_PUBLIC_DISCLOSURE 27筆），兩份會被整個疊加回傳，同一檔股票出現兩次、前十大集中度破
// 150%。改成先選出「這天筆數最多的那個來源」（跟refresh_reverse_products()的fund_latest挑選
// 同一組tie-break：筆數多的優先、同筆數按來源名稱字母序，維持跟持股反查已經在用的邏輯一致，
// 不另外發明一套「官方優先」規則），只回傳那一個來源的資料。
// 加防呆：非槓桿反向商品的持股比重合計超過105%就整批不採用（回傳空陣列，呼叫端既有的「沒有
// 可用持股資料」畫面會自然接手），並記錄到server log，不讓異常數字漏到畫面上。
const NON_LEVERAGED_WEIGHT_SUM_CEILING_PCT = 105;

async function fetchSnapshot(productType: ProductType, productId: string, asOfDate: string): Promise<{ rows: HoldingRow[]; source: string | null }> {
  const col = productType === "ETF" ? "etf_id" : "fund_id";
  const rows = await prisma.$queryRawUnsafe<Array<{
    key: string; name: string; ticker: string | null; weight: string | null; sector: string | null; country: string | null; source: string;
  }>>(
    `WITH etf_official AS (SELECT DISTINCT etf_id FROM holdings WHERE etf_id IS NOT NULL AND source='ETF_OFFICIAL_DAILY_SNAPSHOT'),
     candidate_sources AS (
       SELECT h.source, count(*) n
         FROM holdings h
        WHERE h.${col} = $1 AND h.as_of_date = $2::date
          AND (h.etf_id IS NULL OR NOT EXISTS(SELECT 1 FROM etf_official eo WHERE eo.etf_id = h.etf_id) OR h.source = 'ETF_OFFICIAL_DAILY_SNAPSHOT')
        GROUP BY h.source
     ),
     winning_source AS (SELECT source FROM candidate_sources ORDER BY n DESC, source ASC LIMIT 1)
     SELECT coalesce(h.security_id, h.ticker, h.holding_code, h.holding_name) key, h.holding_name name,
            h.ticker, h.weight::text weight,
            -- 2026-11-11（使用者核准，官方產業分類定案）: 「產業集中」優先用securities表的官方
            -- 產業別（TWSE/TPEx/SEC SIC，依security_id關聯到個股）——holdings.sector原本只有少數
            -- 來源（BlackRock債券CSV等）有填，TW/美股ETF官方揭露來源（ETF_OFFICIAL_DAILY_SNAPSHOT
            -- 等）從來沒有sector，securities表才是真正該查的地方。securities查不到才退回
            -- holdings.sector既有值，兩者都沒有才算「未分類」（呼叫端bucketBy已處理null）。
            coalesce(sec.sector, h.sector) sector,
            h.country, h.source
       FROM holdings h
       LEFT JOIN securities sec ON sec.id = h.security_id
      WHERE h.${col} = $1 AND h.as_of_date = $2::date
        AND h.source = (SELECT source FROM winning_source)
      ORDER BY h.weight DESC NULLS LAST, h.rank NULLS LAST`,
    productId, asOfDate,
  );
  const mapped = rows.map((r) => ({ key: r.key, name: r.name, ticker: r.ticker, weightPct: r.weight == null ? 0 : Number(r.weight), sector: r.sector, country: r.country }));
  const source = rows[0]?.source ?? null;

  const weightSum = mapped.reduce((acc, r) => acc + r.weightPct, 0);
  if (weightSum > NON_LEVERAGED_WEIGHT_SUM_CEILING_PCT) {
    const categoryRows = await prisma.$queryRawUnsafe<Array<{ category: string | null }>>(
      `SELECT category FROM ${productType === "ETF" ? "etfs" : "funds"} WHERE id = $1`,
      productId,
    );
    const bucket = classifyCategory(categoryRows[0]?.category ?? null);
    if (bucket !== "LEVERAGE_INVERSE") {
      console.error(
        `[holdingsHistory] suppressing anomalous snapshot: ${productType} ${productId} as_of=${asOfDate} source=${source} ` +
        `weightSum=${weightSum.toFixed(2)}% exceeds ${NON_LEVERAGED_WEIGHT_SUM_CEILING_PCT}% ceiling for a non-leveraged product (category bucket=${bucket}) — not adopted`,
      );
      return { rows: [], source: null };
    }
  }

  return { rows: mapped, source };
}

export function coverageDepthOf(source: string | null): CoverageDepth {
  if (source === "ETF_OFFICIAL_DAILY_SNAPSHOT") return "FULL";
  if (!source) return "UNKNOWN";
  return "UNKNOWN";
}

// Up to `limit` most recent DISTINCT as_of_date values this product actually has rows for — real
// dates only, never synthesized. Applies the same official-source preference as fetchSnapshot so the
// date list matches what fetchSnapshot would actually return rows for at each date.
export async function listSnapshotDates(productType: ProductType, productId: string, limit = 2): Promise<string[]> {
  const col = productType === "ETF" ? "etf_id" : "fund_id";
  // `limit` is always an internal constant (1 or 2), never user input, so inlining it is safe — same
  // pattern already used elsewhere in this codebase for internal-only bounds. Kept as a plain number
  // (not a $N parameter) because this specific query shape intermittently triggered a raw-query
  // parameter-decoding failure ("e.map is not a function") under this machine's local dev Prisma
  // engine when a second numeric parameter followed the WHERE clause's own bound parameter.
  const safeLimit = Math.max(1, Math.min(10, Math.trunc(limit)));
  const rows = await prisma.$queryRawUnsafe<Array<{ d: string }>>(
    `WITH etf_official AS (SELECT DISTINCT etf_id FROM holdings WHERE etf_id IS NOT NULL AND source='ETF_OFFICIAL_DAILY_SNAPSHOT')
     SELECT DISTINCT h.as_of_date::text d FROM holdings h
      WHERE h.${col} = $1
        AND (h.etf_id IS NULL OR NOT EXISTS(SELECT 1 FROM etf_official eo WHERE eo.etf_id = h.etf_id) OR h.source = 'ETF_OFFICIAL_DAILY_SNAPSHOT')
      ORDER BY d DESC LIMIT ${safeLimit}`,
    productId,
  );
  return rows.map((r) => r.d);
}

export async function getLatestSnapshot(productType: ProductType, productId: string): Promise<{ asOfDate: string; rows: HoldingRow[]; source: string | null } | null> {
  const dates = await listSnapshotDates(productType, productId, 1);
  if (!dates.length) return null;
  const { rows, source } = await fetchSnapshot(productType, productId, dates[0]);
  return { asOfDate: dates[0], rows, source };
}

export async function getTwoLatestSnapshots(productType: ProductType, productId: string): Promise<{
  latest: string; previous: string | null; latestRows: HoldingRow[]; previousRows: HoldingRow[];
  latestSource: string | null; previousSource: string | null;
}> {
  const dates = await listSnapshotDates(productType, productId, 2);
  if (!dates.length) return { latest: "", previous: null, latestRows: [], previousRows: [], latestSource: null, previousSource: null };
  const latestSnap = await fetchSnapshot(productType, productId, dates[0]);
  const previousSnap = dates[1] ? await fetchSnapshot(productType, productId, dates[1]) : { rows: [], source: null };
  return { latest: dates[0], previous: dates[1] ?? null, latestRows: latestSnap.rows, previousRows: previousSnap.rows, latestSource: latestSnap.source, previousSource: previousSnap.source };
}
