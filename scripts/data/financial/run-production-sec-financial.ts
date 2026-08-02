import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  acquireLifecycleLock,
  completeLifecycleRun,
  createLifecycleRun,
  createSummary,
  failLifecycleRun,
  heartbeatLifecycleLock,
  loadLifecycleResumeCheckpoint,
  pauseLifecycleRun,
  persistLifecycleCheckpoint,
  recoverOrphanedLifecycleRun,
  releaseLifecycleLock,
  type RunSummary,
} from "../production/run-lifecycle.ts";
import { validateWorkerOwnershipFromEnvironment } from "../governance/worker-ownership.ts";

type Market = "NASDAQ" | "NYSE" | "AMEX";
type Stock = { id: string; ticker: string; companyName: string };
type SecUnitFact = {
  start?: string;
  end?: string;
  val?: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
};
type SecCompanyFacts = {
  cik?: number;
  entityName?: string;
  facts?: {
    "us-gaap"?: Record<string, { label?: string; description?: string; units?: Record<string, SecUnitFact[]> }>;
    dei?: Record<string, { label?: string; description?: string; units?: Record<string, SecUnitFact[]> }>;
  };
};
type NormalizedFact = {
  stockId: string;
  metric: string;
  periodStart: string | null;
  periodEnd: string;
  fiscalPeriod: string | null;
  formType: string | null;
  filingDate: string | null;
  value: string;
  unit: string;
  currency: string | null;
  sourceFactKey: string;
  sourceDocumentUrl: string | null;
  restatementVersion: string | null;
};

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const marketArg = process.argv.find((arg) => arg.startsWith("--market="))?.slice("--market=".length)?.toUpperCase() ?? "NASDAQ";
if (!["NASDAQ", "NYSE", "AMEX"].includes(marketArg)) throw new Error(`UNSUPPORTED_SEC_MARKET:${marketArg}`);
const MARKET = marketArg as Market;
const INCREMENTAL = process.argv.includes("--incremental");
const DRY_RUN = process.argv.includes("--dry-run");
const JOB_ID = `official-financial-${MARKET.toLowerCase()}-${INCREMENTAL ? "incremental" : "historical"}`;
const RUN_TYPE = INCREMENTAL ? "OFFICIAL_FINANCIAL_INCREMENTAL" : "OFFICIAL_FINANCIAL_HISTORICAL";
const TARGET_DATE = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const maxSymbolsArg = process.argv.find((arg) => arg.startsWith("--max-symbols="))?.slice("--max-symbols=".length);
const MAX_SYMBOLS = Math.max(1, Number.parseInt(maxSymbolsArg ?? "25", 10));
const CHECKPOINT_EVERY = 5;
const REQUEST_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 30_000;
const RAW_ROOT = path.resolve("runtime", "official-financial", "us", MARKET.toLowerCase());
const SEC_HEADERS = {
  Accept: "application/json",
  "User-Agent": process.env.SEC_USER_AGENT ?? "SmartFund data platform contact@smartfund.app",
};
const ALLOWED_FORMS = new Set(["10-K", "10-Q", "20-F", "40-F", "8-K", "6-K", "10-K/A", "10-Q/A", "20-F/A", "40-F/A"]);

const CONCEPTS: Record<string, Array<{ namespace: "us-gaap" | "dei"; name: string }>> = {
  revenue: [
    { namespace: "us-gaap", name: "RevenueFromContractWithCustomerExcludingAssessedTax" },
    { namespace: "us-gaap", name: "RevenueFromContractWithCustomerIncludingAssessedTax" },
    { namespace: "us-gaap", name: "Revenues" },
    { namespace: "us-gaap", name: "SalesRevenueNet" },
  ],
  cost_of_revenue: [
    { namespace: "us-gaap", name: "CostOfRevenue" },
    { namespace: "us-gaap", name: "CostOfGoodsAndServicesSold" },
    { namespace: "us-gaap", name: "CostOfGoodsSold" },
  ],
  gross_profit: [{ namespace: "us-gaap", name: "GrossProfit" }],
  operating_expenses: [{ namespace: "us-gaap", name: "OperatingExpenses" }],
  operating_income: [
    { namespace: "us-gaap", name: "OperatingIncomeLoss" },
    { namespace: "us-gaap", name: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest" },
  ],
  ebit: [{ namespace: "us-gaap", name: "OperatingIncomeLoss" }],
  pretax_income: [
    { namespace: "us-gaap", name: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest" },
    { namespace: "us-gaap", name: "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments" },
  ],
  income_tax: [{ namespace: "us-gaap", name: "IncomeTaxExpenseBenefit" }],
  net_income: [
    { namespace: "us-gaap", name: "NetIncomeLoss" },
    { namespace: "us-gaap", name: "ProfitLoss" },
    { namespace: "us-gaap", name: "NetIncomeLossAvailableToCommonStockholdersBasic" },
  ],
  basic_eps: [{ namespace: "us-gaap", name: "EarningsPerShareBasic" }],
  diluted_eps: [{ namespace: "us-gaap", name: "EarningsPerShareDiluted" }],
  operating_cash_flow: [
    { namespace: "us-gaap", name: "NetCashProvidedByUsedInOperatingActivities" },
    { namespace: "us-gaap", name: "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations" },
  ],
  investing_cash_flow: [
    { namespace: "us-gaap", name: "NetCashProvidedByUsedInInvestingActivities" },
    { namespace: "us-gaap", name: "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations" },
  ],
  financing_cash_flow: [
    { namespace: "us-gaap", name: "NetCashProvidedByUsedInFinancingActivities" },
    { namespace: "us-gaap", name: "NetCashProvidedByUsedInFinancingActivitiesContinuingOperations" },
  ],
  capital_expenditure: [
    { namespace: "us-gaap", name: "PaymentsToAcquirePropertyPlantAndEquipment" },
    { namespace: "us-gaap", name: "PaymentsForProceedsFromPropertyPlantAndEquipment" },
  ],
  cash_and_cash_equivalents: [
    { namespace: "us-gaap", name: "CashAndCashEquivalentsAtCarryingValue" },
    { namespace: "us-gaap", name: "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents" },
  ],
  short_term_investments: [
    { namespace: "us-gaap", name: "ShortTermInvestments" },
    { namespace: "us-gaap", name: "MarketableSecuritiesCurrent" },
  ],
  accounts_receivable: [
    { namespace: "us-gaap", name: "AccountsReceivableNetCurrent" },
    { namespace: "us-gaap", name: "AccountsNotesAndLoansReceivableNetCurrent" },
  ],
  inventory: [{ namespace: "us-gaap", name: "InventoryNet" }],
  current_assets: [{ namespace: "us-gaap", name: "AssetsCurrent" }],
  property_plant_equipment: [{ namespace: "us-gaap", name: "PropertyPlantAndEquipmentNet" }],
  total_assets: [{ namespace: "us-gaap", name: "Assets" }],
  current_liabilities: [{ namespace: "us-gaap", name: "LiabilitiesCurrent" }],
  short_term_debt: [
    { namespace: "us-gaap", name: "ShortTermBorrowings" },
    { namespace: "us-gaap", name: "ShortTermDebtCurrent" },
    { namespace: "us-gaap", name: "LongTermDebtCurrent" },
  ],
  long_term_debt: [
    { namespace: "us-gaap", name: "LongTermDebtNoncurrent" },
    { namespace: "us-gaap", name: "LongTermDebt" },
  ],
  total_liabilities: [{ namespace: "us-gaap", name: "Liabilities" }],
  shareholders_equity: [
    { namespace: "us-gaap", name: "StockholdersEquity" },
    { namespace: "us-gaap", name: "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest" },
  ],
  shares_outstanding: [
    { namespace: "dei", name: "EntityCommonStockSharesOutstanding" },
    { namespace: "us-gaap", name: "CommonStockSharesOutstanding" },
  ],
  weighted_average_basic_shares: [{ namespace: "us-gaap", name: "WeightedAverageNumberOfSharesOutstandingBasic" }],
  weighted_average_diluted_shares: [{ namespace: "us-gaap", name: "WeightedAverageNumberOfDilutedSharesOutstanding" }],
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizedTicker(ticker: string): string {
  return ticker.toUpperCase().replaceAll(".", "-");
}

async function fetchJson<T>(url: string): Promise<{ payload: T; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: SEC_HEADERS, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`SEC_HTTP_${response.status}`);
    return { payload: JSON.parse(text) as T, text };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextIfAvailable(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: SEC_HEADERS, signal: controller.signal });
    // SEC Archives returns 403 as well as 404 for a daily index file that has
    // not been published (weekends, holidays, and the still-open current day).
    if (response.status === 403 || response.status === 404) return null;
    const text = await response.text();
    if (!response.ok) throw new Error(`SEC_HTTP_${response.status}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function secDailyIndexUrl(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const quarter = Math.ceil(month / 3);
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  return `https://www.sec.gov/Archives/edgar/daily-index/${year}/QTR${quarter}/master.${day}.idx`;
}

async function discoverRecentFilingCiks(): Promise<Set<string>> {
  const ciks = new Set<string>();
  let availableIndexes = 0;
  const archiveDirectory = path.join(RAW_ROOT, "incremental", TARGET_DATE.toISOString().slice(0, 10));
  await mkdir(archiveDirectory, { recursive: true });
  for (let daysAgo = 1; daysAgo <= 8; daysAgo += 1) {
    const date = new Date(TARGET_DATE.getTime() - daysAgo * 86_400_000);
    const url = secDailyIndexUrl(date);
    const text = await fetchTextIfAvailable(url);
    if (text === null) continue;
    availableIndexes += 1;
    await writeFile(path.join(archiveDirectory, `master.${date.toISOString().slice(0, 10).replaceAll("-", "")}.idx`), text);
    for (const line of text.split(/\r?\n/)) {
      const [cik, , form] = line.split("|");
      if (!cik || !form || !ALLOWED_FORMS.has(form.trim())) continue;
      ciks.add(cik.trim().padStart(10, "0"));
    }
  }
  if (availableIndexes === 0) throw new Error("SEC_DAILY_INDEX_UNAVAILABLE");
  return ciks;
}

async function archiveJson(stock: Stock, cik: string, text: string): Promise<{ relativePath: string; sha256: string }> {
  const directory = path.join(RAW_ROOT, normalizedTicker(stock.ticker));
  await mkdir(directory, { recursive: true });
  const relativePath = path.join("runtime", "official-financial", "us", MARKET.toLowerCase(), normalizedTicker(stock.ticker), "companyfacts.json").replace(/\\/g, "/");
  await writeFile(path.resolve(relativePath), text);
  const sha256 = createHash("sha256").update(text).digest("hex");
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify({ market: MARKET, stockId: stock.id, ticker: stock.ticker, cik, source: "SEC_EDGAR_COMPANYFACTS", sourceUrl: `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, downloadedAt: new Date().toISOString(), sha256 }, null, 2)}\n`);
  return { relativePath, sha256 };
}

function inMemoryArchive(text: string): { relativePath: string; sha256: string } {
  return { relativePath: "DRY_RUN_NOT_WRITTEN", sha256: createHash("sha256").update(text).digest("hex") };
}

function sourceDocumentUrl(cik: string, accession: string | undefined): string | null {
  if (!accession) return null;
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replaceAll("-", "")}/`;
}

function normalizeCompanyFacts(stock: Stock, cik: string, payload: SecCompanyFacts, archiveSha256: string): NormalizedFact[] {
  const output: NormalizedFact[] = [];
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
      output.push({
        stockId: stock.id,
        metric,
        periodStart: fact.start ?? null,
        periodEnd: fact.end!,
        fiscalPeriod: fact.fp ?? null,
        formType: fact.form ?? null,
        filingDate: fact.filed ?? null,
        value: String(fact.val),
        unit,
        currency,
        sourceFactKey: `${concept}:${fact.accn ?? "NO_ACCN"}:${fact.start ?? "INSTANT"}:${fact.end}:${fact.fp ?? "NO_FP"}:${unit}`,
        sourceDocumentUrl: sourceDocumentUrl(cik, fact.accn),
        restatementVersion: `${fact.filed ?? "NO_FILED"}:${archiveSha256}`,
      });
    }
  }
  return output;
}

async function upsertFacts(facts: NormalizedFact[]): Promise<number> {
  let rows = 0;
  for (let offset = 0; offset < facts.length; offset += 2_000) {
    const payload = facts.slice(offset, offset + 2_000).map((fact) => ({ id: randomUUID(), ...fact }));
    if (!payload.length) continue;
    await prisma.$executeRawUnsafe(
      `INSERT INTO stock_financial_facts
        (id, stock_id, metric, period_start, period_end, fiscal_period, form_type, filing_date, publication_date,
         value, unit, currency, source, source_fact_key, source_document_url, restatement_version, imported_at, updated_at)
       SELECT x.id, x."stockId", x.metric, x."periodStart"::date, x."periodEnd"::date,
              x."fiscalPeriod", x."formType", x."filingDate"::date, x."filingDate"::date,
              x.value::numeric, x.unit, x.currency, 'SEC_EDGAR', x."sourceFactKey", x."sourceDocumentUrl", x."restatementVersion", NOW(), NOW()
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, "stockId" text, metric text, "periodStart" text, "periodEnd" text, "fiscalPeriod" text,
         "formType" text, "filingDate" text, value text, unit text, currency text, "sourceFactKey" text,
         "sourceDocumentUrl" text, "restatementVersion" text
       )
       ON CONFLICT (stock_id, metric, period_end, source, source_fact_key)
       DO UPDATE SET value = EXCLUDED.value, unit = EXCLUDED.unit, currency = EXCLUDED.currency,
         period_start = EXCLUDED.period_start, fiscal_period = EXCLUDED.fiscal_period, form_type = EXCLUDED.form_type,
         filing_date = EXCLUDED.filing_date, publication_date = EXCLUDED.publication_date,
         source_document_url = EXCLUDED.source_document_url, restatement_version = EXCLUDED.restatement_version,
         updated_at = NOW()`,
      JSON.stringify(payload),
    );
    rows += payload.length;
  }
  return rows;
}

async function recordFailure(stock: Stock, reason: string): Promise<void> {
  const permanent = reason === "SEC_CIK_NOT_FOUND" || reason === "SEC_NO_CANONICAL_FACTS";
  await prisma.$executeRawUnsafe(
    `INSERT INTO production_scheduler_failures
      (job_id, stock_id, symbol, attempts, last_error, last_attempted_at, error_type, next_retry_at,
       resolved_at, classification, resolved, resolution_reason, first_failed_at)
     VALUES ($1, $2, $3, 1, $4, NOW(), $5, $6, NULL, $7, FALSE, NULL, NOW())
     ON CONFLICT (job_id, stock_id) DO UPDATE SET
       symbol = EXCLUDED.symbol, attempts = production_scheduler_failures.attempts + 1,
       last_error = EXCLUDED.last_error, last_attempted_at = NOW(), error_type = EXCLUDED.error_type,
       next_retry_at = EXCLUDED.next_retry_at, resolved_at = NULL, classification = EXCLUDED.classification,
       resolved = FALSE, resolution_reason = NULL`,
    JOB_ID,
    stock.id,
    stock.ticker,
    reason,
    reason.split(":")[0] ?? "UNKNOWN_ERROR",
    permanent ? null : new Date(Date.now() + 6 * 60 * 60 * 1_000),
    permanent ? "PARTIAL_SOURCE_DATA" : "RETRYABLE_FAILURE",
  );
}

async function resolveFailure(stock: Stock): Promise<void> {
  await prisma.$executeRawUnsafe(
    "UPDATE production_scheduler_failures SET resolved = TRUE, resolved_at = NOW(), resolution_reason = 'SEC_FINANCIAL_FACTS_INGESTED' WHERE job_id = $1 AND stock_id = $2 AND resolved = FALSE",
    JOB_ID,
    stock.id,
  );
}

async function removeInvalidPointInTimeFacts(marketStockIds: string[]): Promise<number> {
  if (marketStockIds.length === 0) throw new Error(`MARKET_SCOPE_EMPTY:${MARKET}`);
  return prisma.$executeRawUnsafe(
    "DELETE FROM stock_financial_facts WHERE stock_id = ANY($1::text[]) AND source = 'SEC_EDGAR' AND filing_date IS NOT NULL AND period_end > filing_date",
    marketStockIds,
  );
}

async function processStock(stock: Stock, cikByTicker: Map<string, string>, dryRun: boolean): Promise<{ facts: number; latest: string | null }> {
  const cik = cikByTicker.get(normalizedTicker(stock.ticker));
  if (!cik) throw new Error("SEC_CIK_NOT_FOUND");
  const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const { payload, text } = await fetchJson<SecCompanyFacts>(url);
  const archive = dryRun ? inMemoryArchive(text) : await archiveJson(stock, cik, text);
  const facts = normalizeCompanyFacts(stock, cik, payload, archive.sha256);
  if (!facts.length) throw new Error("SEC_NO_CANONICAL_FACTS");
  const rows = dryRun ? facts.length : await upsertFacts(facts);
  if (!dryRun) await resolveFailure(stock);
  return { facts: rows, latest: facts.reduce<string | null>((latest, fact) => !latest || fact.periodEnd > latest ? fact.periodEnd : latest, null) };
}

async function loadCikMap(): Promise<Map<string, string>> {
  const { payload } = await fetchJson<Record<string, { ticker: string; cik_str: number }>>("https://www.sec.gov/files/company_tickers.json");
  return new Map(Object.values(payload).map((item) => [normalizedTicker(item.ticker), String(item.cik_str).padStart(10, "0")]));
}

function restoreSummary(details: Partial<RunSummary> | null, checkpoint: { processed: number; succeeded: number; failed: number } | null) {
  const summary = createSummary();
  if (details) Object.assign(summary, details);
  if (checkpoint && summary.attempted === 0) {
    summary.attempted = checkpoint.processed;
    summary.completed = checkpoint.succeeded;
    summary.success = checkpoint.succeeded;
    summary.failed = checkpoint.failed;
  }
  return summary;
}

async function assertDryRunSafeStart(marketStockIds: string[]): Promise<void> {
  if (marketStockIds.length === 0) throw new Error(`MARKET_SCOPE_EMPTY:${MARKET}`);
  const [locks, activeRuns, crossMarketFailures] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ owner: string }>>(
      "SELECT owner FROM production_scheduler_locks WHERE job_id = $1 AND expires_at > NOW() AND updated_at > NOW() - INTERVAL '10 minutes'",
      JOB_ID,
    ),
    prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
      "SELECT id, status FROM production_scheduler_runs WHERE job_id = $1 AND status IN ('RUNNING', 'IN_PROGRESS') ORDER BY started_at DESC",
      JOB_ID,
    ),
    prisma.$queryRawUnsafe<Array<{ count: number }>>(
      "SELECT COUNT(*)::int AS count FROM production_scheduler_failures WHERE job_id = $1 AND NOT (stock_id = ANY($2::text[]))",
      JOB_ID,
      marketStockIds,
    ),
  ]);
  if (locks.length > 0) throw new Error(`ACTIVE_LOCK_EXISTS:${JOB_ID}:${locks[0].owner}`);
  if (activeRuns.length > 0) throw new Error(`ACTIVE_LIFECYCLE_EXISTS:${JOB_ID}:${activeRuns[0].id}:${activeRuns[0].status}`);
  if ((crossMarketFailures[0]?.count ?? 0) > 0) throw new Error(`FAILURE_QUEUE_SCOPE_VIOLATION:${JOB_ID}:${crossMarketFailures[0].count}`);
}

async function main(): Promise<void> {
  const ownership = await validateWorkerOwnershipFromEnvironment({
    domain: "FINANCIAL",
    market: MARKET,
    mode: INCREMENTAL ? "INCREMENTAL" : "HISTORICAL",
    dryRun: DRY_RUN,
  });
  console.log(JSON.stringify({
    NODE_ID: ownership.nodeId,
    ROLE: ownership.role,
    DOMAIN: ownership.domain,
    MARKET: ownership.market,
    MODE: ownership.mode,
    OWNERSHIP_VALIDATED: ownership.ownershipValidated,
    NODE_STATUS: ownership.nodeStatus,
    LIVE_WRITE_AUTHORIZED: ownership.liveWriteAuthorized,
    DRY_RUN,
  }));
  const owner = `${ownership.nodeId}:${process.env.RAILWAY_REPLICA_ID ?? "local"}:${process.pid}`;
  let runId: string | null = null;
  let lockHeld = false;
  let summary = createSummary();
  try {
    const marketStocks = await prisma.stock.findMany({ where: { exchange: MARKET, isActive: true }, select: { id: true, ticker: true, companyName: true }, orderBy: [{ ticker: "asc" }, { id: "asc" }] });
    const marketStockIds = marketStocks.map((stock) => stock.id);
    if (marketStockIds.length === 0) throw new Error(`MARKET_SCOPE_EMPTY:${MARKET}`);
    if (DRY_RUN) {
      await assertDryRunSafeStart(marketStockIds);
    } else {
      await recoverOrphanedLifecycleRun(prisma, JOB_ID);
      lockHeld = await acquireLifecycleLock(prisma, JOB_ID, owner);
      if (!lockHeld) {
        console.log(JSON.stringify({ status: "SKIPPED_LOCKED", market: MARKET, jobId: JOB_ID }));
        return;
      }
    }
    const [cikByTicker, resume, recentFilingCiks] = await Promise.all([
      loadCikMap(),
      loadLifecycleResumeCheckpoint(prisma, JOB_ID, INCREMENTAL ? { targetTradeDate: TARGET_DATE, runType: RUN_TYPE } : undefined),
      INCREMENTAL ? discoverRecentFilingCiks() : Promise.resolve(null),
    ]);
    const stocks = recentFilingCiks
      ? marketStocks.filter((stock) => {
          const cik = cikByTicker.get(normalizedTicker(stock.ticker));
          return cik ? recentFilingCiks.has(cik) : false;
        })
      : marketStocks;
    const reconciledFailures = DRY_RUN ? 0 : await prisma.$executeRawUnsafe(
      `UPDATE production_scheduler_failures failure
          SET resolved = TRUE, resolved_at = NOW(), resolution_reason = 'SEC_FINANCIAL_FACTS_ALREADY_INGESTED'
        WHERE failure.job_id = $1 AND failure.resolved = FALSE
          AND failure.stock_id = ANY($2::text[])
          AND EXISTS (
            SELECT 1 FROM stock_financial_facts fact
             WHERE fact.stock_id = failure.stock_id AND fact.source = 'SEC_EDGAR'
          )`,
      JOB_ID,
      marketStockIds,
    );
    if (reconciledFailures > 0) console.log(JSON.stringify({ market: MARKET, retryRecovered: reconciledFailures, reason: "FACTS_ALREADY_INGESTED" }));
    const invalidFactsRemoved = DRY_RUN ? 0 : await removeInvalidPointInTimeFacts(marketStockIds);
    if (invalidFactsRemoved > 0) console.log(JSON.stringify({ market: MARKET, invalidFactsRemoved, validation: "PERIOD_END_NOT_AFTER_FILING_DATE" }));
    summary = restoreSummary(resume?.details ?? null, resume);
    const resumeIndex = resume?.last_symbol ? stocks.findIndex((stock) => stock.ticker === resume.last_symbol) : -1;
    if (resume?.last_symbol && resumeIndex < 0) throw new Error(`CHECKPOINT_SYMBOL_NOT_FOUND:${resume.last_symbol}`);
    const remaining = stocks.slice(resumeIndex + 1);
    const selected = remaining.slice(0, MAX_SYMBOLS);
    runId = DRY_RUN ? null : await createLifecycleRun(prisma, JOB_ID, MARKET, RUN_TYPE, INCREMENTAL ? {
      targetTradeDate: TARGET_DATE,
      runKey: `${JOB_ID}:${TARGET_DATE.toISOString().slice(0, 10)}`,
      universeCount: stocks.length,
    } : { universeCount: stocks.length });
    if (INCREMENTAL && runId) {
      const current = await prisma.$queryRawUnsafe<Array<{ status: string }>>("SELECT status FROM production_scheduler_runs WHERE id = $1", runId);
      if (current[0]?.status === "COMPLETED") {
        console.log(JSON.stringify({ status: "SKIPPED_COMPLETED", market: MARKET, jobId: JOB_ID, targetDate: TARGET_DATE.toISOString().slice(0, 10) }));
        return;
      }
    }
    let latestPeriod: string | null = null;
    let wouldUpsertFacts = 0;

    for (const stock of selected) {
      summary.attempted += 1;
      try {
        const result = await processStock(stock, cikByTicker, DRY_RUN);
        summary.completed += 1;
        summary.success += 1;
        if (DRY_RUN) wouldUpsertFacts += result.facts;
        else summary.inserted += result.facts;
        latestPeriod = result.latest && (!latestPeriod || result.latest > latestPeriod) ? result.latest : latestPeriod;
        console.log(JSON.stringify({ market: MARKET, ticker: stock.ticker, status: "COMPLETE", facts: result.facts, latestPeriod: result.latest, processed: summary.attempted, universe: stocks.length }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        summary.failed += 1;
        if (reason === "SEC_CIK_NOT_FOUND" || reason === "SEC_NO_CANONICAL_FACTS") summary.permanentUnavailable += 1;
        else summary.retryableFailure += 1;
        if (!DRY_RUN) await recordFailure(stock, reason);
        console.error(JSON.stringify({ market: MARKET, ticker: stock.ticker, status: "FAILED", reason, processed: summary.attempted, universe: stocks.length }));
      }
      if (runId && (summary.attempted % CHECKPOINT_EVERY === 0 || stock === selected.at(-1))) {
        await persistLifecycleCheckpoint(prisma, runId, summary, stock.ticker, INCREMENTAL ? { jobId: JOB_ID, targetTradeDate: TARGET_DATE, runType: RUN_TYPE } : undefined);
        await heartbeatLifecycleLock(prisma, JOB_ID, owner);
      }
      await sleep(REQUEST_DELAY_MS);
    }

    if (resumeIndex + 1 + selected.length < stocks.length) {
      if (runId) await pauseLifecycleRun(prisma, runId);
      console.log(JSON.stringify({ status: DRY_RUN ? "DRY_RUN_COMPLETE" : "PAUSED_CHECKPOINTED", market: MARKET, universe: stocks.length, ...summary, lastSymbol: selected.at(-1)?.ticker ?? resume?.last_symbol ?? null, wouldUpsertFacts: DRY_RUN ? wouldUpsertFacts : undefined, databaseWrites: DRY_RUN ? 0 : undefined }));
      return;
    }

    const coverageRows = await prisma.$queryRawUnsafe<Array<{ completed: number; earliest: Date | null; latest: Date | null; rows: bigint }>>(
      `SELECT COUNT(DISTINCT s.id)::int AS completed, MIN(f.period_end) AS earliest, MAX(f.period_end) AS latest, COUNT(f.id)::bigint AS rows
         FROM stocks s
         JOIN stock_financial_facts f ON f.stock_id = s.id AND f.source = 'SEC_EDGAR'
        WHERE s.exchange = $1 AND s.is_active = TRUE`,
      MARKET,
    );
    const coverage = coverageRows[0];
    const completed = Number(coverage?.completed ?? 0);
    const validation = {
      status: summary.attempted === stocks.length && summary.completed + summary.failed === stocks.length ? "PASS" : "FAIL",
      market: MARKET,
      universe: INCREMENTAL ? marketStocks.length : stocks.length,
      expectedFilers: stocks.length,
      processed: summary.attempted,
      stocksWithFinancialFacts: completed,
      coveragePercent: stocks.length ? Number(((completed / stocks.length) * 100).toFixed(6)) : 0,
      factRows: Number(coverage?.rows ?? 0n),
      earliestPeriod: coverage?.earliest?.toISOString().slice(0, 10) ?? null,
      latestPeriod: coverage?.latest?.toISOString().slice(0, 10) ?? latestPeriod,
      failures: summary.failed,
    };
    if (runId) await completeLifecycleRun(prisma, runId, summary, coverage?.latest ?? null, validation);
    console.log(JSON.stringify({ status: DRY_RUN ? "DRY_RUN_COMPLETE" : "COMPLETED", ...validation, wouldUpsertFacts: DRY_RUN ? wouldUpsertFacts : undefined, databaseWrites: DRY_RUN ? 0 : undefined }));
  } catch (error) {
    if (runId) await failLifecycleRun(prisma, runId, error);
    throw error;
  } finally {
    if (lockHeld) await releaseLifecycleLock(prisma, JOB_ID, owner);
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
