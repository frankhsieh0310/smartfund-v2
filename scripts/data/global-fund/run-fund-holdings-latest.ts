import { PrismaClient } from "@prisma/client";
import { load } from "cheerio";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { writeAssetRuntimeStatus } from "../runtime-status/write-asset-runtime-status.ts";
import { spawn } from "node:child_process";

const prisma = new PrismaClient();
const source = "SEC_EDGAR_NPORT_P";
const runtimeDir = resolve("runtime/global-fund/holdings");
const userAgent = "SmartFund fund holdings data operator admin@smartfund.local";
const registry = JSON.parse(readFileSync(resolve("config/fund-holdings-sec-registry.json"), "utf8")) as {
  funds: Array<{ fundId: string; shareClassId: string | null; cik: string; seriesId: string; classId: string }>;
};

type Holding = { sourceRecordId: string; name: string; isin: string | null; cusip: string | null; ticker: string | null; balance: string | null; shares: string | null; marketValue: string | null; weight: string; currency: string | null; assetCategory:string; issuerCategory:string|null; country:string|null };
type Filing = { filingId: string; reportDate: string; filingDate: string; url: string; rawXml:string; holdings: Holding[] };

async function atomicJson(name: string, value: unknown) {
  await mkdir(runtimeDir, { recursive: true });
  const path = resolve(runtimeDir, name);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function atomicSharedSecJson(name: string, value: unknown) {
  const directory = resolve("runtime/sec-investment-company");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, name);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function secJson(url: string) {
  const response = await fetch(url, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`SEC_HTTP_${response.status}:${url}`);
  return response.json() as Promise<any>;
}

async function locateLatest(cik: string, seriesId: string): Promise<Filing> {
  const submissions = await secJson(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const recent = submissions.filings.recent;
  let checked = 0;
  for (let index = 0; index < recent.form.length && checked < 25; index += 1) {
    if (recent.form[index] !== "NPORT-P") continue;
    checked += 1;
    const filingId = recent.accessionNumber[index] as string;
    const accession = filingId.replaceAll("-", "");
    const archiveCik = String(Number(cik));
    const url = `https://www.sec.gov/Archives/edgar/data/${archiveCik}/${accession}/primary_doc.xml`;
    const response = await fetch(url, { headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) continue;
    const rawXml=await response.text();
    const $ = load(rawXml, { xmlMode: true });
    if ($("seriesId").first().text().trim() !== seriesId) continue;
    const reportDate = $("repPdDate").first().text().trim();
    const holdings: Holding[] = [];
    $("invstOrSec").each((holdingIndex, element) => {
      const node = $(element);
      const name = node.find("name").first().text().trim();
      const cusip = node.find("cusip").first().text().trim() || null;
      const isin = node.find("identifiers isin").first().attr("value")?.trim() || null;
      const ticker = node.find("identifiers ticker").first().attr("value")?.trim() || null;
      const balance = node.find("balance").first().text().trim() || null;
      const units = node.find("units").first().text().trim();
      const weight = node.find("pctVal").first().text().trim();
      if (!name || !weight || !Number.isFinite(Number(weight))) throw new Error(`NPORT_SEMANTICS:${filingId}:${holdingIndex}`);
      holdings.push({ sourceRecordId: `${holdingIndex + 1}|${isin ?? cusip ?? ticker ?? name}`, name, isin, cusip, ticker, balance, shares: units === "NS" ? balance : null, marketValue: node.find("valUSD").first().text().trim() || null, weight, currency: node.find("curCd").first().text().trim() || node.find("currencyConditional").first().attr("curCd")?.trim() || null, assetCategory:node.find("assetCat").first().text().trim(),issuerCategory:node.find("issuerCat").first().text().trim()||node.find("issuerConditional").first().attr("issuerCat")?.trim()||null,country:node.find("invCountry").first().text().trim()||null });
    });
    if (!holdings.length || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error(`NPORT_PARSE:${filingId}`);
    return { filingId, reportDate, filingDate: recent.filingDate[index], url, rawXml, holdings };
  }
  throw new Error(`SEC_SERIES_LATEST_NOT_FOUND:${cik}:${seriesId}`);
}

async function main() {
  const completed: any[] = [];
  const failed: any[] = [];
  const filingCache = new Map<string, Filing>();
  for (const fund of registry.funds) {
    try {
      const verified = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
        `SELECT EXISTS (SELECT 1 FROM fund_provider_mappings WHERE fund_id=$1 AND provider='SEC' AND provider_code=$2 AND source='SEC_EDGAR_SERIES_CLASS' AND verified_at IS NOT NULL AND mapping_method IN ('EXACT_SEC_SERIES_ID','EXACT_SEC_CLASS_ID','EXACT_ISIN')) ok`, fund.fundId, fund.classId,
      );
      if (!verified[0]?.ok) throw new Error("UNVERIFIED_FUND_IDENTITY");
      const cacheKey = `${fund.cik}|${fund.seriesId}`;
      if (!filingCache.has(cacheKey)) filingCache.set(cacheKey, await locateLatest(fund.cik, fund.seriesId));
      const filing = filingCache.get(cacheKey)!;
      const archiveDirectory=resolve("runtime/global-fund/nport-regulatory-recovery/archive"),metadataDirectory=resolve("runtime/global-fund/nport-regulatory-recovery/metadata");
      await mkdir(archiveDirectory,{recursive:true});await mkdir(metadataDirectory,{recursive:true});
      const checksum=`sha256:${createHash("sha256").update(filing.rawXml).digest("hex")}`;
      await writeFile(resolve(archiveDirectory,`${filing.filingId}.xml`),filing.rawXml,"utf8");
      await writeFile(resolve(metadataDirectory,`${filing.filingId}.future-ingestion.json`),`${JSON.stringify({version:1,source,accession:filing.filingId,sourceUrl:filing.url,retrievedAt:new Date().toISOString(),rawArtifactRef:`runtime/global-fund/nport-regulatory-recovery/archive/${filing.filingId}.xml`,checksum,filingDate:filing.filingDate,reportDate:filing.reportDate,items:filing.holdings},null,2)}\n`,"utf8");
      const existing = await prisma.$queryRawUnsafe<Array<{ rows: number }>>(
        `SELECT COUNT(*)::int rows FROM holdings WHERE asset_type='FUND' AND fund_id=$1 AND source=$2 AND filing_id=$3`, fund.fundId, source, filing.filingId,
      );
      if (existing[0]?.rows === filing.holdings.length) {
        completed.push({ ...fund, filingId: filing.filingId, reportDate: filing.reportDate, holdings: filing.holdings.length, action: "SKIP_CURRENT" });
        continue;
      }
      const isins = [...new Set(filing.holdings.flatMap((holding) => holding.isin ? [holding.isin] : []))];
      const cusips = [...new Set(filing.holdings.flatMap((holding) => holding.cusip ? [holding.cusip] : []))];
      const securities = await prisma.$queryRawUnsafe<Array<{ id: string; isin: string | null; cusip: string | null }>>(`SELECT id,isin,cusip FROM securities WHERE isin=ANY($1::text[]) OR cusip=ANY($2::text[])`, isins, cusips);
      const identity = new Map<string, string[]>();
      for (const security of securities) for (const key of [security.isin, security.cusip]) if (key) identity.set(key, [...(identity.get(key) ?? []), security.id]);
      await prisma.$transaction(async (tx) => {
        const lock = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(`SELECT pg_try_advisory_xact_lock(hashtext('smartfund:fund-holdings:latest:v1')) locked`);
        if (!lock[0]?.locked) throw new Error("FUND_HOLDINGS_SINGLE_WRITER_LOCKED");
        for (const [rank, holding] of filing.holdings.entries()) {
          const ids = identity.get(holding.isin ?? holding.cusip ?? "") ?? [];
          const securityId = ids.length === 1 ? ids[0] : null;
          await tx.$executeRawUnsafe(
            `INSERT INTO holdings (id,asset_type,fund_id,share_class_id,as_of_date,rank,holding_name,holding_code,weight,security_id,isin,cusip,ticker,amount,shares,market_value,currency,source,source_record_id,filing_id,weight_method,created_at)
             VALUES ($1,'FUND',$2,$3,$4::date,$5,$6,$7,$8::numeric,$9,$10,$11,$12,$13::numeric,$14::numeric,$15::numeric,$16,$17,$18,$19,'SOURCE_REPORTED',CURRENT_TIMESTAMP)
             ON CONFLICT (fund_id,source,filing_id,source_record_id) WHERE fund_id IS NOT NULL AND source IS NOT NULL AND filing_id IS NOT NULL AND source_record_id IS NOT NULL
             DO UPDATE SET share_class_id=EXCLUDED.share_class_id,as_of_date=EXCLUDED.as_of_date,rank=EXCLUDED.rank,holding_name=EXCLUDED.holding_name,holding_code=EXCLUDED.holding_code,weight=EXCLUDED.weight,security_id=EXCLUDED.security_id,isin=EXCLUDED.isin,cusip=EXCLUDED.cusip,ticker=EXCLUDED.ticker,amount=EXCLUDED.amount,shares=EXCLUDED.shares,market_value=EXCLUDED.market_value,currency=EXCLUDED.currency,weight_method=EXCLUDED.weight_method`,
            randomUUID(), fund.fundId, fund.shareClassId, filing.reportDate, rank + 1, holding.name, holding.isin ?? holding.cusip ?? holding.ticker, holding.weight, securityId, holding.isin, holding.cusip, holding.ticker, holding.balance, holding.shares, holding.marketValue, holding.currency, source, holding.sourceRecordId, filing.filingId,
          );
        }
      }, { maxWait: 10_000, timeout: 120_000 });
      completed.push({ ...fund, filingId: filing.filingId, reportDate: filing.reportDate, holdings: filing.holdings.length, action: "UPSERT_LATEST" });
    } catch (error) {
      failed.push({ fundId: fund.fundId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const now = new Date();
  const nextEligibleAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const queueItems = registry.funds.map((fund) => {
    const result = completed.find((item) => item.fundId === fund.fundId);
    const failure = failed.find((item) => item.fundId === fund.fundId);
    return { fundId: fund.fundId, shareClassId: fund.shareClassId, source, sourceIdentity: fund.classId, lastReportDate: result?.reportDate ?? null, filingId: result?.filingId ?? null, nextEligibleAt, status: failure ? "FAILED_ISOLATED" : result?.action === "SKIP_CURRENT" ? "WAITING_FOR_NEXT_DISCLOSURE" : "CURRENT" };
  });
  await atomicJson("queue.json", { version: 1, updatedAt: now.toISOString(), active: true, boundedConcurrency: 1, maxRetry: 3, items: queueItems });
  const last = completed.at(-1);
  await atomicJson("checkpoint.json", { version: 1, source, fundId: last?.fundId ?? null, shareClassId: last?.shareClassId ?? null, filingId: last?.filingId ?? null, reportDate: last?.reportDate ?? null, lastProcessedHolding: last?.holdings ?? null, lastSuccessfulRun: completed.length ? now.toISOString() : null, nextEligibleAt, status: failed.length ? "PARTIAL_CURRENT" : completed.every((item) => item.action === "SKIP_CURRENT") ? "HEALTHY_WAITING" : "CURRENT" });
  await atomicJson("health.json", { owner: "fund-holdings-supervisor", runnerPid: process.pid, lastHeartbeat: now.toISOString(), latestPath: true, incremental: true, scheduler: process.env.FUND_HOLDINGS_SCHEDULER === "1", autoContinuing: process.env.FUND_HOLDINGS_SCHEDULER === "1", singleWriter: true, queueActive: true, completed: completed.length, failed: failed.length, status: failed.length ? "PARTIAL_CURRENT" : completed.every((item) => item.action === "SKIP_CURRENT") ? "HEALTHY_WAITING" : "CURRENT" });
  await atomicSharedSecJson("checkpoint.json", { version: 1, layer: "SEC_INVESTMENT_COMPANY_SHARED", source, form: "NPORT-P", owner: "GLOBAL_FUND_SUPERVISOR_HOLDINGS_DOMAIN", ownerPid: Number(process.env.SMARTFUND_SUPERVISOR_PID ?? process.pid), registryCursor: last?.fundId ?? null, filingId: last?.filingId ?? null, reportDate: last?.reportDate ?? null, observationsReadBack: completed.reduce((sum, item) => sum + Number(item.holdings ?? 0), 0), failed: failed.length, lastSuccessfulRun: completed.length ? now.toISOString() : null, nextEligibleAt, status: failed.length ? "PARTIAL_CURRENT" : "AUTO_CONTINUING" });
  await atomicSharedSecJson("completion-manifest.json", { asset: "SEC_INVESTMENT_COMPANY_SHARED", source, canonicalObservationRelation: "holdings", consumers: ["ETF", "FUND"], duplicateConsumerStorage: false, forms: { "NPORT-P": "ACTIVE", "N-CEN": "ELIGIBLE_PATH_PENDING" }, completedShareClasses: completed.length, registryShareClasses: registry.funds.length, failed: failed.length, boundedConcurrency: 1, dbPoolMode: "SUPABASE_TRANSACTION_POOLING_6543_PGBOUNCER", scheduler: process.env.FUND_HOLDINGS_SCHEDULER === "1" ? "ACTIVE" : "CANARY", autoContinuing: process.env.FUND_HOLDINGS_SCHEDULER === "1", updatedAt: now.toISOString() });
  const addedRows = completed.filter((item) => item.action === "UPSERT_LATEST").reduce((sum, item) => sum + Number(item.holdings ?? 0), 0);
  await writeAssetRuntimeStatus("FUND", {
    CURRENT_PHASE: "CONTINUOUS_DEPTH_BACKFILL", CURRENT_LAYER: "P1", CURRENT_TASK: "Holdings",
    CURRENT_SOURCE: source, PROCESSED: completed.length, TOTAL: registry.funds.length,
    COVERAGE: registry.funds.length ? Number((completed.length / registry.funds.length * 100).toFixed(2)) : 0,
    RUN_STATE: failed.length ? "BLOCKED" : "SCHEDULED_WAIT", PROCESS_ID: process.pid, HEARTBEAT_AT: now.toISOString(),
    LAST_PROGRESS_AT: completed.length ? now.toISOString() : null,
    LAST_PROGRESS: `Holdings batch completed: ${completed.length}/${registry.funds.length} share classes; +${addedRows} holdings rows; ${completed.filter((item) => item.action === "SKIP_CURRENT").length} unchanged`,
    CHECKPOINT: "runtime/global-fund/holdings/checkpoint.json", BLOCKER: failed.length ? `${failed.length} isolated failures` : null,
    NEXT: "PIT Holdings", NEXT_RUN_AT: nextEligibleAt, HOLDINGS_STATUS: failed.length ? "PARTIAL_CURRENT" : "CURRENT_AND_AUTO_UPDATING", CONTINUING: "YES",
  });
  await prisma.$disconnect();
  const resolverExit = await new Promise<number>((complete) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--env-file=.env", "scripts/data/global-fund/run-fund-nport-regulatory-recovery.ts"], { cwd: process.cwd(), windowsHide: true, stdio: "ignore" });
    child.on("error", () => complete(1)); child.on("exit", code => complete(code ?? 1));
  });
  console.log(JSON.stringify({ completed, failed }));
  if (failed.length || resolverExit !== 0) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
