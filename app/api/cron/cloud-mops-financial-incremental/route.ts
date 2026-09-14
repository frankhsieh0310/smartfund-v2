// Cloud MOPS financial incremental — bounded, idempotent, cloud-only. Checkpoint/run-log via
// production_scheduler_runs / production_scheduler_checkpoints (checkpoint key "fundamentals:mops").
//
// Ports the exact parsing/mapping logic from scripts/data/financial/backfill-taiwan-official-financial.ts
// (same MOPS ajax endpoints, same table scraper, same canonicalMetric regex table, same upsert SQL) — not
// a rewrite. What's different for cloud-safety: that script always writes a raw HTML/JSON archive to the
// local filesystem before parsing (fine on a machine with persistent disk, impossible on a stateless
// Vercel function) and defaults to a multi-year historical window. This route only ever fetches the most
// recently completed 1-2 fiscal quarters (whichever the calendar says should already be filed) — a true
// incremental check, not a re-scrape of MOPS history — and keeps its checkpoint in Postgres instead of a
// JSON file.
import { load } from "cheerio";
import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 120;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_MOPS_FINANCIAL_INCREMENTAL";
const PROVIDER = "MOPS_TWSE_TPEX";
const CHECKPOINT_KEY = "fundamentals:mops";
const MOPS_BASE = "https://mopsov.twse.com.tw/mops/web";
type Market = "TWSE" | "TPEX";
type StatementType = "income" | "balance" | "cashflow";
const ENDPOINTS: Record<StatementType, string> = { income: `${MOPS_BASE}/ajax_t163sb04`, balance: `${MOPS_BASE}/ajax_t163sb05`, cashflow: `${MOPS_BASE}/ajax_t163sb20` };
const SOURCE_BY_MARKET: Record<Market, string> = { TWSE: "MOPS_TWSE_FINANCIAL", TPEX: "MOPS_TPEX_FINANCIAL" };
const TYPEK_BY_MARKET: Record<Market, string> = { TWSE: "sii", TPEX: "otc" };

function periodEndFor(rocYear: number, season: number): string { const year = rocYear + 1911; const dates = ["03-31", "06-30", "09-30", "12-31"]; return `${year}-${dates[season - 1]}`; }
function periodStartFor(rocYear: number): string { return `${rocYear + 1911}-01-01`; }
function fiscalPeriodFor(season: number): string { return season === 4 ? "FY" : `Q${season}_YTD`; }
function normalizeText(value: string): string { return value.replace(/ /g, " ").replace(/\s+/g, " ").trim(); }
function parseNumber(value: string): string | null {
  const normalized = normalizeText(value).replace(/,/g, "").replace(/％/g, "").replace(/%/g, "").replace(/^\((.+)\)$/, "-$1");
  if (!normalized || normalized === "--" || normalized === "-" || normalized === "N/A") return null;
  return Number.isFinite(Number(normalized)) ? normalized : null;
}
// Same regex table as the existing local writer — reused verbatim, not redesigned.
function canonicalMetric(statementType: StatementType, sourceField: string): { metric: string; unit: string } {
  const field = sourceField.replace(/\s+/g, "");
  const mappings: Array<[RegExp, string, string]> = statementType === "income"
    ? [
        [/^(營業收入|收入|收益合計)$/, "financial.revenue", "TWD_THOUSANDS"],
        [/^(營業成本|支出合計)$/, "financial.cost_of_revenue", "TWD_THOUSANDS"],
        [/營業毛利|營業毛損/, "financial.gross_profit", "TWD_THOUSANDS"],
        [/^營業費用/, "financial.operating_expenses", "TWD_THOUSANDS"],
        [/營業利益|營業損失/, "financial.operating_income", "TWD_THOUSANDS"],
        [/稅前.*(淨利|淨損|利益|損失)/, "financial.pretax_income", "TWD_THOUSANDS"],
        [/所得稅(費用|利益)/, "financial.income_tax", "TWD_THOUSANDS"],
        [/^(本期淨利|本期淨損|本期稅後淨利|本期稅後淨損)/, "financial.net_income", "TWD_THOUSANDS"],
        [/基本每股盈餘|基本每股虧損/, "financial.basic_eps", "TWD_PER_SHARE"],
        [/稀釋每股盈餘|稀釋每股虧損/, "financial.diluted_eps", "TWD_PER_SHARE"],
      ]
    : statementType === "balance"
      ? [
          [/^現金及約當現金$/, "financial.cash_and_cash_equivalents", "TWD_THOUSANDS"],
          [/短期投資|透過損益按公允價值衡量之金融資產.*流動|按攤銷後成本衡量之金融資產.*流動/, "financial.short_term_investments", "TWD_THOUSANDS"],
          [/應收帳款/, "financial.accounts_receivable", "TWD_THOUSANDS"],
          [/^存貨/, "financial.inventory", "TWD_THOUSANDS"],
          [/^流動資產/, "financial.current_assets", "TWD_THOUSANDS"],
          [/不動產、廠房及設備|不動產廠房及設備/, "financial.property_plant_equipment", "TWD_THOUSANDS"],
          [/^資產總計$/, "financial.total_assets", "TWD_THOUSANDS"],
          [/^流動負債/, "financial.current_liabilities", "TWD_THOUSANDS"],
          [/短期借款|短期債務/, "financial.short_term_debt", "TWD_THOUSANDS"],
          [/長期借款|長期債務/, "financial.long_term_debt", "TWD_THOUSANDS"],
          [/^負債總計$/, "financial.total_liabilities", "TWD_THOUSANDS"],
          [/權益總計|權益總額/, "financial.shareholders_equity", "TWD_THOUSANDS"],
        ]
      : [
          [/營業活動之淨現金流入|營業活動之淨現金流出/, "financial.operating_cash_flow", "TWD_THOUSANDS"],
          [/投資活動之淨現金流入|投資活動之淨現金流出/, "financial.investing_cash_flow", "TWD_THOUSANDS"],
          [/籌資活動之淨現金流入|籌資活動之淨現金流出/, "financial.financing_cash_flow", "TWD_THOUSANDS"],
          [/取得不動產、廠房及設備|購置不動產、廠房及設備/, "financial.capital_expenditure", "TWD_THOUSANDS"],
          [/期末現金及約當現金餘額/, "financial.ending_cash_and_cash_equivalents", "TWD_THOUSANDS"],
        ];
  const found = mappings.find(([pattern]) => pattern.test(field));
  if (found) return { metric: found[1], unit: found[2] };
  return { metric: `mops.raw.${statementType}.${field}`, unit: /每股/.test(field) ? "TWD_PER_SHARE" : "TWD_THOUSANDS" };
}
type ParsedFact = { officialSymbol: string; metric: string; value: string; unit: string; fiscalPeriod: string; periodStart: string; periodEnd: string; source: string; sourceFactKey: string; sourceUrl: string };
function parseMopsHtml(market: Market, statementType: StatementType, rocYear: number, season: number, html: string): ParsedFact[] {
  const $ = load(html);
  const facts: ParsedFact[] = [];
  const periodEnd = periodEndFor(rocYear, season);
  const sourceKey = `${market}:${rocYear}:Q${season}:${statementType}`;
  $("table.hasBorder").each((_, table) => {
    let headers: string[] = [];
    $(table).find("tr").each((__, row) => {
      const cells = $(row).find("th,td").toArray().map((cell) => normalizeText($(cell).text()));
      if (cells.length < 3) return;
      const containsHeader = $(row).find("th").length > 0 || /公司.*代號/.test(cells[0]);
      if (containsHeader) { headers = cells; return; }
      if (headers.length !== cells.length) return;
      const officialSymbol = cells[0].replace(/\s+/g, "");
      if (!/^[0-9A-Z]{4,8}$/.test(officialSymbol)) return;
      for (let index = 2; index < cells.length; index += 1) {
        const sourceField = headers[index];
        const value = parseNumber(cells[index]);
        if (!sourceField || value === null) continue;
        const mapped = canonicalMetric(statementType, sourceField);
        facts.push({ officialSymbol, metric: mapped.metric, value, unit: mapped.unit, fiscalPeriod: fiscalPeriodFor(season), periodStart: periodStartFor(rocYear), periodEnd, source: SOURCE_BY_MARKET[market], sourceFactKey: `${sourceKey}:${officialSymbol}:${sourceField}`, sourceUrl: ENDPOINTS[statementType] });
      }
    });
  });
  return facts;
}
async function fetchMops(market: Market, statementType: StatementType, rocYear: number, season: number): Promise<string> {
  const body = new URLSearchParams({ encodeURIComponent: "1", step: "1", firstin: "1", off: "1", TYPEK: TYPEK_BY_MARKET[market], year: String(rocYear), season: String(season) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(ENDPOINTS[statementType], { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "SmartFund Official Filing Ingestion/1.0 contact@smartfund.app" }, body, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const html = await response.text();
    if (!html.includes("公司") || !html.includes("hasBorder")) throw new Error("MOPS_EMPTY_OR_UNEXPECTED_RESPONSE");
    return html;
  } finally { clearTimeout(timer); }
}
// Which (rocYear, season) pairs should already be publicly filed by now, most-recent first. MOPS filing
// deadlines run ~45 days after quarter-end (Q1-Q3) / ~90-120 days after fiscal year-end (Q4/annual) — a
// generous fixed lookback of the last 3 completed quarters covers slow filers without rechecking years
// of history every run.
function recentPeriods(): Array<{ rocYear: number; season: number }> {
  const now = new Date();
  const rocYear = now.getUTCFullYear() - 1911;
  const quarterEndDates = [1, 2, 3, 4].map((season) => ({ rocYear, season, end: periodEndFor(rocYear, season) }))
    .concat([1, 2, 3, 4].map((season) => ({ rocYear: rocYear - 1, season, end: periodEndFor(rocYear - 1, season) })));
  const todayIso = now.toISOString().slice(0, 10);
  return quarterEndDates.filter((q) => q.end <= todayIso).sort((a, b) => b.end.localeCompare(a.end)).slice(0, 3);
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const periods = recentPeriods();
  const markets: Market[] = ["TWSE", "TPEX"];
  const statementTypes: StatementType[] = ["income", "balance", "cashflow"];

  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = `cloud-mops-financial-incremental:${new Date().toISOString().slice(0, 10)}`;
  const universeCount = periods.length * markets.length * statementTypes.length;
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount, batchSize: universeCount, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "already checked today", runKey });

  let attempted = 0;
  let inserted = 0;
  let failed = 0;
  let latestPeriod: string | null = null;
  const failures: Array<{ task: string; reason: string }> = [];

  for (const { rocYear, season } of periods) {
    for (const market of markets) {
      for (const statementType of statementTypes) {
        attempted++;
        const taskKey = `${market}:${rocYear}:Q${season}:${statementType}`;
        try {
          const html = await fetchMops(market, statementType, rocYear, season);
          const facts = parseMopsHtml(market, statementType, rocYear, season, html);
          if (facts.length) {
            const symbols = [...new Set(facts.map((f) => f.officialSymbol))];
            const stocks = await prisma.stock.findMany({ where: { exchange: market === "TPEX" ? { in: ["TPEX", "TPEx"] } : "TWSE", ticker: { in: symbols } }, select: { id: true, ticker: true } });
            const stockByTicker = new Map(stocks.map((s) => [s.ticker, s.id]));
            const payload = facts.flatMap((f) => {
              const stockId = stockByTicker.get(f.officialSymbol);
              return stockId ? [{ id: crypto.randomUUID(), stock_id: stockId, metric: f.metric, period_start: f.periodStart, period_end: f.periodEnd, fiscal_period: f.fiscalPeriod, form_type: `MOPS_${statementType.toUpperCase()}`, value: f.value, unit: f.unit, currency: "TWD", source: f.source, source_fact_key: f.sourceFactKey, source_document_url: f.sourceUrl }] : [];
            });
            for (let offset = 0; offset < payload.length; offset += 5000) {
              const chunk = payload.slice(offset, offset + 5000);
              if (!chunk.length) continue;
              await prisma.$executeRawUnsafe(
                `INSERT INTO stock_financial_facts (id, stock_id, metric, period_start, period_end, fiscal_period, form_type, value, unit, currency, source, source_fact_key, source_document_url, imported_at, updated_at)
                 SELECT x.id::uuid, x.stock_id::uuid, x.metric, x.period_start::date, x.period_end::date, x.fiscal_period, x.form_type, x.value::numeric, x.unit, x.currency, x.source, x.source_fact_key, x.source_document_url, NOW(), NOW()
                 FROM jsonb_to_recordset($1::jsonb) AS x(id text, stock_id text, metric text, period_start text, period_end text, fiscal_period text, form_type text, value text, unit text, currency text, source text, source_fact_key text, source_document_url text)
                 ON CONFLICT (stock_id, metric, period_end, source, source_fact_key)
                 DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                JSON.stringify(chunk),
              );
              inserted += chunk.length;
            }
            const thisPeriod: string = periodEndFor(rocYear, season);
            if (latestPeriod === null || thisPeriod > (latestPeriod as string)) latestPeriod = thisPeriod;
          }
        } catch (error) {
          failed++;
          failures.push({ task: taskKey, reason: error instanceof Error ? error.message : String(error) });
        }
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  const after = { lastSymbol: latestPeriod, processed: (before?.processed ?? 0) + attempted, succeeded: (before?.succeeded ?? 0) + inserted, failed: (before?.failed ?? 0) + failed, updatedAt: new Date().toISOString() };
  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: after.lastSymbol, processed: after.processed, succeeded: after.succeeded, failed: after.failed });
  const status = failed === attempted ? "FAILED" : failed > 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status, attempted, completed: attempted - failed, inserted, updated: 0, failed, retryableFailures: failed,
    checkpointAfter: after, error: failures.length ? JSON.stringify(failures.slice(0, 5)) : null,
    details: { periods, latest_period: latestPeriod, sample_failures: failures.slice(0, 5) },
  });

  return Response.json({ ok: status !== "FAILED", job: JOB, runId, periods, attempted, factsWritten: inserted, failed, latestPeriod, runtimeMs: Date.now() - startedMs, status });
}
