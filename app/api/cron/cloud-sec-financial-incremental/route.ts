// Cloud SEC EDGAR financial incremental — bounded, idempotent, cloud-only. DISCOVERY (which issuers filed
// recently) -> FILER QUEUE (map to canonical stock_id via CIK, one fetch per issuer even across multiple
// share classes) -> FACT REFRESH (companyfacts -> normalize -> upsert). Checkpoint/run-log via
// production_scheduler_runs / production_scheduler_checkpoints (checkpoint key "fundamentals:sec-discovery").
//
// Ports scripts/data/financial/run-production-sec-financial.ts's discovery (SEC daily-index, 8-day
// lookback) and normalization (same CONCEPTS alias table, same per-(accession,period,unit) fact identity)
// verbatim — not a rewrite. What's different for cloud-safety: that script archives every raw companyfacts
// response to the local filesystem (impossible on a stateless Vercel function) and processes a fixed
// per-market symbol list; this route (a) skips local archival entirely, (b) resolves CIK via the existing
// canonical_issuer_stock_links/canonical_issuer_identifiers tables with a company_tickers.json fallback
// (same as the existing script — a stable identifier, not a ticker-only join), and (c) fetches
// companyfacts ONCE per unique CIK and applies the result to every stock_id sharing it (GOOGL/GOOG, etc.)
// instead of once per ticker.
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_SEC_FINANCIAL_INCREMENTAL";
const PROVIDER = "SEC_EDGAR";
const CHECKPOINT_KEY = "fundamentals:sec-discovery";
const MAX_ISSUERS_PER_RUN = 40;
const SEC_HEADERS = { Accept: "application/json", "User-Agent": process.env.SEC_USER_AGENT ?? "SmartFund data platform contact@smartfund.app" };
const ALLOWED_FORMS = new Set(["10-K", "10-Q", "20-F", "40-F", "10-K/A", "10-Q/A", "20-F/A", "40-F/A"]);

type SecUnitFact = { start?: string; end?: string; val?: number; accn?: string; fp?: string; form?: string; filed?: string };
type SecCompanyFacts = { facts?: { "us-gaap"?: Record<string, { units?: Record<string, SecUnitFact[]> }>; dei?: Record<string, { units?: Record<string, SecUnitFact[]> }> } };
// Same alias table as the existing writer, trimmed to what "我的分析" + canonical EPS actually consume.
const CONCEPTS: Record<string, Array<{ namespace: "us-gaap" | "dei"; name: string }>> = {
  revenue: [{ namespace: "us-gaap", name: "RevenueFromContractWithCustomerExcludingAssessedTax" }, { namespace: "us-gaap", name: "RevenueFromContractWithCustomerIncludingAssessedTax" }, { namespace: "us-gaap", name: "Revenues" }, { namespace: "us-gaap", name: "SalesRevenueNet" }],
  gross_profit: [{ namespace: "us-gaap", name: "GrossProfit" }],
  operating_income: [{ namespace: "us-gaap", name: "OperatingIncomeLoss" }],
  net_income: [{ namespace: "us-gaap", name: "NetIncomeLoss" }, { namespace: "us-gaap", name: "ProfitLoss" }],
  basic_eps: [{ namespace: "us-gaap", name: "EarningsPerShareBasic" }],
  diluted_eps: [{ namespace: "us-gaap", name: "EarningsPerShareDiluted" }],
  operating_cash_flow: [{ namespace: "us-gaap", name: "NetCashProvidedByUsedInOperatingActivities" }, { namespace: "us-gaap", name: "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations" }],
  capital_expenditure: [{ namespace: "us-gaap", name: "PaymentsToAcquirePropertyPlantAndEquipment" }, { namespace: "us-gaap", name: "PaymentsForProceedsFromPropertyPlantAndEquipment" }],
  total_assets: [{ namespace: "us-gaap", name: "Assets" }],
  total_liabilities: [{ namespace: "us-gaap", name: "Liabilities" }],
  shareholders_equity: [{ namespace: "us-gaap", name: "StockholdersEquity" }, { namespace: "us-gaap", name: "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest" }],
};

function normalizedTicker(ticker: string): string { return ticker.toUpperCase().replaceAll(".", "-"); }
async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { headers: SEC_HEADERS, signal: controller.signal });
    if (response.status === 403 || response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) throw new Error(`SEC_HTTP_${response.status}`);
    return text;
  } finally { clearTimeout(timer); }
}
function secDailyIndexUrl(date: Date): string {
  const year = date.getUTCFullYear();
  const quarter = Math.ceil((date.getUTCMonth() + 1) / 3);
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `https://www.sec.gov/Archives/edgar/daily-index/${year}/QTR${quarter}/master.${day}.idx`;
}
async function discoverRecentFilingCiks(): Promise<{ ciks: Set<string>; indexesAvailable: number }> {
  const ciks = new Set<string>();
  let indexesAvailable = 0;
  const today = new Date();
  for (let daysAgo = 1; daysAgo <= 8; daysAgo += 1) {
    const text = await fetchText(secDailyIndexUrl(new Date(today.getTime() - daysAgo * 86_400_000)));
    if (text === null) continue;
    indexesAvailable++;
    for (const line of text.split(/\r?\n/)) {
      const [cik, , form] = line.split("|");
      if (!cik || !form || !ALLOWED_FORMS.has(form.trim())) continue;
      ciks.add(cik.trim().padStart(10, "0"));
    }
  }
  return { ciks, indexesAvailable };
}
function normalizeCompanyFacts(stockId: string, cik: string, payload: SecCompanyFacts): Array<{ stockId: string; metric: string; periodStart: string | null; periodEnd: string; fiscalPeriod: string | null; formType: string | null; filingDate: string | null; value: string; unit: string; currency: string | null; sourceFactKey: string; sourceDocumentUrl: string | null }> {
  const output: ReturnType<typeof normalizeCompanyFacts> = [];
  for (const [metric, aliases] of Object.entries(CONCEPTS)) {
    const selected = new Map<string, { fact: SecUnitFact; concept: string; unit: string; rank: number }>();
    aliases.forEach((alias, rank) => {
      const concept = payload.facts?.[alias.namespace]?.[alias.name];
      for (const [unit, facts] of Object.entries(concept?.units ?? {})) {
        for (const fact of facts) {
          if (!fact.end || typeof fact.val !== "number" || !Number.isFinite(fact.val) || !ALLOWED_FORMS.has(fact.form ?? "")) continue;
          if (fact.start && fact.start > fact.end) continue;
          if (fact.filed && fact.end > fact.filed) continue;
          const key = `${fact.accn ?? "NO_ACCN"}:${fact.start ?? "INSTANT"}:${fact.end}:${fact.fp ?? "NO_FP"}:${unit}`;
          const existing = selected.get(key);
          if (!existing || rank < existing.rank) selected.set(key, { fact, concept: alias.name, unit, rank });
        }
      }
    });
    for (const { fact, concept, unit } of selected.values()) {
      const currency = ["USD", "EUR", "JPY", "CAD", "GBP", "TWD", "KRW", "CNY", "HKD", "AUD"].includes(unit) ? unit : null;
      output.push({ stockId, metric, periodStart: fact.start ?? null, periodEnd: fact.end!, fiscalPeriod: fact.fp ?? null, formType: fact.form ?? null, filingDate: fact.filed ?? null, value: String(fact.val), unit, currency, sourceFactKey: `${concept}:${fact.accn ?? "NO_ACCN"}:${fact.start ?? "INSTANT"}:${fact.end}:${fact.fp ?? "NO_FP"}:${unit}`, sourceDocumentUrl: fact.accn ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${fact.accn.replaceAll("-", "")}/` : null });
    }
  }
  return output;
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();

  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = `cloud-sec-financial-incremental:${new Date().toISOString().slice(0, 10)}`;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: 0, batchSize: MAX_ISSUERS_PER_RUN, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "already discovered today", runKey });

  const { ciks: filedCiks, indexesAvailable } = await discoverRecentFilingCiks();
  if (indexesAvailable === 0) {
    await finishRun(runId, JOB, PROVIDER, startedMs, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 0, retryableFailures: 0, checkpointAfter: before, error: "SEC_DAILY_INDEX_UNAVAILABLE", details: {} });
    return Response.json({ ok: false, job: JOB, runId, error: "SEC_DAILY_INDEX_UNAVAILABLE", runtimeMs: Date.now() - startedMs });
  }

  // Stable identifier (STEP B3): resolve discovered CIKs to canonical stock_ids via the existing
  // canonical_issuer_stock_links/canonical_issuer_identifiers tables, not a ticker-only join.
  const linked = await prisma.$queryRawUnsafe<Array<{ stockId: string; ticker: string; exchange: string; cik: string }>>(
    `SELECT l.stock_id AS "stockId", s.ticker, s.exchange, e.identifier_value AS cik
       FROM canonical_issuer_stock_links l
       JOIN canonical_issuer_identifiers e ON e.id = l.issuer_identifier_id
       JOIN stocks s ON s.id = l.stock_id
      WHERE e.identifier_type = 'CIK' AND l.verification_status = 'VERIFIED_OFFICIAL_EXACT'
        AND (l.effective_to IS NULL OR l.effective_to > NOW())
        AND s.is_active = true AND s.exchange IN ('NASDAQ','NYSE','AMEX')`,
  );
  const stocksByCik = new Map<string, Array<{ stockId: string; ticker: string }>>();
  for (const row of linked) (stocksByCik.get(row.cik) ?? stocksByCik.set(row.cik, []).get(row.cik)!).push({ stockId: row.stockId, ticker: row.ticker });
  // Fallback for tickers not yet in canonical mapping — same bulk file the existing script falls back to.
  const unmapped = new Set<string>();
  const activeStocks = await prisma.stock.findMany({ where: { isActive: true, exchange: { in: ["NASDAQ", "NYSE", "AMEX"] } }, select: { id: true, ticker: true } });
  const mappedTickers = new Set(linked.map((r) => normalizedTicker(r.ticker)));
  for (const s of activeStocks) if (!mappedTickers.has(normalizedTicker(s.ticker))) unmapped.add(s.ticker);
  if (unmapped.size) {
    const bulk = await fetchText("https://www.sec.gov/files/company_tickers.json");
    if (bulk) {
      const payload = JSON.parse(bulk) as Record<string, { ticker: string; cik_str: number }>;
      const bulkByTicker = new Map(Object.values(payload).map((item) => [normalizedTicker(item.ticker), String(item.cik_str).padStart(10, "0")]));
      for (const s of activeStocks) {
        if (!unmapped.has(s.ticker)) continue;
        const cik = bulkByTicker.get(normalizedTicker(s.ticker));
        if (cik) (stocksByCik.get(cik) ?? stocksByCik.set(cik, []).get(cik)!).push({ stockId: s.id, ticker: s.ticker });
      }
    }
  }

  const discoveredIssuerCiks = [...stocksByCik.keys()].filter((cik) => filedCiks.has(cik)).sort();

  // STEP 3 overflow queue: a day that discovers more issuers than MAX_ISSUERS_PER_RUN used to just log
  // "deferred_to_next_run" as a number with no persistence — the next run's discovery window (8 days)
  // usually still covered the same filers, but a filer right at the edge of that window could silently
  // never be retried. Reusing production_scheduler_failures (the exact table + resolve convention the
  // original run-production-sec-financial.ts already uses for this same job) makes the backlog durable
  // and visible instead. One row per CIK, keyed by that CIK's first/representative stock_id — a CIK with
  // multiple share classes is still only ever queued and fetched once.
  const representativeStockIdByCik = new Map([...stocksByCik.entries()].map(([cik, stocks]) => [cik, stocks[0].stockId]));
  const cikByStockId = new Map([...stocksByCik.entries()].flatMap(([cik, stocks]) => stocks.map((s) => [s.stockId, cik] as const)));
  const pendingRows = await prisma.$queryRawUnsafe<Array<{ stockId: string; attempts: number; firstFailedAt: string }>>(
    `SELECT stock_id AS "stockId", attempts, first_failed_at::text AS "firstFailedAt" FROM production_scheduler_failures
      WHERE job_id = $1 AND resolved = false AND classification = 'OVERFLOW_QUEUED' ORDER BY first_failed_at ASC`,
    JOB,
  );
  const pendingCiks = [...new Set(pendingRows.flatMap((r) => { const cik = cikByStockId.get(r.stockId); return cik ? [cik] : []; }))];
  const newlyDiscovered = discoveredIssuerCiks.filter((cik) => !pendingCiks.includes(cik));
  const orderedBacklog = [...pendingCiks, ...newlyDiscovered]; // process the oldest-queued backlog before anything newly discovered today
  const toProcess = orderedBacklog.slice(0, MAX_ISSUERS_PER_RUN);
  const overflow = orderedBacklog.slice(MAX_ISSUERS_PER_RUN);
  const deferred = overflow.length;

  if (overflow.length) {
    const rows = overflow.map((cik) => ({ stockId: representativeStockIdByCik.get(cik)!, symbol: stocksByCik.get(cik)![0].ticker }));
    await prisma.$executeRawUnsafe(
      `INSERT INTO production_scheduler_failures (job_id, stock_id, symbol, attempts, last_error, last_attempted_at, error_type, classification, resolved, first_failed_at)
       SELECT $1, x."stockId", x.symbol, 1, 'BATCH_CAP_OVERFLOW', NOW(), 'CAPACITY', 'OVERFLOW_QUEUED', FALSE, NOW()
       FROM jsonb_to_recordset($2::jsonb) AS x("stockId" text, symbol text)
       ON CONFLICT (job_id, stock_id) DO UPDATE SET
         attempts = production_scheduler_failures.attempts + 1, last_attempted_at = NOW(),
         classification = 'OVERFLOW_QUEUED', resolved = FALSE`,
      JOB, JSON.stringify(rows),
    );
  }

  let attempted = 0;
  let inserted = 0;
  let failed = 0;
  let latestFiledAt: string | null = null;
  const failures: Array<{ cik: string; reason: string }> = [];
  for (const cik of toProcess) {
    attempted++;
    const stocksForCik = stocksByCik.get(cik)!;
    try {
      const text = await fetchText(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
      if (text === null) throw new Error("SEC_COMPANYFACTS_UNAVAILABLE");
      const payload = JSON.parse(text) as SecCompanyFacts;
      // One fetch per CIK, applied to every stock_id (share class) linked to it — STEP B3.
      const facts = stocksForCik.flatMap((stock) => normalizeCompanyFacts(stock.stockId, cik, payload));
      if (!facts.length) throw new Error("SEC_NO_CANONICAL_FACTS");
      for (let offset = 0; offset < facts.length; offset += 2000) {
        const chunk = facts.slice(offset, offset + 2000).map((f) => ({ id: crypto.randomUUID(), ...f }));
        if (!chunk.length) continue;
        await prisma.$executeRawUnsafe(
          `INSERT INTO stock_financial_facts (id, stock_id, metric, period_start, period_end, fiscal_period, form_type, filing_date, publication_date, value, unit, currency, source, source_fact_key, source_document_url, imported_at, updated_at)
           SELECT x.id, x."stockId", x.metric, x."periodStart"::date, x."periodEnd"::date, x."fiscalPeriod", x."formType", x."filingDate"::date, x."filingDate"::date, x.value::numeric, x.unit, x.currency, 'SEC_EDGAR', x."sourceFactKey", x."sourceDocumentUrl", NOW(), NOW()
           FROM jsonb_to_recordset($1::jsonb) AS x(id text, "stockId" text, metric text, "periodStart" text, "periodEnd" text, "fiscalPeriod" text, "formType" text, "filingDate" text, value text, unit text, currency text, "sourceFactKey" text, "sourceDocumentUrl" text)
           ON CONFLICT (stock_id, metric, period_end, source, source_fact_key)
           DO UPDATE SET value = EXCLUDED.value, unit = EXCLUDED.unit, currency = EXCLUDED.currency, period_start = EXCLUDED.period_start, fiscal_period = EXCLUDED.fiscal_period, form_type = EXCLUDED.form_type, filing_date = EXCLUDED.filing_date, publication_date = EXCLUDED.publication_date, source_document_url = EXCLUDED.source_document_url, updated_at = NOW()`,
          JSON.stringify(chunk),
        );
        inserted += chunk.length;
      }
      const maxFiled = facts.reduce<string | null>((latest, f) => f.filingDate && (!latest || f.filingDate > latest) ? f.filingDate : latest, null);
      if (maxFiled && (latestFiledAt === null || maxFiled > (latestFiledAt as string))) latestFiledAt = maxFiled;
      // Successfully refreshed — if this CIK was sitting in the overflow queue, resolve it so it doesn't
      // get re-queued or re-fetched.
      if (pendingCiks.includes(cik)) {
        await prisma.$executeRawUnsafe(
          `UPDATE production_scheduler_failures SET resolved = TRUE, resolved_at = NOW(), resolution_reason = 'SEC_FINANCIAL_FACTS_INGESTED'
             WHERE job_id = $1 AND stock_id = $2 AND classification = 'OVERFLOW_QUEUED' AND resolved = FALSE`,
          JOB, representativeStockIdByCik.get(cik),
        );
      }
    } catch (error) {
      failed++;
      failures.push({ cik, reason: error instanceof Error ? error.message : String(error) });
    }
    await new Promise((r) => setTimeout(r, 250)); // bounded request rate, per SEC fair-access policy
  }

  const pendingQueueDepthAfter = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int n FROM production_scheduler_failures WHERE job_id = $1 AND resolved = false AND classification = 'OVERFLOW_QUEUED'`,
    JOB,
  ).then((r) => r[0]?.n ?? 0);
  const after = { lastSymbol: toProcess.at(-1) ?? before?.lastSymbol ?? null, processed: (before?.processed ?? 0) + attempted, succeeded: (before?.succeeded ?? 0) + (attempted - failed), failed: (before?.failed ?? 0) + failed, updatedAt: new Date().toISOString() };
  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: after.lastSymbol, processed: after.processed, succeeded: after.succeeded, failed: after.failed });
  const status = attempted > 0 && failed === attempted ? "FAILED" : failed > 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status, attempted, completed: attempted - failed, inserted, updated: 0, failed, retryableFailures: failed,
    checkpointAfter: after, error: failures.length ? JSON.stringify(failures.slice(0, 5)) : null,
    details: { discovered_ciks: discoveredIssuerCiks.length, from_backlog: pendingCiks.length, deferred_to_next_run: deferred, pending_queue_depth: pendingQueueDepthAfter, latest_filed_at: latestFiledAt, sample_failures: failures.slice(0, 5) },
  });

  return Response.json({ ok: status !== "FAILED", job: JOB, runId, issuersDiscovered: discoveredIssuerCiks.length, issuersRefreshed: attempted - failed, factsWritten: inserted, failed, deferredToNextRun: deferred, pendingQueueDepth: pendingQueueDepthAfter, latestFiledAt, runtimeMs: Date.now() - startedMs, status });
}
