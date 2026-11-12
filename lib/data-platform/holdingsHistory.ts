// Per-product historical holdings (table / concentration / diff) for the mobile app's
// /api/holdings/[type]/[id]/{table,concentration,diff} routes. Reuses the SAME `holdings` table and
// the SAME "prefer ETF_OFFICIAL_DAILY_SNAPSHOT when present" dedup guard already proven correct in
// /api/mobile/current-holdings — no second holdings pipeline, no mock/fabricated snapshots.
import { prisma } from "@/lib/prisma";
import { classifyCategory } from "@/lib/data-platform/categoryClassification";
import { classifyEtfOfficial } from "@/lib/data-platform/officialEtfCategory";

export type ProductType = "ETF" | "FUND";
export type CoverageDepth = "TOP_N" | "PARTIAL" | "FULL" | "UNKNOWN";

export type HoldingRow = {
  key: string;
  name: string;
  nameZh: string | null;
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
    maturity_date: string | null; coupon_rate: string | null;
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
     SELECT
            -- 2026-11-11 使用者回報核實：0050/0052「最近兩期」異動把同一檔股票（台積電）同時算成
            -- 新增又算成退出。查到真正原因：holdings.security_id在不同進帳日指到不同的securities
            -- 列——ticker"2330"在securities表同時被TW(台積電)/HK/JP三個不同國家的公司用掉，
            -- security_id的配對邏輯沒有同時鎖country，不同天跑出不同的security_id，用它當比對鍵
            -- 兩期當然對不起來。改成「有ticker就用ticker+country」當鍵（同一檔股票同一天同一國家
            -- 的代號是穩定的，不受security_id配對結果影響），沒有ticker才退回舊的coalesce鏈。
            -- 這同時修正了portfolioLookThrough()跨ETF聚合可能把同一檔股票因security_id不同而
            -- 誤判成兩檔不同股票的潛在問題。security_id本身配對不穩定是更深層的問題，這裡只在
            -- 顯示/比對層迴避，沒有去改資料本身的security_id寫入邏輯。
            CASE WHEN h.ticker IS NOT NULL AND h.ticker <> ''
                 THEN h.ticker || '|' || coalesce(h.country, '')
                 ELSE coalesce(h.security_id, h.holding_code, h.holding_name)
            END key,
            h.holding_name name,
            h.ticker, h.weight::text weight,
            -- 2026-11-11（使用者核准，官方產業分類定案）: 「產業集中」優先用securities表的官方
            -- 產業別（TWSE/TPEx/SEC SIC，依security_id關聯到個股）——holdings.sector原本只有少數
            -- 來源（BlackRock債券CSV等）有填，TW/美股ETF官方揭露來源（ETF_OFFICIAL_DAILY_SNAPSHOT
            -- 等）從來沒有sector，securities表才是真正該查的地方。securities查不到才退回
            -- holdings.sector既有值，兩者都沒有才算「未分類」（呼叫端bucketBy已處理null）。
            coalesce(sec.sector, h.sector) sector,
            h.country, h.source,
            h.maturity_date::text maturity_date, h.coupon_rate::text coupon_rate
       FROM holdings h
       LEFT JOIN securities sec ON sec.id = h.security_id
      WHERE h.${col} = $1 AND h.as_of_date = $2::date
        AND h.source = (SELECT source FROM winning_source)
      ORDER BY h.weight DESC NULLS LAST, h.rank NULLS LAST`,
    productId, asOfDate,
  );
  const mapped = rows.map((r) => ({ key: r.key, name: r.name, nameZh: null, ticker: r.ticker, weightPct: r.weight == null ? 0 : Number(r.weight), sector: r.sector, country: r.country }));
  const source = rows[0]?.source ?? null;

  const weightSum = mapped.reduce((acc, r) => acc + r.weightPct, 0);
  if (weightSum > NON_LEVERAGED_WEIGHT_SUM_CEILING_PCT) {
    // 2026-11-12 使用者回報核實（00904持股比重檢查連帶發現）: 原本只用etfs/funds.category（95%+
    // 的TW ETF這欄位是NULL——TW用官方「基金類型」欄位分類，不是Morningstar自由文字）判斷是否為
    // 槓桿反向，結果這道防呆把全部18檔「正2/反1」槓桿反向TW ETF的持股資料整批誤判成異常、整批
    // 清空（線上驗證：00675L富邦臺灣加權正2等的持股/集中度API全部回傳「沒有可用的持股資料」）。
    // 改用officialEtfCategory.ts既有、已驗證的證交所/櫃買官方「基金類型」欄位（ETF才查，FUND
    // 沒有這份官方清單維持原規則）。
    // 另外驗證到「主動復華金融債息」「主動統一美債量化」這2檔非槓桿主動債券ETF合計124%~126%，
    // 原因是官方揭露本身就包含公債期貨避險部位（例如"202612 美國三十年期政府公債"）疊加在一般
    // 債券持倉之上（名義本金可合理超過100%，跟股票現貨ETF不同）——用holdings.maturity_date/
    // coupon_rate（官方CSV本來就有的欄位，債券/票面利率揭露才會填）判斷「這組持股含固定收益/
    // 期貨部位」，一併排除在異常防呆之外，不當成資料錯誤清空。
    const hasFixedIncomeOrFuturesLine = rows.some((r) => r.maturity_date != null || r.coupon_rate != null);
    let bucket: ReturnType<typeof classifyCategory> = "UNCLASSIFIED";
    if (productType === "ETF") {
      const etfRows = await prisma.$queryRawUnsafe<Array<{ code: string; name: string }>>(
        `SELECT code, name FROM etfs WHERE id = $1`, productId,
      );
      if (etfRows[0]) {
        const official = await classifyEtfOfficial(etfRows[0].code, etfRows[0].name).catch(() => null);
        bucket = official?.bucket ?? "UNCLASSIFIED";
      }
    } else {
      const categoryRows = await prisma.$queryRawUnsafe<Array<{ category: string | null }>>(
        `SELECT category FROM funds WHERE id = $1`, productId,
      );
      bucket = classifyCategory(categoryRows[0]?.category ?? null);
    }
    if (bucket !== "LEVERAGE_INVERSE" && !hasFixedIncomeOrFuturesLine) {
      console.error(
        `[holdingsHistory] suppressing anomalous snapshot: ${productType} ${productId} as_of=${asOfDate} source=${source} ` +
        `weightSum=${weightSum.toFixed(2)}% exceeds ${NON_LEVERAGED_WEIGHT_SUM_CEILING_PCT}% ceiling for a non-leveraged, non-fixed-income product (category bucket=${bucket}) — not adopted`,
      );
      return { rows: [], source: null };
    }
  }

  return { rows: mapped, source };
}

export function coverageDepthOf(source: string | null): CoverageDepth {
  if (source === "ETF_OFFICIAL_DAILY_SNAPSHOT") return "FULL";
  if (source === "GLOBAL_ETF_HOLDINGS_TOP10") return "TOP_N";
  if (source === "GLOBAL_ETF_HOLDINGS_FULL") return "PARTIAL";
  if (!source) return "UNKNOWN";
  return "UNKNOWN";
}

// 2026-11-11 使用者回報核實：VOO/QQQ這類非iShares美股ETF，`holdings`表完全沒有任何一列資料——
// ETF詳情頁「持股」分頁空白、穿透分析把它們排除在外（沒有持股資料）。但`etf_holdings`這張
// 另一個既有、獨立的表其實有資料（VOO 300筆、QQQ 270筆，來自既有的全球ETF持股排程，查過是
// Yahoo topHoldings為主的廣覆蓋來源，少數有iShares/BlackRock等更完整的CSV）——只是
// holdingsHistory.ts原本只查`holdings`表，從沒讀過`etf_holdings`，兩個表從建立以來就沒有
// 互通。這裡只加一個「holdings表完全沒有資料時才查etf_holdings」的退回路徑，不动`holdings`
// 表本身任何既有邏輯，也不是把兩個表合併成一個。
// 每次排程都會疊一筆新的snapshot_id（沒有「同內容就跳過」的去重機制——這是既有排程的既有行為，
// 這裡不改），所以每個etf_id底下可能有幾十個幾乎重複的snapshot。挑規則：優先挑有真實
// effective_date的snapshot（越新越好）；完全沒有帶日期的（quality_status='PARTIAL_DATE_UNKNOWN'）
// 退而求其次挑最近一次寫入(created_at最大)的那組，asOfDate誠實回傳null（不是今天、不是猜的）。
async function fetchGlobalEtfHoldingsFallback(etfId: string): Promise<{ asOfDate: string | null; rows: HoldingRow[]; source: string } | null> {
  const pick = await prisma.$queryRawUnsafe<Array<{ snapshot_id: string; effective_date: string | null; n: number }>>(
    `SELECT snapshot_id, effective_date::text, count(*)::int n, max(created_at) latest_created
       FROM etf_holdings WHERE etf_id = $1::text
      GROUP BY snapshot_id, effective_date
      ORDER BY (effective_date IS NOT NULL) DESC, effective_date DESC NULLS LAST, latest_created DESC
      LIMIT 1`,
    etfId,
  );
  if (!pick.length) return null;
  const { snapshot_id, effective_date } = pick[0];
  // 2026-11-11 使用者回報核實：VOO等來源的etf_holdings.sector/country絕大多數是null（這張表本來
  // 就沒有官方產業分類來源），portfolioLookThrough()的「未分類」因此永遠偏高，即使securities表
  // 已經有SEC SIC回補的美股產業分類。這裡只在etf_holdings本身的sector為null、且ticker帶「.US」
  // 字尾時，用去掉字尾後的代號查securities表補上sector（scalar subquery、LIMIT 1，不會造成列數
  // 膨脹）；country同理只在「.US」字尾時補上'US'（跟mobile端COUNTRY_LABEL既有的"US"→"美國"
  // 對應一致）。非.US字尾（.HK/.TO等）没有驗證過的國家對應表，維持原樣不猜。
  // 2026-11-11 使用者回報核實+VERIFIED兩輪修正：securities.country對美股用兩種不同寫法混在
  // 一起——絕大多數（5523筆，SEC SIC全量回補寫入）是兩字代碼「US」，但有一小批20筆（剛好是
  // NVDA/AAPL/MSFT/AMZN/GOOGL/AVGO/GOOG/META/MU這種早期就存在、知名大型股）是全名「United
  // States」。第一版只比對'US'漏掉這20筆、改比對'United States'又漏掉其餘5523筆（含TSLA）——
  // 兩種寫法都要接受。同一個ticker在securities可能同時有多國掛牌（例如AAPL在CA/NEO、CA/TOR跟
  // US/NASDAQ各有一列），加exchange IN (...)排除非美股掛牌，避免挑到同代號的海外列。
  // 2026-11-12 使用者回報核實+核准定案（中文名稱缺漏「Meta Meta」重複/美光顯示英文）: 補上
  // nameZh——用去字尾後的代號查stocks.company_name_zh（CMoney抓公司簡介時同一次HTTP GET一併
  // 抓到的中文名，見stockUsCompanyProfile.ts的extractNameZh），有查到才給前端用，查不到回null，
  // 前端（displayHoldingName）會自己決定要不要退回清理過字尾的英文名，這裡不猜、不拼湊。
  const rows = await prisma.$queryRawUnsafe<Array<{
    holding_name: string; ticker: string | null; weight: string | null; sector: string | null; country: string | null; name_zh: string | null;
  }>>(
    `SELECT eh.holding_name, eh.ticker, eh.weight::text weight,
            coalesce(eh.sector, (
              SELECT sec.sector FROM securities sec
               WHERE eh.ticker ~* '\\.US$' AND sec.ticker = regexp_replace(eh.ticker, '\\.US$', '', 'i')
                 AND sec.country IN ('US','United States')
                 AND sec.exchange IN ('NASDAQ','NYSE','NYSE Arca','AMEX','NYSEARCA','NYQ','NMS','NCM','NGM')
               LIMIT 1
            )) sector,
            coalesce(eh.country, CASE WHEN eh.ticker ~* '\\.US$' THEN 'US' END) country,
            (
              SELECT s.company_name_zh FROM stocks s
               WHERE eh.ticker ~* '\\.US$' AND s.ticker = regexp_replace(eh.ticker, '\\.US$', '', 'i')
                 AND s.exchange IN ('NASDAQ','NYSE','NYSE Arca','AMEX','NYSEARCA','NYQ','NMS','NCM','NGM')
                 AND s.company_name_zh IS NOT NULL
               LIMIT 1
            ) name_zh
       FROM etf_holdings eh
      WHERE eh.snapshot_id = $1::uuid ORDER BY eh.weight DESC NULLS LAST`,
    snapshot_id,
  );
  const mapped: HoldingRow[] = rows.map((r) => ({
    key: r.ticker ? `${r.ticker}|${r.country ?? ""}` : (r.holding_name ?? snapshot_id),
    name: r.holding_name, nameZh: r.name_zh, ticker: r.ticker, weightPct: r.weight == null ? 0 : Number(r.weight), sector: r.sector, country: r.country,
  }));
  return { asOfDate: effective_date ?? null, rows: mapped, source: mapped.length <= 10 ? "GLOBAL_ETF_HOLDINGS_TOP10" : "GLOBAL_ETF_HOLDINGS_FULL" };
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
  if (!dates.length) {
    if (productType === "ETF") {
      const fallback = await fetchGlobalEtfHoldingsFallback(productId);
      if (fallback) return { asOfDate: fallback.asOfDate ?? "", rows: fallback.rows, source: fallback.source };
    }
    return null;
  }
  const { rows, source } = await fetchSnapshot(productType, productId, dates[0]);
  return { asOfDate: dates[0], rows, source };
}

export async function getTwoLatestSnapshots(productType: ProductType, productId: string): Promise<{
  latest: string; previous: string | null; latestRows: HoldingRow[]; previousRows: HoldingRow[];
  latestSource: string | null; previousSource: string | null;
}> {
  const dates = await listSnapshotDates(productType, productId, 2);
  if (!dates.length) {
    // 2026-11-11：holdings表沒有任何歷史快照時退回etf_holdings——那張表每次排程都疊一筆新
    // snapshot，沒有「兩期」的概念（挑出來的就是目前唯一認定的「最新一筆」），所以這裡只填
    // latest，previous誠實留null，呼叫端既有的「hasEnoughHistory:false」會接手，不會假造一組
    // 「兩期比較」出來。
    if (productType === "ETF") {
      const fallback = await fetchGlobalEtfHoldingsFallback(productId);
      if (fallback) {
        return { latest: fallback.asOfDate ?? "", previous: null, latestRows: fallback.rows, previousRows: [], latestSource: fallback.source, previousSource: null };
      }
    }
    return { latest: "", previous: null, latestRows: [], previousRows: [], latestSource: null, previousSource: null };
  }
  const latestSnap = await fetchSnapshot(productType, productId, dates[0]);
  const previousSnap = dates[1] ? await fetchSnapshot(productType, productId, dates[1]) : { rows: [], source: null };
  return { latest: dates[0], previous: dates[1] ?? null, latestRows: latestSnap.rows, previousRows: previousSnap.rows, latestSource: latestSnap.source, previousSource: previousSnap.source };
}
