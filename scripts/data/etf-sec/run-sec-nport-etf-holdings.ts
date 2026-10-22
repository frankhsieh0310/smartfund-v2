import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { load } from "cheerio";
import { PrismaClient } from "@prisma/client";

const engine = resolve("runtime/prisma-engines/query_engine-windows-5.22.0.node");
if (process.platform === "win32" && !process.env.PRISMA_QUERY_ENGINE_LIBRARY) process.env.PRISMA_QUERY_ENGINE_LIBRARY = engine;
const db = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const limit = Number(process.argv.find((value) => value.startsWith("--limit="))?.slice(8) ?? "100");
const mappingOnly = process.argv.includes("--mapping-only");
const source = "SEC_EDGAR_NPORT";
const userAgent = "SmartFund ETF holdings data admin@smartfund.local";
const archive = resolve("runtime/etf-sec-nport/archive");

type RegistryRow = { cik: number; seriesId: string; classId: string; symbol: string };
type Target = { etfId: string; code: string; cik: number; seriesId: string; classId: string };
type Holding = { name: string; ticker: string | null; isin: string | null; cusip: string | null; quantity: number | null; marketValue: number | null; weight: number; currency: string | null; raw: Record<string, unknown> };

async function atomic(path: string, value: string) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, value);
  await rename(temporary, path);
}
async function get(url: string) {
  const response = await fetch(url, { headers: { "user-agent": userAgent, accept: "application/json, application/xml, text/xml" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`SEC_HTTP_${response.status}`);
  return response;
}
async function targets(): Promise<{ available: number; selected: Target[] }> {
  const registry = await (await get("https://www.sec.gov/files/company_tickers_mf.json")).json() as { fields: string[]; data: Array<[number, string, string, string]> };
  const bySymbol = new Map<string, RegistryRow[]>();
  for (const row of registry.data) {
    const item = { cik: row[0], seriesId: row[1], classId: row[2], symbol: String(row[3]).toUpperCase() };
    bySymbol.set(item.symbol, [...(bySymbol.get(item.symbol) ?? []), item]);
  }
  const remaining = await db.$queryRawUnsafe<Array<{ id: string; code: string }>>(`
    SELECT e.id,e.code FROM etfs e
    WHERE e.is_active=true
      AND NOT EXISTS (SELECT 1 FROM etf_holding_snapshots s WHERE s.etf_id=e.id AND s.canonical_row_count>0)
      AND NOT EXISTS (SELECT 1 FROM holdings h WHERE h.etf_id=e.id)
    ORDER BY e.id
  `);
  const mapped: Target[] = [];
  for (const etf of remaining) {
    const hits = bySymbol.get(etf.code.toUpperCase()) ?? [];
    const unique = [...new Map(hits.map((hit) => [`${hit.cik}|${hit.seriesId}|${hit.classId}`, hit])).values()];
    if (unique.length === 1) mapped.push({ etfId: etf.id, code: etf.code, ...unique[0] });
  }
  return { available: mapped.length, selected: mapped.slice(0, limit) };
}
async function latestFiling(target: Target) {
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(target.seriesId)}&forms=NPORT-P&from=0&size=20`;
  const json = await (await get(url)).json() as any;
  const hits = (json?.hits?.hits ?? []).map((hit: any) => ({ accession: hit?._source?.adsh ?? String(hit?._id ?? "").split(":")[0], cik: String(hit?._source?.ciks?.[0] ?? target.cik), period: hit?._source?.period_ending ?? null, filed: hit?._source?.file_date ?? null })).filter((hit: any) => hit.accession && hit.cik);
  hits.sort((a: any, b: any) => String(b.period ?? b.filed).localeCompare(String(a.period ?? a.filed)));
  for (const hit of hits) {
    const compact = hit.accession.replaceAll("-", "");
    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${Number(hit.cik)}/${compact}/primary_doc.xml`;
    try {
      const xml = await (await get(xmlUrl)).text();
      const $ = load(xml, { xmlMode: true });
      if ($("seriesId").first().text().trim() !== target.seriesId) continue;
      const reportDate = $("repPdDate").first().text().trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) throw new Error("REPORT_DATE_MISSING");
      const holdings: Holding[] = [];
      $("invstOrSec").each((_, element) => {
        const node = $(element), name = node.find("name").first().text().trim(), weight = Number(node.find("pctVal").first().text().trim());
        if (!name || !Number.isFinite(weight)) return;
        const balance = Number(node.find("balance").first().text().trim()), marketValue = Number(node.find("valUSD").first().text().trim());
        holdings.push({ name, ticker: node.find("identifiers ticker").first().attr("value")?.trim() || null, isin: node.find("identifiers isin").first().attr("value")?.trim() || null, cusip: node.find("cusip").first().text().trim() || null, quantity: Number.isFinite(balance) ? balance : null, marketValue: Number.isFinite(marketValue) ? marketValue : null, weight, currency: node.find("curCd").first().text().trim() || null, raw: { assetCategory: node.find("assetCat").first().text().trim() || null, issuerCategory: node.find("issuerCat").first().text().trim() || null, units: node.find("units").first().text().trim() || null } });
      });
      if (!holdings.length) throw new Error("HOLDINGS_EMPTY");
      return { ...hit, xmlUrl, xml, reportDate, holdings };
    } catch (error) {
      if (error instanceof Error && /SEC_HTTP_(429|5\d\d)/.test(error.message)) throw error;
    }
  }
  throw new Error("SERIES_FILING_NOT_FOUND");
}
async function write(target: Target, filing: Awaited<ReturnType<typeof latestFiling>>) {
  const checksum = createHash("sha256").update(filing.xml).digest("hex"), snapshotId = randomUUID();
  const coverage = filing.holdings.reduce((sum, row) => sum + row.weight, 0), complete = coverage >= 95 && coverage <= 105;
  await atomic(resolve(archive, `${filing.accession}.xml`), filing.xml);
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`INSERT INTO etf_holding_snapshots(id,etf_id,effective_date,report_date,publication_date,source,source_type,source_url,source_record_id,retrieved_at,checksum,source_row_count,parsed_row_count,canonical_row_count,verification_status,license_status,completeness_status,quality_status,quality_metrics,parser_version,archive_lineage) VALUES($1::uuid,$2,$3::date,$3::date,$4::date,$5,'REGULATORY_FILING',$6,$7,NOW(),$8,$9,$9,$9,'SOURCE_VERIFIED','PUBLIC_REGULATORY_DISCLOSURE',$10,$10,$11::jsonb,'sec-nport-etf-v1',$12::jsonb) ON CONFLICT(etf_id,effective_date,source_url,checksum) DO NOTHING`, snapshotId, target.etfId, filing.reportDate, filing.filed, source, filing.xmlUrl, filing.accession, checksum, filing.holdings.length, complete ? "COMPLETE" : "PARTIAL", JSON.stringify({ weightCoverage: coverage, cik: target.cik, seriesId: target.seriesId, classId: target.classId }), JSON.stringify({ accession: filing.accession, source: "SEC_EDGAR" }));
    const found = await tx.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id::text FROM etf_holding_snapshots WHERE etf_id=$1 AND effective_date=$2::date AND source_url=$3 AND checksum=$4`, target.etfId, filing.reportDate, filing.xmlUrl, checksum);
    const id = found[0]?.id ?? snapshotId;
    const payload = filing.holdings.map((row, index) => ({ id: randomUUID(), snapshotId: id, etfId: target.etfId, effectiveDate: filing.reportDate, holdingName: row.name, ticker: row.ticker, isin: row.isin, cusip: row.cusip, quantity: row.quantity, marketValue: row.marketValue, weight: row.weight, currency: row.currency, sourceRowId: `${index + 1}|${row.isin ?? row.cusip ?? row.ticker ?? row.name}`.slice(0, 240), qualityStatus: complete ? "COMPLETE" : "PARTIAL", rawRow: row.raw }));
    await tx.$executeRawUnsafe(`INSERT INTO etf_holdings(id,snapshot_id,etf_id,effective_date,holding_type,holding_name,ticker,isin,cusip,quantity,market_value,weight,currency,source_row_id,verification_status,quality_status,raw_row) SELECT x.id::uuid,x."snapshotId"::uuid,x."etfId",x."effectiveDate"::date,'SECURITY',x."holdingName",x.ticker,x.isin,x.cusip,x.quantity,x."marketValue",x.weight,x.currency,x."sourceRowId",'SOURCE_VERIFIED',x."qualityStatus",x."rawRow" FROM jsonb_to_recordset($1::jsonb) x(id text,"snapshotId" text,"etfId" text,"effectiveDate" text,"holdingName" text,ticker text,isin text,cusip text,quantity numeric,"marketValue" numeric,weight numeric,currency text,"sourceRowId" text,"qualityStatus" text,"rawRow" jsonb) ON CONFLICT(snapshot_id,source_row_id) DO NOTHING`, JSON.stringify(payload));
  }, { maxWait: 10_000, timeout: 120_000 });
  return complete ? "COMPLETE" : "PARTIAL";
}
async function main() {
  const { available, selected } = await targets();
  if (mappingOnly) { console.log(JSON.stringify({ target: limit, mappingAvailable: available, mapped: selected.length, attempted: 0, written: 0, partial: 0, failed: 0 })); return; }
  let attempted = 0, written = 0, partial = 0, failed = 0;
  for (let index = 0; index < selected.length; index += 4) await Promise.all(selected.slice(index, index + 4).map(async (target) => {
    attempted++;
    try { const filing = await latestFiling(target); const status = await write(target, filing); written++; if (status === "PARTIAL") partial++; }
    catch { failed++; }
  }));
  console.log(JSON.stringify({ target: limit, mappingAvailable: available, mapped: selected.length, attempted, written, partial, failed }));
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());
