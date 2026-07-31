import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type SecFact = { start?: string; end: string; fy?: number; fp?: string; form?: string; filed?: string; accn?: string };
type Checkpoint = { metric: string; lastStockId?: string; processed: number; succeeded: number; failed: number; rows: number; updatedAt: string };

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } },
});
const args = new Map(process.argv.slice(2).map((value) => {
  const [key, ...rest] = value.replace(/^--/, "").split("=");
  return [key, rest.join("=") || "true"];
}));
const metric = args.get("metric") ?? "revenue";
const limit = Number(args.get("limit") ?? 0);
const resume = args.has("resume");
const checkpointPath = resolve("debug", "financial", `sec-${metric}-checkpoint.json`);
const jobId = `financial-sec-${metric}-us`;

const CONCEPTS: Record<string, string[]> = {
  revenue: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax"],
};

if (!CONCEPTS[metric]) throw new Error(`Unsupported canonical raw metric: ${metric}`);

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { "User-Agent": "SmartFund financial research contact@smartfund.app", Accept: "application/json" } });
  if (!response.ok) throw new Error(`SEC HTTP ${response.status}: ${url}`);
  return response.json() as Promise<T>;
}

async function loadCheckpoint(): Promise<Checkpoint> {
  if (!resume) return { metric, processed: 0, succeeded: 0, failed: 0, rows: 0, updatedAt: new Date().toISOString() };
  try { return JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint; }
  catch { return { metric, processed: 0, succeeded: 0, failed: 0, rows: 0, updatedAt: new Date().toISOString() }; }
}

async function saveCheckpoint(value: Checkpoint) {
  value.updatedAt = new Date().toISOString();
  await mkdir(dirname(checkpointPath), { recursive: true });
  await writeFile(checkpointPath, JSON.stringify(value, null, 2));
}

async function main() {
  const [tickerPayload, checkpoint] = await Promise.all([
    fetchJson<Record<string, { ticker: string; cik_str: number }>>("https://www.sec.gov/files/company_tickers.json"),
    loadCheckpoint(),
  ]);
  const cikByTicker = new Map(Object.values(tickerPayload).map((item) => [item.ticker.toUpperCase(), String(item.cik_str).padStart(10, "0")]));
  const allStocks = await prisma.stock.findMany({
    where: { exchange: { in: ["NASDAQ", "NYSE", "AMEX"] }, isActive: true },
    select: { id: true, ticker: true }, orderBy: { id: "asc" },
  });
  const start = checkpoint.lastStockId ? Math.max(0, allStocks.findIndex((stock) => stock.id === checkpoint.lastStockId) + 1) : 0;
  const stocks = limit > 0 ? allStocks.slice(start, start + limit) : allStocks.slice(start);

  for (const stock of stocks) {
    checkpoint.processed += 1;
    try {
      const cik = cikByTicker.get(stock.ticker.toUpperCase());
      if (!cik) throw new Error("SEC_CIK_NOT_FOUND");
      const facts = await fetchJson<{ facts?: { "us-gaap"?: Record<string, { units?: Record<string, SecFact[]> }> } }>(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
      const gaap = facts.facts?.["us-gaap"] ?? {};
      const concept = CONCEPTS[metric].find((name) => Array.isArray(gaap[name]?.units?.USD));
      if (!concept) throw new Error("SEC_CONCEPT_NOT_FOUND");
      const values = (gaap[concept].units?.USD ?? []).filter((item) => item.start && item.end && ["10-K", "10-Q", "20-F", "40-F"].includes(item.form ?? ""));
      if (!values.length) throw new Error("SEC_NO_PERIOD_FACTS");
      const created = await prisma.stockFinancialFact.createMany({
        data: values.map((fact) => ({
          stockId: stock.id, metric, periodStart: new Date(`${fact.start}T00:00:00.000Z`), periodEnd: new Date(`${fact.end}T00:00:00.000Z`),
          fiscalPeriod: fact.fp, formType: fact.form, filingDate: fact.filed ? new Date(`${fact.filed}T00:00:00.000Z`) : undefined,
          publicationDate: fact.filed ? new Date(`${fact.filed}T00:00:00.000Z`) : undefined, value: (fact as SecFact & { val?: number }).val ?? 0,
          unit: "USD", currency: "USD", source: "SEC_EDGAR", sourceFactKey: `${concept}:${fact.accn ?? "NO_ACCN"}:${fact.start}:${fact.end}`,
          sourceDocumentUrl: fact.accn ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${fact.accn.replaceAll("-", "")}/` : undefined,
          restatementVersion: fact.filed,
        })), skipDuplicates: true,
      });
      await prisma.productionSchedulerFailure.deleteMany({ where: { jobId, stockId: stock.id } });
      checkpoint.succeeded += 1; checkpoint.rows += created.count;
    } catch (error) {
      checkpoint.failed += 1;
      const lastError = error instanceof Error ? error.message : String(error);
      await prisma.productionSchedulerFailure.upsert({
        where: { jobId_stockId: { jobId, stockId: stock.id } },
        create: { jobId, stockId: stock.id, symbol: stock.ticker, lastError },
        update: { symbol: stock.ticker, lastError, attempts: { increment: 1 }, lastAttemptedAt: new Date() },
      });
      console.error(JSON.stringify({ stock: stock.ticker, metric, error: lastError }));
    }
    checkpoint.lastStockId = stock.id;
    if (checkpoint.processed % 25 === 0) await saveCheckpoint(checkpoint);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  await saveCheckpoint(checkpoint);
  console.log(JSON.stringify({ status: "COMPLETE", metric, universe: allStocks.length, ...checkpoint }));
}

main().finally(() => prisma.$disconnect());
