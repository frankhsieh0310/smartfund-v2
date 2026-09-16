// Yahoo ETF product enrichment — v10 quoteSummary -> etfs metadata + etf_performances +
// etf_holdings/etf_holding_snapshots (top holdings) + etf_sector_allocations +
// etf_credit_rating_allocations. Idempotent COALESCE upserts (never overwrite non-null with null).
// SQL mirrors the battle-tested scripts/data/etf-yahoo/run-etf-yahoo-product-modules.ts.
//
// Source priority: this writes source='YAHOO_QUOTE_SUMMARY'. Official-issuer / MoneyDJ holdings
// snapshots live under their own source and are NOT touched here — a completeness_status of
// 'TOP_HOLDINGS_ONLY' + a distinct source means readers that prefer OFFICIAL_ISSUER > MONEYDJ > YAHOO
// keep doing so. No ETF Morningstar fields are written (Yahoo doesn't expose them for ETFs).

import { fetchQuoteSummary, rawNum, rawText, type RateStats } from "./productSession";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

// 2026-09-11 module split (STEP 6 of the enrich-reliability fix): topHoldings is fetched in its own
// quoteSummary call so a holdings-specific failure (or the extra payload weight making that one call
// more likely to time out) never takes metadata/performance down with it. Core writes happen the
// moment the core call succeeds, independent of whether the holdings call below it succeeds.
const ETF_CORE_MODULES = ["fundProfile", "fundPerformance", "defaultKeyStatistics", "summaryDetail", "price"];
const ETF_HOLDINGS_MODULES = ["topHoldings"];

const pct = (v: any): number | null => {
  const raw = rawNum(v);
  if (raw == null) return null;
  const fmt = v && typeof v === "object" && typeof v.fmt === "string" ? v.fmt : "";
  return fmt.includes("%") || Math.abs(raw) <= 2 ? raw * 100 : raw;
};
const wt = (v: any): number | null => {
  const raw = rawNum(v);
  if (raw != null) return raw;
  const f = v && typeof v === "object" ? v.fmt : v;
  if (typeof f !== "string") return null;
  const n = Number(f.replace("%", "").replaceAll(",", "").trim());
  return Number.isFinite(n) ? n / 100 : null;
};
const allocRows = (v: any): Array<{ name: string; weight: number }> =>
  (Array.isArray(v) ? v : []).flatMap((e: any) =>
    Object.entries(e ?? {}).flatMap(([k, raw]) => {
      const name = rawText(k);
      const weight = wt(raw);
      return name && weight != null && weight >= 0 && weight <= 1 ? [{ name, weight }] : [];
    }),
  );

export type EtfEnrichResult = {
  etfId: string;
  symbol: string;
  ok: boolean; // true iff CORE metadata succeeded — a holdings-only failure still leaves ok=true
  coreOk: boolean;
  holdingsOk: boolean;
  metadataChanged: number;
  performanceWritten: number;
  holdingsWritten: number;
  sectorAllocWritten: number;
  creditAllocWritten: number;
  error?: string;
};

export async function enrichEtfProduct(
  query: QueryFn,
  input: { etfId: string; symbol: string },
  stats?: RateStats,
): Promise<EtfEnrichResult> {
  const out: EtfEnrichResult = {
    etfId: input.etfId, symbol: input.symbol, ok: false, coreOk: false, holdingsOk: false,
    metadataChanged: 0, performanceWritten: 0, holdingsWritten: 0, sectorAllocWritten: 0, creditAllocWritten: 0,
  };
  const qs = await fetchQuoteSummary(input.symbol, ETF_CORE_MODULES, stats);
  if (!qs) { out.error = "NO_QUOTE_SUMMARY_CORE"; return out; }
  out.coreOk = true;
  const r = qs.result;
  const fp = r.fundProfile ?? {}, ks = r.defaultKeyStatistics ?? {}, sd = r.summaryDetail ?? {}, pr = r.price ?? {};
  const perf = r.fundPerformance ?? {};
  const retrievedAt = new Date().toISOString();
  const srcUrl = qs.url;

  // Holdings module fetched separately — its failure never rolls back the core writes below.
  const hqs = await fetchQuoteSummary(input.symbol, ETF_HOLDINGS_MODULES, stats);
  const th = hqs?.result?.topHoldings ?? {};
  out.holdingsOk = !!hqs;

  // 2026-09-11: everything from here down is DB writes, not Yahoo calls. quoteSummary already
  // succeeded above (out.coreOk=true) — a transient write failure (pooled-connection hiccup, one bad
  // row) must not erase that and get this ETF miscounted as a Yahoo/session failure. Wrap the writes
  // so a mid-way exception still returns coreOk=true with whatever partial writes landed, instead of
  // throwing out to the caller and looking identical to "quoteSummary itself failed".
  try {
    await writeEtfEnrichData(query, input, { fp, ks, sd, pr, perf, th, srcUrl, retrievedAt }, out);
  } catch (e) {
    out.error = `WRITE_FAILED: ${String((e as Error).message ?? e).slice(0, 200)}`;
  }
  out.ok = true;
  return out;
}

async function writeEtfEnrichData(
  query: QueryFn,
  input: { etfId: string; symbol: string },
  ctx: { fp: any; ks: any; sd: any; pr: any; perf: any; th: any; srcUrl: string; retrievedAt: string },
  out: EtfEnrichResult,
): Promise<void> {
  const { fp, ks, sd, pr, perf, th, srcUrl, retrievedAt } = ctx;
  // 1) etfs metadata (COALESCE — never clobber a good value with null)
  const md = {
    nameEn: rawText(pr.longName) ?? rawText(pr.shortName),
    category: rawText(fp.categoryName),
    currency: rawText(pr.currency),
    inception: rawNum(ks.fundInceptionDate),
    nav: rawNum(sd.navPrice),
    aum: rawNum(sd.totalAssets ?? ks.totalAssets),
    expense: rawNum(fp.feesExpensesInvestment?.annualReportExpenseRatio ?? ks.annualReportExpenseRatio),
    yield: rawNum(sd.yield),
    beta: rawNum(ks.beta3Year),
    w52hi: rawNum(sd.fiftyTwoWeekHigh),
    w52lo: rawNum(sd.fiftyTwoWeekLow),
    d50: rawNum(sd.fiftyDayAverage),
    d200: rawNum(sd.twoHundredDayAverage),
  };
  out.metadataChanged = Object.values(md).filter((v) => v != null).length;
  if (out.metadataChanged) {
    await query(
      `UPDATE etfs SET
         name_en = COALESCE($2, name_en),
         category = COALESCE($3, category),
         currency = COALESCE($4, currency),
         inception_date = COALESCE(to_timestamp($5)::date, inception_date),
         latest_nav = COALESCE($6, latest_nav),
         aum = COALESCE($7, aum),
         expense_ratio = COALESCE($8, expense_ratio),
         dividend_yield = COALESCE($9, dividend_yield),
         beta = COALESCE($10, beta),
         data_provider = 'yahoo-finance',
         updated_at = NOW()
       WHERE id = $1`,
      [input.etfId, md.nameEn, md.category, md.currency, md.inception, md.nav, md.aum, md.expense, md.yield, md.beta],
    );
  }
  // NAV must carry its own as-of date, distinct from market_close_date — never the ingestion
  // clock. Yahoo's quoteSummary navPrice doesn't carry an explicit as-of timestamp for ETFs, but
  // an ETF's official NAV is published once per completed trading session, dated to that same
  // session's close (the convention Yahoo/every issuer site itself displays NAV under). So the
  // NAV's source date is this ETF's own latest recorded market-close date — a real, source-driven
  // date already captured by the market-price writer (run-global-etf-latest.ts /
  // lib/yahoo/etfHistory.ts), never "today". If no market-close row exists yet for this ETF, NAV
  // is skipped rather than guessing a date.
  if (md.nav != null) {
    const latestClose = await query(
      `SELECT date::text AS date FROM etf_history WHERE etf_id = $1 AND price IS NOT NULL ORDER BY date DESC LIMIT 1`,
      [input.etfId],
    );
    const navDate: string | null = latestClose[0]?.date ?? null;
    if (navDate) {
      await query(
        `INSERT INTO etf_history (id, etf_id, date, nav, source, source_url, known_at)
         VALUES (gen_random_uuid()::text, $1, $2::date, $3, 'YAHOO_QUOTE_SUMMARY', $4, $5::timestamptz)
         ON CONFLICT (etf_id, date) DO UPDATE SET
           nav = EXCLUDED.nav, known_at = GREATEST(etf_history.known_at, EXCLUDED.known_at)
         WHERE etf_history.nav IS DISTINCT FROM EXCLUDED.nav`,
        [input.etfId, navDate, md.nav, srcUrl, retrievedAt],
      );
    }
  }

  // 2) performance -> etf_performances + etfs trailing returns
  const trailing = perf.trailingReturns ?? {};
  const p = {
    r1m: pct(trailing.oneMonth), r3m: pct(trailing.threeMonth), r6m: pct(trailing.sixMonth),
    rytd: pct(trailing.ytd), r1y: pct(trailing.oneYear), r3y: pct(trailing.threeYear), r5y: pct(trailing.fiveYear),
  };
  if (Object.values(p).some((v) => v != null)) {
    const d = new Date().toISOString().slice(0, 10);
    await query(
      `INSERT INTO etf_performances (id, etf_id, date, return_1m, return_3m, return_6m, return_ytd, return_1y, return_3y, return_5y, created_at)
       VALUES (gen_random_uuid()::text, $1, $2::date, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (etf_id, date) DO UPDATE SET
         return_1m = COALESCE(EXCLUDED.return_1m, etf_performances.return_1m),
         return_3m = COALESCE(EXCLUDED.return_3m, etf_performances.return_3m),
         return_6m = COALESCE(EXCLUDED.return_6m, etf_performances.return_6m),
         return_ytd = COALESCE(EXCLUDED.return_ytd, etf_performances.return_ytd),
         return_1y = COALESCE(EXCLUDED.return_1y, etf_performances.return_1y),
         return_3y = COALESCE(EXCLUDED.return_3y, etf_performances.return_3y),
         return_5y = COALESCE(EXCLUDED.return_5y, etf_performances.return_5y)`,
      [input.etfId, d, p.r1m, p.r3m, p.r6m, p.rytd, p.r1y, p.r3y, p.r5y],
    );
    await query(
      `UPDATE etfs SET
         return_1m = COALESCE($2, return_1m), return_3m = COALESCE($3, return_3m), return_6m = COALESCE($4, return_6m),
         return_ytd = COALESCE($5, return_ytd), return_1y = COALESCE($6, return_1y),
         return_3y = COALESCE($7, return_3y), return_5y = COALESCE($8, return_5y), updated_at = NOW()
       WHERE id = $1`,
      [input.etfId, p.r1m, p.r3m, p.r6m, p.rytd, p.r1y, p.r3y, p.r5y],
    );
    out.performanceWritten = 1;
  }

  // 3) top holdings -> etf_holding_snapshots (date-unknown) + etf_holdings
  const holdings = (Array.isArray(th.holdings) ? th.holdings : [])
    .map((row: any, i: number) => {
      const name = rawText(row?.holdingName) ?? rawText(row?.name);
      return name ? { rank: i + 1, name, ticker: rawText(row?.symbol), weight: pct(row?.holdingPercent ?? row?.weight), raw: row } : null;
    })
    .filter(Boolean) as Array<{ rank: number; name: string; ticker: string | null; weight: number | null; raw: any }>;
  if (holdings.length) {
    const sourceRecordId = `YAHOO:${input.symbol}:${new Date().toISOString().slice(0, 10)}`;
    const found = await query(
      `SELECT id::text FROM etf_holding_snapshots
        WHERE etf_id = $1 AND source = 'YAHOO_QUOTE_SUMMARY' AND source_record_id = $2 AND effective_date IS NULL LIMIT 1`,
      [input.etfId, sourceRecordId],
    );
    let snapId = found[0]?.id;
    if (!snapId) {
      const ins = await query(
        `INSERT INTO etf_holding_snapshots
           (id, etf_id, effective_date, report_date, source, source_type, source_url, source_record_id, retrieved_at,
            checksum, source_row_count, parsed_row_count, canonical_row_count, verification_status, license_status,
            completeness_status, quality_status, quality_metrics, parser_version, archive_lineage)
         VALUES (gen_random_uuid(), $1, NULL, NULL, 'YAHOO_QUOTE_SUMMARY', 'PROVIDER_OBSERVATION', $2, $3, $4::timestamptz,
            $5, $6, $6, $6, 'SOURCE_PARSED', 'TERMS_REVIEW_REQUIRED', 'TOP_HOLDINGS_ONLY', 'PARTIAL_DATE_UNKNOWN',
            $7::jsonb, 'yahoo-top-holdings-v2', $8::jsonb)
         RETURNING id::text`,
        [
          input.etfId, srcUrl, sourceRecordId, retrievedAt, input.symbol.slice(0, 32) || retrievedAt, holdings.length,
          JSON.stringify({ sourceDateStatus: "UNKNOWN", retrievedAt }),
          JSON.stringify({ provider: "YAHOO_QUOTE_SUMMARY", module: "topHoldings", symbol: input.symbol }),
        ],
      );
      snapId = ins[0]?.id;
    }
    for (const h of holdings) {
      const rowId = `${h.rank}:${h.ticker ?? h.name}`.slice(0, 240);
      await query(
        `INSERT INTO etf_holdings
           (id, snapshot_id, etf_id, effective_date, holding_type, holding_name, ticker, weight, source_row_id, verification_status, quality_status, raw_row)
         VALUES (gen_random_uuid(), $1::uuid, $2, NULL, 'SECURITY', $3, $4, $5, $6, 'SOURCE_PARSED', 'PARTIAL_DATE_UNKNOWN', $7::jsonb)
         ON CONFLICT (snapshot_id, source_row_id) DO UPDATE SET
           holding_name = EXCLUDED.holding_name, ticker = EXCLUDED.ticker, weight = EXCLUDED.weight, raw_row = EXCLUDED.raw_row`,
        [snapId, input.etfId, h.name, h.ticker, h.weight, rowId, JSON.stringify(h.raw)],
      );
    }
    out.holdingsWritten = holdings.length;
  }

  // 4) sector allocations
  const sectors = allocRows(th.sectorWeightings);
  if (sectors.length) {
    const d = new Date().toISOString().slice(0, 10);
    for (const s of sectors) {
      await query(
        `INSERT INTO etf_sector_allocations (id, etf_id, observation_date, sector_name, weight, source, source_url, retrieved_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2::date, $3, $4, 'YAHOO_QUOTE_SUMMARY', $5, $6::timestamptz, NOW(), NOW())
         ON CONFLICT (etf_id, observation_date, source, sector_name) DO UPDATE SET
           weight = EXCLUDED.weight, source_url = EXCLUDED.source_url, retrieved_at = EXCLUDED.retrieved_at, updated_at = NOW()`,
        [input.etfId, d, s.name, s.weight, srcUrl, retrievedAt],
      );
    }
    out.sectorAllocWritten = sectors.length;
  }

  // 5) bond credit-rating allocations
  const ratings = allocRows(th.bondRatings);
  if (ratings.length) {
    const d = new Date().toISOString().slice(0, 10);
    for (const cr of ratings) {
      await query(
        `INSERT INTO etf_credit_rating_allocations (id, etf_id, observation_date, credit_rating, weight, source, source_url, retrieved_at, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2::date, $3, $4, 'YAHOO_QUOTE_SUMMARY', $5, $6::timestamptz, NOW(), NOW())
         ON CONFLICT (etf_id, observation_date, source, credit_rating) DO UPDATE SET
           weight = EXCLUDED.weight, source_url = EXCLUDED.source_url, retrieved_at = EXCLUDED.retrieved_at, updated_at = NOW()`,
        [input.etfId, d, cr.name, cr.weight, srcUrl, retrievedAt],
      );
    }
    out.creditAllocWritten = ratings.length;
  }
}
