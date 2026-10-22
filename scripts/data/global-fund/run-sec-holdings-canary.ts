import { PrismaClient } from "@prisma/client";
import { load } from "cheerio";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();
const source = "SEC_EDGAR_NPORT_P";
const runtimeDir = resolve("runtime/global-fund/holdings");
const userAgent = "SmartFund fund holdings data operator admin@smartfund.local";

const funds = [
  { fundId: "5e117518-e03c-4666-835e-5c51fc2007c8", shareClassId: "6f6ec77e-ff8f-4a6f-a4a4-26e191518ffd", classId: "C000007774", seriesId: "S000002839", filingId: "0000036405-26-000325", cik: "36405" },
  { fundId: "d16b934d-c936-4ae5-8b59-3bcee04f20da", shareClassId: "7952b3d3-52c5-4b27-a013-5636745ef08a", classId: "C000018340", seriesId: "S000006758", filingId: "0002071691-26-012272", cik: "38721" },
  { fundId: "279924b4-0dce-40a7-a5ac-5d50321caf99", shareClassId: "8663dca0-aeb8-4157-a1ce-b515614dd90a", classId: "C000199721", seriesId: "S000006758", filingId: "0002071691-26-012272", cik: "38721" },
] as const;

type ParsedHolding = {
  sourceRecordId: string;
  name: string;
  isin: string | null;
  cusip: string | null;
  ticker: string | null;
  balance: string | null;
  shares: string | null;
  marketValue: string | null;
  weight: string;
  currency: string | null;
};

async function atomicJson(name: string, value: unknown) {
  await mkdir(runtimeDir, { recursive: true });
  const path = resolve(runtimeDir, name);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function fetchFiling(cik: string, filingId: string, seriesId: string) {
  const accession = filingId.replaceAll("-", "");
  const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession}/primary_doc.xml`;
  const response = await fetch(url, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`SEC_NPORT_HTTP_${response.status}:${filingId}`);
  const $ = load(await response.text(), { xmlMode: true });
  if ($("seriesId").first().text().trim() !== seriesId) throw new Error(`SEC_NPORT_SERIES_MISMATCH:${filingId}`);
  const reportDate = $("repPdDate").first().text().trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error(`SEC_NPORT_REPORT_DATE_MISSING:${filingId}`);
  const holdings: ParsedHolding[] = [];
  $("invstOrSec").slice(0, 10).each((index, element) => {
    const node = $(element);
    const name = node.find("name").first().text().trim();
    const cusip = node.find("cusip").first().text().trim() || null;
    const isin = node.find("identifiers isin").first().attr("value")?.trim() || null;
    const ticker = node.find("identifiers ticker").first().attr("value")?.trim() || null;
    const balance = node.find("balance").first().text().trim() || null;
    const units = node.find("units").first().text().trim();
    const marketValue = node.find("valUSD").first().text().trim() || null;
    const weight = node.find("pctVal").first().text().trim();
    if (!name || !weight || !Number.isFinite(Number(weight))) throw new Error(`SEC_NPORT_HOLDING_SEMANTICS:${filingId}:${index}`);
    holdings.push({ sourceRecordId: `${index + 1}|${isin ?? cusip ?? ticker ?? name}`, name, isin, cusip, ticker, balance, shares: units === "NS" ? balance : null, marketValue, weight, currency: node.find("curCd").first().text().trim() || null });
  });
  if (holdings.length !== 10) throw new Error(`SEC_NPORT_CANARY_HOLDING_COUNT:${filingId}:${holdings.length}`);
  return { reportDate, holdings, url };
}

async function main() {
  const filingCache = new Map<string, Awaited<ReturnType<typeof fetchFiling>>>();
  for (const fund of funds) {
    const key = `${fund.filingId}|${fund.seriesId}`;
    if (!filingCache.has(key)) filingCache.set(key, await fetchFiling(fund.cik, fund.filingId, fund.seriesId));
  }
  const identities = [...filingCache.values()].flatMap((filing) => filing.holdings);
  const isins = [...new Set(identities.flatMap((holding) => holding.isin ? [holding.isin] : []))];
  const cusips = [...new Set(identities.flatMap((holding) => holding.cusip ? [holding.cusip] : []))];
  const securities = await prisma.$queryRawUnsafe<Array<{ id: string; isin: string | null; cusip: string | null }>>(
    `SELECT id,isin,cusip FROM securities WHERE isin=ANY($1::text[]) OR cusip=ANY($2::text[])`, isins, cusips,
  );
  const byIsin = new Map<string, string[]>();
  const byCusip = new Map<string, string[]>();
  for (const security of securities) {
    if (security.isin) byIsin.set(security.isin, [...(byIsin.get(security.isin) ?? []), security.id]);
    if (security.cusip) byCusip.set(security.cusip, [...(byCusip.get(security.cusip) ?? []), security.id]);
  }
  const resolveSecurity = (holding: ParsedHolding) => {
    const ids = holding.isin ? byIsin.get(holding.isin) : holding.cusip ? byCusip.get(holding.cusip) : undefined;
    return ids?.length === 1 ? ids[0] : null;
  };

  await prisma.$transaction(async (tx) => {
    for (const fund of funds) {
      const filing = filingCache.get(`${fund.filingId}|${fund.seriesId}`)!;
      for (const [index, holding] of filing.holdings.entries()) {
        await tx.$executeRawUnsafe(
          `INSERT INTO holdings (id,asset_type,fund_id,share_class_id,as_of_date,rank,holding_name,holding_code,weight,security_id,isin,cusip,ticker,amount,shares,market_value,currency,source,source_record_id,filing_id,weight_method,created_at)
           VALUES ($1,'FUND',$2,$3,$4::date,$5,$6,$7,$8::numeric,$9,$10,$11,$12,$13::numeric,$14::numeric,$15::numeric,$16,$17,$18,$19,'SOURCE_REPORTED',CURRENT_TIMESTAMP)
           ON CONFLICT (fund_id,source,filing_id,source_record_id)
           WHERE fund_id IS NOT NULL AND source IS NOT NULL AND filing_id IS NOT NULL AND source_record_id IS NOT NULL
           DO UPDATE SET share_class_id=EXCLUDED.share_class_id,as_of_date=EXCLUDED.as_of_date,rank=EXCLUDED.rank,holding_name=EXCLUDED.holding_name,holding_code=EXCLUDED.holding_code,weight=EXCLUDED.weight,security_id=EXCLUDED.security_id,isin=EXCLUDED.isin,cusip=EXCLUDED.cusip,ticker=EXCLUDED.ticker,amount=EXCLUDED.amount,shares=EXCLUDED.shares,market_value=EXCLUDED.market_value,currency=EXCLUDED.currency,weight_method=EXCLUDED.weight_method`,
          randomUUID(), fund.fundId, fund.shareClassId, filing.reportDate, index + 1, holding.name,
          holding.isin ?? holding.cusip ?? holding.ticker, holding.weight, resolveSecurity(holding), holding.isin,
          holding.cusip, holding.ticker, holding.balance, holding.shares, holding.marketValue, holding.currency,
          source, holding.sourceRecordId, fund.filingId,
        );
      }
    }
  }, { maxWait: 10_000, timeout: 30_000 });

  const readBack = await prisma.$queryRawUnsafe<Array<{ fundId: string; filingId: string; rows: number; matched: number; reportDate: Date }>>(
    `SELECT fund_id AS "fundId",filing_id AS "filingId",COUNT(*)::int rows,COUNT(security_id)::int matched,MAX(as_of_date) AS "reportDate"
     FROM holdings WHERE asset_type='FUND' AND source=$1 AND (fund_id,filing_id) IN (($2,$3),($4,$5),($6,$7))
     GROUP BY fund_id,filing_id ORDER BY fund_id`, source,
    funds[0].fundId, funds[0].filingId, funds[1].fundId, funds[1].filingId, funds[2].fundId, funds[2].filingId,
  );
  if (readBack.length !== 3 || readBack.some((row) => row.rows < 10)) throw new Error(`SEC_HOLDINGS_READ_BACK_FAILED:${JSON.stringify(readBack)}`);
  const completedAt = new Date();
  await atomicJson("checkpoint.json", { version: 1, source, fundId: funds.at(-1)!.fundId, filingId: funds.at(-1)!.filingId, reportDate: "2026-03-31", lastProcessedHolding: 10, lastSuccessfulRun: completedAt.toISOString(), nextEligibleAt: new Date(completedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(), status: "CURRENT" });
  await atomicJson("queue.json", { version: 1, updatedAt: completedAt.toISOString(), active: false, boundedConcurrency: 1, items: funds.map((fund) => ({ fundId: fund.fundId, shareClassId: fund.shareClassId, source, sourceIdentity: fund.classId, lastReportDate: "2026-03-31", nextEligibleAt: null, status: "CURRENT" })) });
  console.log(JSON.stringify({ fetch: "PASS", parse: "PASS", semantics: "PASS", fundIdentity: "PASS", writeCanary: "PASS", readBack }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
