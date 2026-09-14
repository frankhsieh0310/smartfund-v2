// Yahoo US mutual-fund ingestion — screener discovery + v10 quoteSummary enrich + Tier-A
// Fund Master / Share Class collapse + fund_history NAV backfill + master-level holdings.
//
// Data model (reuses existing tables, no schema change beyond additive funds.morningstar_* cols):
//   fund_master           1 row per distinct portfolio   (Tier A key = family + normalized name stem)
//   funds                 1 row per Yahoo symbol (a class instance)  data_provider='yahoo', data_source=<symbol>
//   fund_share_classes    1 row per Yahoo symbol          source='YAHOO_US_MF_V1', master_fund_id -> master
//   fund_provider_mappings (fund_id, provider='YAHOO')     provider_code=<symbol>, source='YAHOO_US_MF_V1'
//   fund_history          NAV daily (upsert fund_id,date)
//   holdings              master-level only, source='YAHOO_QUOTE_SUMMARY' (delete+insert = idempotent)
//
// Guarantees: deterministic keys; idempotent (re-run changes nothing new); Morningstar overall/risk/
//   category/rank only written when the provider returns a value (never null-clobber); one holdings
//   write per master per run; fully reversible via source='YAHOO_US_MF_V1'.
// Morningstar fields are FUND-ONLY.

import { fetchQuoteSummary, fetchChartFull, screenerPage, rawNum, rawText, sleep, type RateStats } from "./productSession";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

// 2026-09-11 module split (same ETF-reliability fix applied here per the Fund sweep mandate):
// topHoldings fetched separately so a holdings-only miss never blocks core metadata/Morningstar/NAV.
const FUND_CORE_MODULES = ["fundProfile", "defaultKeyStatistics", "fundPerformance", "summaryDetail", "price"];
const FUND_HOLDINGS_MODULES = ["topHoldings"];
const SOURCE = "YAHOO_US_MF_V1";
const pctp = (v: any): number | null => {
  const raw = rawNum(v);
  if (raw == null) return null;
  return Math.abs(raw) <= 3 ? raw * 100 : raw;
};

// ---- Tier-A master key: family + stem (strip class-suffix tokens). No name-only merge. ----
const SUFFIX_RE =
  /\s+(?:Class\s+)?(?:A|B|C|D|F|F-?1|F-?2|F-?3|I|II|III|R|R-?1|R-?2|R-?3|R-?4|R-?5|R-?6|R-?2E|R-?5E|K|K6|Adm|Admiral|Inv|Investor|Instl?(?:\s*(?:Pl(?:us)?|Sel(?:ect)?|Prm|Premier))?|Institutional|Inst(?:\s*(?:Pl(?:us)?|Sel(?:ect)?))?|529-?[A-F0-9-]+|Select|Retail|Svc|Service|Advisor|Adv|No Load|NL|Load)\b.*$/i;
export function masterStem(name: string): string {
  return (name || "")
    .replace(/\s+/g, " ")
    .replace(SUFFIX_RE, "")
    .replace(/[^A-Za-z0-9 &/.-]/g, "")
    .trim()
    .toLowerCase();
}

export type FundRecord = {
  symbol: string;
  name: string;
  family: string | null;
  category: string | null;
  currency: string | null;
  legalType: string | null;
  msOverall: number | null;
  msRisk: number | null;
  msCategory: string | null;
  msRank3y: number | null;
  r1y: number | null; r3y: number | null; r5y: number | null; r10y: number | null;
  netExpense: number | null;
  grossExpense: number | null;
  netAssets: number | null;
  navPrice: number | null;
  initInvestment: number | null;
  inceptionEpoch: number | null;
  topHoldings: Array<{ rank: number; name: string; ticker: string | null; weight: number | null }>;
  holdingsAvailable: boolean; // false = holdings quoteSummary call failed/empty; not the same as "no holdings"
  qsUrl: string;
};

export async function enrichFundFromYahoo(symbol: string, stats?: RateStats): Promise<FundRecord | null> {
  const qs = await fetchQuoteSummary(symbol, FUND_CORE_MODULES, stats);
  if (!qs) return null;
  const r = qs.result;
  const fp = r.fundProfile ?? {}, ks = r.defaultKeyStatistics ?? {}, pf = r.fundPerformance ?? {}, sd = r.summaryDetail ?? {}, pr = r.price ?? {};
  if ((pr.quoteType ?? "").toUpperCase() !== "MUTUALFUND") return null;
  const trailing = pf.trailingReturns ?? {};

  // Holdings module fetched separately — its failure never blocks core/Morningstar/NAV below.
  const hqs = await fetchQuoteSummary(symbol, FUND_HOLDINGS_MODULES, stats);
  const th = hqs?.result?.topHoldings ?? {};

  return {
    symbol,
    name: rawText(pr.longName) ?? rawText(pr.shortName) ?? symbol,
    family: rawText(fp.family),
    category: rawText(fp.categoryName),
    currency: rawText(pr.currency),
    legalType: rawText(fp.legalType),
    msOverall: rawNum(ks.morningStarOverallRating),
    msRisk: rawNum(ks.morningStarRiskRating),
    msCategory: rawText(fp.categoryName),
    msRank3y: rawNum(pf.rankInCategory?.threeYear),
    r1y: pctp(trailing.oneYear), r3y: pctp(trailing.threeYear), r5y: pctp(trailing.fiveYear), r10y: pctp(trailing.tenYear),
    netExpense: rawNum(fp.feesExpensesInvestment?.annualReportExpenseRatio ?? ks.annualReportExpenseRatio),
    grossExpense: rawNum(fp.feesExpensesInvestment?.grossExpRatio),
    netAssets: rawNum(ks.totalAssets ?? sd.totalAssets),
    navPrice: rawNum(sd.navPrice ?? pr.regularMarketPrice),
    initInvestment: rawNum(fp.initInvestment),
    inceptionEpoch: rawNum(ks.fundInceptionDate),
    topHoldings: (Array.isArray(th.holdings) ? th.holdings : [])
      .map((h: any, i: number) => {
        const nm = rawText(h?.holdingName) ?? rawText(h?.name);
        return nm ? { rank: i + 1, name: nm, ticker: rawText(h?.symbol), weight: pctp(h?.holdingPercent ?? h?.weight) } : null;
      })
      .filter(Boolean) as FundRecord["topHoldings"],
    holdingsAvailable: !!hqs,
    qsUrl: qs.url,
  };
}

// ---- discovery: iterate Morningstar categories (screener needs a categorical anchor) ----
export const DISCOVERY_CATEGORIES = [
  "Large Blend", "Large Growth", "Large Value",            // 股票型 / 成長 / 價值
  "Intermediate Core Bond", "Multisector Bond",            // 債券型
  "High Yield Bond",                                       // 高收益債
  "Allocation--50% to 70% Equity", "Moderate Allocation",  // 平衡型
  "Foreign Large Blend", "Diversified Emerging Mkts",      // 全球股票 / 新興市場
  "Technology",                                            // 科技型
];

export async function discoverUsFunds(
  opts: { categories?: string[]; perCategory?: number; minRating?: number; stats?: RateStats },
): Promise<{ symbols: string[]; perCategoryTotals: Record<string, number> }> {
  const cats = opts.categories ?? DISCOVERY_CATEGORIES;
  const per = opts.perCategory ?? 25;
  const minRating = opts.minRating ?? 1;
  const seen = new Set<string>();
  const perCategoryTotals: Record<string, number> = {};
  for (const cat of cats) {
    for (let offset = 0; offset < per; offset += 25) {
      const page = await screenerPage(
        "MUTUALFUND",
        [
          { operator: "EQ", operands: ["categoryname", cat] },
          { operator: "GTE", operands: ["morningstaroverallrating", minRating] },
        ],
        offset,
        25,
        "fundnetassets",
        opts.stats,
      );
      if (offset === 0) perCategoryTotals[cat] = page.total;
      for (const s of page.symbols) seen.add(s);
      if (page.symbols.length < 25) break;
    }
  }
  return { symbols: [...seen], perCategoryTotals };
}

// ---- full-sweep discovery: US-region universe (~27k share classes). Confirmed empirically
// (2026-09-11) that MUTUALFUND screener's region=EQ filter DOES narrow correctly (unlike ETF, where
// it's a no-op) — plain {GT fundnetassets 0, EQ region us} totals ~27.4k, matching Yahoo's own
// US mutual-fund catalog size. Two passes, deduped into one Set:
//   1) plain region=us pagination (top ~10-12k by net assets — Yahoo screener offset appears to clamp
//      somewhere around that point; verified offset=10000 and 12000 return the same page).
//   2) region=us + categoryname EQ for every category below (no rating filter — unrated/new funds
//      still counted, unlike discoverUsFunds's minRating default), covering the long tail outside the
//      top-AUM window. Categories with a confirmed nonzero Yahoo total as of 2026-09-11; a handful of
//      categories (e.g. "World Stock", "World Bond", "Market Neutral") return 0 under every spelling
//      tried and are left out — expand this list if a later run finds a working alternate name.
export const FULL_SWEEP_CATEGORIES = [
  "Large Blend", "Large Growth", "Large Value", "Mid-Cap Blend", "Mid-Cap Growth", "Mid-Cap Value",
  "Small Blend", "Small Growth", "Small Value", "Foreign Large Blend", "Foreign Large Growth",
  "Foreign Large Value", "Foreign Small/Mid Blend", "Diversified Emerging Mkts", "World Stock",
  "Global Real Estate", "Real Estate", "Technology", "Health", "Financial", "Natural Resources",
  "Utilities", "Communications", "Consumer Cyclical", "Consumer Defensive", "Industrials",
  "Equity Energy", "Equity Precious Metals", "Miscellaneous Sector",
  "Intermediate Core Bond", "Intermediate Core-Plus Bond", "Short-Term Bond", "Long-Term Bond",
  "Ultrashort Bond", "High Yield Bond", "Multisector Bond", "Emerging Markets Bond", "Bank Loan",
  "Inflation-Protected Bond", "Muni National Long", "Muni National Interm", "Muni National Short",
  "High Yield Muni", "Muni Single State Long",
  "Moderate Allocation", "Conservative Allocation", "Target-Date 2030", "Target-Date 2040",
  "Target-Date 2050", "Target-Date Retirement", "Convertibles", "Multialternative",
  "Long-Short Equity", "Commodities Broad Basket", "Trading--Leveraged Equity",
];

export async function discoverAllUsFunds(
  opts: { categories?: string[]; topPages?: number; perCategoryPages?: number; stats?: RateStats },
): Promise<{ symbols: string[]; topPassCount: number; perCategoryTotals: Record<string, number> }> {
  const cats = opts.categories ?? FULL_SWEEP_CATEGORIES;
  const topPages = opts.topPages ?? 39; // 39 * 250 ~= 9750, below the observed offset clamp
  const catPages = opts.perCategoryPages ?? 20; // 20 * 25 = 500 per category
  const seen = new Set<string>();

  for (let p = 0; p < topPages; p++) {
    const page = await screenerPage(
      "MUTUALFUND",
      [{ operator: "GT", operands: ["fundnetassets", 0] }, { operator: "EQ", operands: ["region", "us"] }],
      p * 250, 250, "fundnetassets", opts.stats,
    );
    for (const s of page.symbols) seen.add(s);
    if (page.symbols.length < 250) break;
    await sleep(250);
  }
  const topPassCount = seen.size;

  const perCategoryTotals: Record<string, number> = {};
  for (const cat of cats) {
    for (let p = 0; p < catPages; p++) {
      const page = await screenerPage(
        "MUTUALFUND",
        [{ operator: "EQ", operands: ["categoryname", cat] }, { operator: "EQ", operands: ["region", "us"] }],
        p * 25, 25, "fundnetassets", opts.stats,
      );
      if (p === 0) perCategoryTotals[cat] = page.total;
      for (const s of page.symbols) seen.add(s);
      if (page.symbols.length < 25) break;
      await sleep(250);
    }
  }
  return { symbols: [...seen], topPassCount, perCategoryTotals };
}

export type IngestResult = {
  symbol: string;
  ok: boolean; // true iff CORE (master/funds row/share class/provider mapping incl. Morningstar) succeeded
  coreOk: boolean;
  navHistoryOk: boolean;
  holdingsOk: boolean; // true iff the holdings WRITE step ran without throwing (0 rows written is not a failure)
  shareClassInserted: boolean;
  shareClassUpdated: boolean;
  masterCreated: boolean;
  masterLinked: boolean;
  navRowsWritten: number;
  distributionRows: number;
  holdingsWritten: number;
  morningstar: { overall: number | null; risk: number | null; category: string | null; rank: number | null };
  error?: string;
};

/**
 * Idempotent ingest of one Yahoo US-MF symbol.
 * @param mastersHoldingsWrittenThisRun a Set the caller shares across the batch to enforce
 *   "one holdings write per master per run".
 */
export async function ingestUsFundShareClass(
  query: QueryFn,
  rec: FundRecord,
  mastersHoldingsWrittenThisRun: Set<string>,
): Promise<IngestResult> {
  const res: IngestResult = {
    symbol: rec.symbol, ok: false, coreOk: false, navHistoryOk: false, holdingsOk: false,
    shareClassInserted: false, shareClassUpdated: false,
    masterCreated: false, masterLinked: false, navRowsWritten: 0, distributionRows: 0, holdingsWritten: 0,
    morningstar: { overall: rec.msOverall, risk: rec.msRisk, category: rec.msCategory, rank: rec.msRank3y },
  };
  try {
    const stem = masterStem(rec.name);
    const family = rec.family ?? "UNKNOWN";
    const providerMasterKey = `YAHOO:${family}|${stem}`.slice(0, 200);

    // --- 1) Fund Master (Tier A: exact family+stem). SELECT-then-INSERT (no unique on provider_master_key).
    let masterId: string | null = null;
    const m = await query(`SELECT id::text FROM fund_master WHERE provider_master_key = $1 LIMIT 1`, [providerMasterKey]);
    if (m[0]) { masterId = m[0].id; res.masterLinked = true; }
    else {
      const ins = await query(
        `INSERT INTO fund_master (id, canonical_name, base_currency, provider_master_key, created_at, updated_at)
         VALUES (gen_random_uuid()::text, $1, $2, $3, NOW(), NOW()) RETURNING id::text`,
        [rec.name.replace(SUFFIX_RE, "").trim().slice(0, 240) || rec.name.slice(0, 240), rec.currency, providerMasterKey],
      );
      masterId = ins[0].id;
      res.masterCreated = true;
    }

    // --- 2) funds row (1 per Yahoo symbol). Dedup by (data_provider='yahoo', data_source=symbol).
    const existingFund = await query(
      `SELECT id::text FROM funds WHERE data_provider = 'yahoo' AND data_source = $1 AND last_nav_source = 'YAHOO_QUOTE_SUMMARY' LIMIT 1`,
      [rec.symbol],
    );
    let fundId: string;
    const navDateSql = "CURRENT_DATE";
    if (existingFund[0]) {
      fundId = existingFund[0].id;
      await query(
        `UPDATE funds SET
           name = $2::text, legal_name = $2::text, company = $3::text, currency = COALESCE($4::text, currency),
           category = COALESCE($5::text, category), region = 'US',
           morningstar = COALESCE($6::int, morningstar),
           morningstar_risk = COALESCE($7::int, morningstar_risk),
           morningstar_category = COALESCE($8::text, morningstar_category),
           morningstar_category_rank_3y = COALESCE($9::int, morningstar_category_rank_3y),
           morningstar_source = CASE WHEN $6::int IS NOT NULL OR $7::int IS NOT NULL OR $8::text IS NOT NULL THEN 'YAHOO_QUOTE_SUMMARY' ELSE morningstar_source END,
           morningstar_updated_at = CASE WHEN $6::int IS NOT NULL OR $7::int IS NOT NULL OR $8::text IS NOT NULL THEN NOW() ELSE morningstar_updated_at END,
           return_1y = COALESCE($10::numeric, return_1y), return_3y = COALESCE($11::numeric, return_3y),
           return_5y = COALESCE($12::numeric, return_5y), return_10y = COALESCE($13::numeric, return_10y),
           expense_ratio = COALESCE($14::numeric, expense_ratio), aum = COALESCE($15::numeric, aum),
           latest_nav = COALESCE($16::numeric, latest_nav),
           inception_date = COALESCE(to_timestamp($17::numeric)::date, inception_date),
           data_provider = 'yahoo', last_nav_source = 'YAHOO_QUOTE_SUMMARY', updated_at = NOW()
         WHERE id = $1`,
        [fundId, rec.name.slice(0, 500), (rec.family ?? "UNKNOWN").slice(0, 200), rec.currency, rec.category,
         rec.msOverall, rec.msRisk, rec.msCategory, rec.msRank3y,
         rec.r1y, rec.r3y, rec.r5y, rec.r10y, rec.netExpense, rec.netAssets, rec.navPrice, rec.inceptionEpoch],
      );
      res.shareClassUpdated = true;
    } else {
      const ins = await query(
        `INSERT INTO funds
           (id, name, legal_name, company, currency, category, region, morningstar, morningstar_risk,
            morningstar_category, morningstar_category_rank_3y, morningstar_source, morningstar_updated_at,
            return_1y, return_3y, return_5y, return_10y, expense_ratio, aum, latest_nav, latest_nav_date,
            inception_date, is_active, data_provider, data_source, last_nav_source, created_at, updated_at)
         VALUES
           (gen_random_uuid()::text, $1::text, $1::text, $2::text, COALESCE($3::text,'USD'), $4::text, 'US', $5::int, $6::int,
            $7::text, $8::int, CASE WHEN $5::int IS NOT NULL OR $6::int IS NOT NULL THEN 'YAHOO_QUOTE_SUMMARY' END,
            CASE WHEN $5::int IS NOT NULL OR $6::int IS NOT NULL THEN NOW() END,
            $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15::numeric, ${navDateSql},
            to_timestamp($16::numeric)::date, true, 'yahoo', $17::text, 'YAHOO_QUOTE_SUMMARY', NOW(), NOW())
         RETURNING id::text`,
        [rec.name.slice(0, 500), (rec.family ?? "UNKNOWN").slice(0, 200), rec.currency, rec.category,
         rec.msOverall, rec.msRisk, rec.msCategory, rec.msRank3y,
         rec.r1y, rec.r3y, rec.r5y, rec.r10y, rec.netExpense, rec.netAssets, rec.navPrice, rec.inceptionEpoch, rec.symbol],
      );
      fundId = ins[0].id;
      res.shareClassInserted = true;
    }

    // --- 3) fund_share_classes (1 per symbol), linked to master
    await query(
      `INSERT INTO fund_share_classes
         (id, fund_id, share_class_name, share_class_code, currency, status, source, source_record_id,
          minimum_initial_investment, master_fund_id, share_class_type, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1::text, $2::text, $3::text, $4::text, 'ACTIVE', $5::text, $3::text, $6::numeric, $7::text, $8::text, NOW(), NOW())
       ON CONFLICT DO NOTHING`,
      [fundId, rec.name.slice(0, 500), rec.symbol, rec.currency, SOURCE, rec.initInvestment, masterId,
       rec.legalType?.slice(0, 60) ?? null],
    );
    const scRow = await query(
      `SELECT id::text FROM fund_share_classes WHERE fund_id = $1 AND share_class_code = $2 LIMIT 1`,
      [fundId, rec.symbol],
    );
    const shareClassId = scRow[0]?.id ?? null;
    // keep master link current
    if (shareClassId) await query(`UPDATE fund_share_classes SET master_fund_id = $2, updated_at = NOW() WHERE id = $1 AND master_fund_id IS DISTINCT FROM $2`, [shareClassId, masterId]);
    // set master representative if empty
    await query(`UPDATE fund_master SET representative_fund_id = COALESCE(representative_fund_id, $2), updated_at = NOW() WHERE id = $1`, [masterId, fundId]);

    // --- 4) provider mapping (unique on fund_id, provider)
    await query(
      `INSERT INTO fund_provider_mappings
         (id, fund_id, provider, provider_code, status, mapping_method, verified_at, source, share_class_id, created_at, updated_at, last_checked_at)
       VALUES (gen_random_uuid()::text, $1::text, 'YAHOO', $2::text, 'VERIFIED', 'SCREENER_QUOTESUMMARY', NOW(), $3::text, $4::text, NOW(), NOW(), NOW())
       ON CONFLICT (fund_id, provider) DO UPDATE SET
         provider_code = EXCLUDED.provider_code, status = 'VERIFIED', verified_at = NOW(),
         mapping_method = 'SCREENER_QUOTESUMMARY', source = EXCLUDED.source, share_class_id = EXCLUDED.share_class_id, updated_at = NOW()`,
      [fundId, rec.symbol, SOURCE, shareClassId],
    );

    // Core identity (master + funds row incl. Morningstar + share class + provider mapping) is done.
    // NAV history and holdings below are independent write phases — either one throwing must not
    // erase this credit (same ETF-sweep write-isolation fix, applied here per the Fund sweep mandate).
    res.coreOk = true;
    res.ok = true;

    // --- 5) NAV history + distributions (chart, no crumb) — bounded to since-last + 5d overlap
    try {
      const last = await query(`SELECT max(date)::text d FROM fund_history WHERE fund_id = $1`, [fundId]);
      const lastDate: string | null = last[0]?.d ?? null;
      const period1 = lastDate ? Math.floor((Date.parse(lastDate) - 5 * 86_400_000) / 1000) : 0;
      const chart = await fetchChartFull(rec.symbol, { period1 });
      if (chart) {
        const navs = chart.candles.filter((c) => Number.isFinite(c.close) && (c.close as number) > 0);
        for (let i = 0; i < navs.length; i += 500) {
          const chunk = navs.slice(i, i + 500);
          const r2 = await query(
            `INSERT INTO fund_history (id, fund_id, date, nav, created_at)
             SELECT gen_random_uuid()::text, $1, x.date::date, x.nav, NOW()
             FROM jsonb_to_recordset($2::jsonb) AS x(date text, nav numeric)
             ON CONFLICT (fund_id, date) DO UPDATE SET nav = COALESCE(fund_history.nav, EXCLUDED.nav)
             RETURNING 1`,
            [fundId, JSON.stringify(chunk.map((c) => ({ date: c.date, nav: c.adjClose ?? c.close })))],
          );
          res.navRowsWritten += r2.length;
        }
        if (chart.regularMarketPrice != null) {
          await query(
            `UPDATE funds SET latest_nav = COALESCE($2, latest_nav), latest_nav_date = COALESCE($3::date, latest_nav_date), updated_at = NOW() WHERE id = $1`,
            [fundId, chart.regularMarketPrice, chart.regularMarketTime],
          );
        }
        // distributions -> reuse fund dividend_yield? there is no fund distribution table; record count only.
        res.distributionRows = chart.dividends.length;
      }
      res.navHistoryOk = true;
    } catch (e) {
      res.error = `NAV_HISTORY_FAILED: ${String((e as Error).message ?? e).slice(0, 160)}`;
    }

    // --- 6) holdings at MASTER level only, once per master per run
    try {
      if (masterId && !mastersHoldingsWrittenThisRun.has(masterId) && rec.holdingsAvailable && rec.topHoldings.length) {
        mastersHoldingsWrittenThisRun.add(masterId);
        // idempotent replace of this master representative's YAHOO holdings
        await query(`DELETE FROM holdings WHERE fund_id = $1 AND source = 'YAHOO_QUOTE_SUMMARY'`, [fundId]);
        const asOf = new Date().toISOString().slice(0, 10);
        for (const h of rec.topHoldings) {
          await query(
            `INSERT INTO holdings (id, asset_type, fund_id, share_class_id, as_of_date, rank, holding_name, holding_code, weight, source, source_record_id, created_at)
             VALUES (gen_random_uuid()::text, 'FUND', $1::text, NULL, $2::date, $3::int, $4::text, $5::text, $6::numeric, 'YAHOO_QUOTE_SUMMARY', $7::text, NOW())`,
            [fundId, asOf, h.rank, h.name.slice(0, 300), h.ticker, h.weight == null ? null : h.weight / 100, `${h.rank}:${(h.ticker ?? h.name).slice(0, 80)}`],
          );
        }
        res.holdingsWritten = rec.topHoldings.length;
      }
      res.holdingsOk = rec.holdingsAvailable;
    } catch (e) {
      res.error = (res.error ? res.error + "; " : "") + `HOLDINGS_FAILED: ${String((e as Error).message ?? e).slice(0, 160)}`;
    }

    return res;
  } catch (e) {
    res.error = String((e as Error).message ?? e);
    return res;
  }
}
