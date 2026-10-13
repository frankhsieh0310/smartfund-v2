// Cloud TW fundamentals (BWIBBU PE) refresh — bounded, idempotent, cloud-only, checkpoint/run-log via
// production_scheduler_runs / production_scheduler_checkpoints (same tables every other cloud job uses).
//
// Reuses the EXISTING writer's exact logic (scripts/data/financial/backfill-taiwan-official-pe.ts):
// TWSE BWIBBU_d + TPEx pera_result already return the WHOLE market in one call per exchange per day —
// that script already did single market-batch calls, it just only ran locally, wrote a local-file
// checkpoint, and artificially capped itself to `limit` (100) stocks. This route ports the same parsing
// or a stock, no new scraper. Only fetches TODAY's date (or ?date=), not a historical backfill.
//
// Trigger: GitHub Actions / Vercel cron -> GET with `Authorization: Bearer <CRON_SECRET>`.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";
import { prisma } from "@/lib/prisma";
import { beginRun, finishRun, readCheckpoint, writeCheckpoint } from "@/lib/cloud-ingestion/runContext";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const JOB = "CLOUD_TW_FUNDAMENTALS_REFRESH";
const PROVIDER = "TWSE_TPEX_BWIBBU";
const CHECKPOINT_KEY = "cloud-tw-fundamentals-refresh:DAILY";

type Exchange = "TWSE" | "TPEx";
const endpoints: Record<Exchange, string> = {
  TWSE: "https://www.twse.com.tw/exchangeReport/BWIBBU_d?response=json&date={date}&selectType=ALL",
  TPEx: "https://www.tpex.org.tw/web/stock/aftertrading/peratio_analysis/pera_result.php?l=zh-tw&o=json&d={date}&s=EW",
};
function rocDate(iso: string) {
  const [year, month, day] = iso.split("-").map(Number);
  return `${year - 1911}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
}
function numberOrNull(input: unknown): number | null {
  const parsed = Number(String(input ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "SmartFund official PE refresh contact@smartfund.app" } });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: response.status, body };
}
function rowsFor(exchange: Exchange, body: unknown): { fields: string[]; rows: string[][] } {
  if (exchange === "TWSE") { const data = body as { fields?: string[]; data?: string[][] }; return { fields: data.fields ?? [], rows: data.data ?? [] }; }
  const table = (body as { tables?: Array<{ fields?: string[]; data?: string[][] }> }).tables?.[0];
  return { fields: table?.fields ?? [], rows: table?.data ?? [] };
}
function dayBucketKey(prefix: string, now = new Date()): string {
  return `${prefix}:${now.toISOString().slice(0, 10)}`; // e.g. cloud-tw-fundamentals-refresh:2026-09-12
}

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();
  const startedMs = Date.now();
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);

  const targets = await prisma.stock.findMany({
    where: { isActive: true, exchange: { in: ["TWSE", "TPEx"] } },
    select: { id: true, ticker: true, exchange: true, currency: true },
  });
  const targetByExchange = new Map<Exchange, Map<string, { id: string; ticker: string; currency: string }>>(
    (["TWSE", "TPEx"] as const).map((exchange) => [exchange, new Map(targets.filter((t) => t.exchange === exchange).map((t) => [t.ticker, t]))]),
  );

  const before = await readCheckpoint(CHECKPOINT_KEY);
  const runKey = dayBucketKey("cloud-tw-fundamentals-refresh");
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: PROVIDER, runKey, universeCount: targets.length, batchSize: targets.length, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, job: JOB, skipped: true, reason: "already refreshed today", runKey, date });

  let inserted = 0;
  let failed = 0;
  const perExchange: Record<string, { matched: number; httpStatus: number } | { error: string }> = {};

  for (const exchange of ["TWSE", "TPEx"] as const) {
    const targetMap = targetByExchange.get(exchange)!;
    if (!targetMap.size) continue;
    const endpoint = endpoints[exchange].replace("{date}", exchange === "TWSE" ? date.replaceAll("-", "") : rocDate(date));
    try {
      const result = await fetchJson(endpoint);
      if (result.status !== 200) throw new Error(`${exchange}_HTTP_${result.status}`);
      const parsed = rowsFor(exchange, result.body);
      const tickerIndex = parsed.fields.indexOf("證券代號") >= 0 ? parsed.fields.indexOf("證券代號") : parsed.fields.indexOf("股票代號");
      const peIndex = parsed.fields.indexOf("本益比");
      if (tickerIndex < 0 || peIndex < 0) throw new Error(`${exchange}_UNEXPECTED_SCHEMA:${JSON.stringify(parsed.fields)}`);
      const imports = parsed.rows.flatMap((row) => {
        const ticker = row[tickerIndex]?.trim();
        const pe = numberOrNull(row[peIndex]);
        const stock = ticker ? targetMap.get(ticker) : undefined;
        return stock && pe !== null
          ? [{ stockId: stock.id, metric: "valuation.pe", periodEnd: new Date(`${date}T00:00:00.000Z`), value: pe, unit: "RATIO", currency: stock.currency, source: `${exchange}_OFFICIAL_BWIBBU`, sourceFactKey: `${exchange}:${ticker}:${date}`, sourceDocumentUrl: endpoint }]
          : [];
      });
      if (imports.length) inserted += (await prisma.stockFinancialFact.createMany({ data: imports, skipDuplicates: true })).count;
      perExchange[exchange] = { matched: imports.length, httpStatus: result.status };
    } catch (error) {
      failed += 1;
      perExchange[exchange] = { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const after = { lastSymbol: date, processed: (before?.processed ?? 0) + targets.length, succeeded: (before?.succeeded ?? 0) + inserted, failed: (before?.failed ?? 0) + failed, updatedAt: new Date().toISOString() };
  await writeCheckpoint(JOB, CHECKPOINT_KEY, runId, { lastSymbol: after.lastSymbol, processed: after.processed, succeeded: after.succeeded, failed: after.failed });

  const status = failed === 2 ? "FAILED" : failed > 0 ? "PARTIAL" : "COMPLETED";
  await finishRun(runId, JOB, PROVIDER, startedMs, {
    status, attempted: targets.length, completed: inserted, inserted, updated: 0, failed,
    retryableFailures: failed, checkpointAfter: after, error: failed ? JSON.stringify(perExchange) : null,
    details: { date, per_exchange: perExchange, universe: targets.length },
  });

  return Response.json({ ok: status !== "FAILED", job: JOB, runId, date, universe: targets.length, factsWritten: inserted, failed, perExchange, runtimeMs: Date.now() - startedMs, status });
}
