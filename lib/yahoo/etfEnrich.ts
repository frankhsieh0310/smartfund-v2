// Yahoo ETF product enrichment — v10 quoteSummary -> etfs metadata + etf_performances +
// etf_holdings/etf_holding_snapshots (top holdings) + etf_sector_allocations +
// etf_credit_rating_allocations. Idempotent COALESCE upserts (never overwrite non-null with null).
// SQL mirrors the battle-tested scripts/data/etf-yahoo/run-etf-yahoo-product-modules.ts.
//
// Source priority: this writes source='YAHOO_QUOTE_SUMMARY'. Official-issuer / MoneyDJ holdings
// snapshots live under their own source and are NOT touched here — a completeness_status of
// 'TOP_HOLDINGS_ONLY' + a distinct source means readers that prefer OFFICIAL_ISSUER > MONEYDJ > YAHOO
// keep doing so. No ETF Morningstar fields are written (Yahoo doesn't expose them for ETFs).

import { randomUUID } from "crypto";
import { fetchQuoteSummary, rawNum, rawText, type RateStats } from "./productSession";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;
// 2026-10-21（台股拼圖效能回報，使用者單次授權）: holdings 快照INSERT＋逐筆INSERT原本各自獨立
// commit，每次commit觸發一次refresh_reverse_products（平均526ms）——見lib/yahoo/fundIngest.ts
// TransactionQueryFn同一份說明。呼叫端用prisma.$transaction(statements.map(...))實作。
export type TransactionQueryFn = (statements: Array<{ sql: string; params: any[] }>) => Promise<void>;

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
  stats: RateStats | undefined,
  queryTx: TransactionQueryFn,
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
    await writeEtfEnrichData(query, input, { fp, ks, sd, pr, perf, th, srcUrl, retrievedAt }, out, queryTx);
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
  queryTx: TransactionQueryFn,
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
  // Confirmed via the actual quoteSummary payload (summaryDetail.navPrice is a bare {raw,fmt}
  // number with no companion as-of field anywhere in the response, and price.regularMarketTime is
  // the MARKET price's own timestamp, not NAV's) that Yahoo does not expose a NAV-specific source
  // date for ETPs through this endpoint. Per the no-fabrication rule, latest_nav above is the only
  // NAV write here — no dated etf_history row is created from this source, since any date we could
  // attach (market-close date, today, ingestion time) would not be NAV's own source date.

  // 2) performance -> Task X5 Part B (user-approved): this pipeline no longer writes any return_*
  // column at all, to either etf_performances or etfs. Column ownership is now split between
  // lib/etf-returns-sync/returnsWriter.ts (return_1m/3m/ytd/1y/3y/5y, direct overwrite incl. NULL —
  // the two pipelines writing the same etf_performances return_* columns with different COALESCE
  // semantics was exactly what let a stale 0 get stuck forever) and
  // app/api/cron/cloud-etf-price/route.ts (return_1d/6m, self-computed, Yahoo has no such figures).
  // Everything else in this function (metadata, holdings, sector/credit allocations below) is
  // unchanged.

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
    // 2026-10-21: 快照INSERT（如果需要）＋所有持股INSERT包成一個交易一次commit。陣列形式的
    // prisma.$transaction沒辦法把某一句的RETURNING結果傳給下一句，所以snapshot的id改成JS端
    // 用randomUUID()先產生好，兩邊語句都直接帶這個已知值，不再依賴gen_random_uuid()+RETURNING。
    const statements: Array<{ sql: string; params: any[] }> = [];
    if (!snapId) {
      snapId = randomUUID();
      statements.push({
        sql: `INSERT INTO etf_holding_snapshots
           (id, etf_id, effective_date, report_date, source, source_type, source_url, source_record_id, retrieved_at,
            checksum, source_row_count, parsed_row_count, canonical_row_count, verification_status, license_status,
            completeness_status, quality_status, quality_metrics, parser_version, archive_lineage)
         VALUES ($1::uuid, $2, NULL, NULL, 'YAHOO_QUOTE_SUMMARY', 'PROVIDER_OBSERVATION', $3, $4, $5::timestamptz,
            $6, $7, $7, $7, 'SOURCE_PARSED', 'TERMS_REVIEW_REQUIRED', 'TOP_HOLDINGS_ONLY', 'PARTIAL_DATE_UNKNOWN',
            $8::jsonb, 'yahoo-top-holdings-v2', $9::jsonb)`,
        params: [
          snapId, input.etfId, srcUrl, sourceRecordId, retrievedAt, input.symbol.slice(0, 32) || retrievedAt, holdings.length,
          JSON.stringify({ sourceDateStatus: "UNKNOWN", retrievedAt }),
          JSON.stringify({ provider: "YAHOO_QUOTE_SUMMARY", module: "topHoldings", symbol: input.symbol }),
        ],
      });
    }
    for (const h of holdings) {
      const rowId = `${h.rank}:${h.ticker ?? h.name}`.slice(0, 240);
      statements.push({
        sql: `INSERT INTO etf_holdings
           (id, snapshot_id, etf_id, effective_date, holding_type, holding_name, ticker, weight, source_row_id, verification_status, quality_status, raw_row)
         VALUES (gen_random_uuid(), $1::uuid, $2, NULL, 'SECURITY', $3, $4, $5, $6, 'SOURCE_PARSED', 'PARTIAL_DATE_UNKNOWN', $7::jsonb)
         ON CONFLICT (snapshot_id, source_row_id) DO UPDATE SET
           holding_name = EXCLUDED.holding_name, ticker = EXCLUDED.ticker, weight = EXCLUDED.weight, raw_row = EXCLUDED.raw_row`,
        params: [snapId, input.etfId, h.name, h.ticker, h.weight, rowId, JSON.stringify(h.raw)],
      });
    }
    await queryTx(statements);
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
