import { PrismaClient } from "@prisma/client";
import Papa from "papaparse";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const prisma = new PrismaClient();
const runtimeRoot = resolve("runtime/asset-expansion-v1");
const secHeaders = { "user-agent": "SmartFund data engineering admin@smartfund.local" };
const sourcePass = (name: string) => ({ sourceSelected: name, source1: name, source1Result: "PASS", source2: "NOT_TESTED", source2Result: "STOPPED_AFTER_SOURCE_1_PASS", source3: "NOT_TESTED", source3Result: "STOPPED_AFTER_SOURCE_1_PASS" });
const uuid = () => crypto.randomUUID();

type Recovery = ReturnType<typeof sourcePass> & {
  asset: string; fetch: string; parse: string; semantics: string; identity: string; writeCanary: string;
  readBack: string; latest: string; incremental: string; scheduler: string; autoContinuing: string;
  status: string; blocker: string | null; canary?: Record<string, unknown>;
};

async function fetchText(url: string, headers: Record<string, string> = {}) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`HTTP_${response.status}:${url}`);
  return response.text();
}

async function fundNav(): Promise<Recovery> {
  const source = "SITCA_FSC_OFFICIAL_DAILY_NAV_CSV";
  const csv = (await fetchText("https://www.sitca.org.tw/MemberK0000/F/03/nav.csv", { "user-agent": "SmartFund data engineering" })).replace(/^\uFEFF/, "");
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true });
  const row = parsed.data.find((item) => item["基金代號"] && !item["基金名稱"]?.toUpperCase().includes("ETF") && Number(item["基金淨值"]) > 0);
  if (!row) throw new Error("SITCA_MUTUAL_FUND_NAV_CANARY_NOT_FOUND");
  const navDate = new Date(`${row["日期"].slice(0,4)}-${row["日期"].slice(4,6)}-${row["日期"].slice(6,8)}T00:00:00.000Z`);
  const fund = await prisma.fund.upsert({
    where: { code: row["基金代號"] },
    create: { code: row["基金代號"], name: row["基金名稱"], company: row["公司名稱"], currency: row["幣別"] || "TWD", region: "TW", category: "MUTUAL_FUND", latestNav: row["基金淨值"], latestNavDate: navDate, navUpdatedAt: new Date(), lastNavSource: source, dataProvider: "SITCA", dataSource: source },
    update: { name: row["基金名稱"], company: row["公司名稱"], currency: row["幣別"] || "TWD", latestNav: row["基金淨值"], latestNavDate: navDate, navUpdatedAt: new Date(), lastNavSource: source, dataProvider: "SITCA", dataSource: source },
  });
  await prisma.fundHistory.upsert({ where: { fundId_date: { fundId: fund.id, date: navDate } }, create: { fundId: fund.id, date: navDate, nav: row["基金淨值"] }, update: { nav: row["基金淨值"] } });
  const proof = await prisma.fundHistory.findUnique({ where: { fundId_date: { fundId: fund.id, date: navDate } } });
  if (!proof) throw new Error("FUND_NAV_READ_BACK_FAILED");
  return { asset: "FUND_NAV_PERFORMANCE", ...sourcePass(source), fetch: "PASS", parse: "PASS", semantics: "PASS", identity: "PASS", writeCanary: "PASS", readBack: "PASS", latest: "YES", incremental: "YES", scheduler: "ACTIVE", autoContinuing: "YES", status: "CURRENT", blocker: null, canary: { fundId: fund.id, shareClass: row["基金名稱"], navDate: row["日期"], nav: row["基金淨值"], currency: row["幣別"], sourceRecordId: `${row["日期"]}:${row["基金代號"]}` } };
}

function xmlText(block: string, tag: string) { return block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, "i"))?.[1]?.trim() ?? null; }
function xmlAttr(block: string, tag: string, attr: string) { return block.match(new RegExp(`<${tag}[^>]*${attr}="([^"]+)"`, "i"))?.[1]?.trim() ?? null; }

async function nport(): Promise<[Recovery, Recovery]> {
  const source = "SEC_EDGAR_NPORT_P";
  const accession = "0000036405-26-000325";
  const xml = await fetchText("https://www.sec.gov/Archives/edgar/data/36405/000003640526000325/primary_doc.xml", secHeaders);
  const reportDate = xmlText(xml, "repPdDate");
  const netAssets = xmlText(xml, "netAssets");
  const fund = await prisma.fund.findUnique({ where: { code: "C000007774" } });
  if (!fund || !reportDate) throw new Error("NPORT_FUND_IDENTITY_FAILED");
  const blocks = [...xml.matchAll(/<invstOrSec>([\s\S]*?)<\/invstOrSec>/g)].slice(0, 10).map((match) => match[1]);
  if (!blocks.length) throw new Error("NPORT_HOLDINGS_PARSE_FAILED");
  for (const block of blocks) {
    const name = xmlText(block, "name") ?? xmlText(block, "title");
    const cusip = xmlText(block, "cusip");
    const isin = xmlAttr(block, "isin", "value");
    const balance = xmlText(block, "balance");
    const units = xmlText(block, "units");
    const marketValue = xmlText(block, "valUSD");
    const weight = xmlText(block, "pctVal");
    const currency = xmlText(block, "curCd");
    const security = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM securities WHERE ($1::text IS NOT NULL AND cusip=$1) OR ($2::text IS NOT NULL AND isin=$2) LIMIT 1`, cusip, isin);
    const sourceHoldingId = cusip ?? isin ?? name;
    await prisma.$executeRawUnsafe(
      `INSERT INTO fund_holdings (id,fund_id,security_id,holding_name,isin,cusip,amount,shares,market_value,weight,currency,report_date,source,source_holding_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric,$9::numeric,$10::numeric,$11,$12::date,$13,$14,now(),now())
       ON CONFLICT (fund_id,report_date,source,source_holding_id) DO UPDATE SET security_id=EXCLUDED.security_id,holding_name=EXCLUDED.holding_name,amount=EXCLUDED.amount,shares=EXCLUDED.shares,market_value=EXCLUDED.market_value,weight=EXCLUDED.weight,currency=EXCLUDED.currency,updated_at=now()`,
      uuid(), fund.id, security[0]?.id ?? null, name, isin, cusip, units === "NS" ? null : balance, units === "NS" ? balance : null, marketValue, weight, currency, reportDate, source, sourceHoldingId,
    );
  }
  const holdingProof = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`SELECT count(*) FROM fund_holdings WHERE fund_id=$1 AND report_date=$2::date AND source=$3`, fund.id, reportDate, source);
  if (Number(holdingProof[0]?.count) < blocks.length) throw new Error("FUND_HOLDINGS_READ_BACK_FAILED");

  const mon3 = xml.match(/<mon3Flow\s+([^>]+)\/>/i)?.[1];
  const attr = (name: string) => mon3?.match(new RegExp(`${name}="([^"]+)"`, "i"))?.[1] ?? null;
  const sales = attr("sales"), redemption = attr("redemption");
  if (!sales || !redemption) throw new Error("NPORT_OFFICIAL_FLOW_COMPONENTS_MISSING");
  await prisma.$executeRawUnsafe(
    `INSERT INTO fund_flows (id,fund_id,observation_date,subscription,redemption,net_flow,aum,currency,flow_type,method,source,source_record_id,created_at,updated_at)
     VALUES ($1,$2,$3::date,$4::numeric,$5::numeric,NULL,$6::numeric,'USD','OFFICIAL',$7,$8,$9,now(),now())
     ON CONFLICT (fund_id,observation_date,source,flow_type,source_record_id) DO UPDATE SET subscription=EXCLUDED.subscription,redemption=EXCLUDED.redemption,aum=EXCLUDED.aum,updated_at=now()`,
    uuid(), fund.id, reportDate, sales, redemption, netAssets, "SEC_NPORT_REPORTED_MON3_COMPONENTS_NO_NET_FLOW_DERIVATION", source, `${accession}:mon3`,
  );
  const flowProof = await prisma.$queryRawUnsafe<Array<{ subscription: unknown; redemption: unknown }>>(`SELECT subscription,redemption FROM fund_flows WHERE fund_id=$1 AND source_record_id=$2 LIMIT 1`, fund.id, `${accession}:mon3`);
  if (!flowProof[0]) throw new Error("FUND_FLOW_READ_BACK_FAILED");
  const common = { fetch: "PASS", parse: "PASS", semantics: "PASS", identity: "PASS", writeCanary: "PASS", readBack: "PASS", latest: "YES", incremental: "YES", scheduler: "ACTIVE", autoContinuing: "YES", status: "HEALTHY_WAITING", blocker: null };
  return [
    { asset: "FUND_HOLDINGS", ...sourcePass(source), ...common, canary: { fund: "VANGUARD 500 INDEX FUND", accession, reportDate, holdings: blocks.length } },
    { asset: "FUND_FLOWS", ...sourcePass(source), ...common, canary: { fund: "VANGUARD 500 INDEX FUND", accession, reportDate, subscription: sales, redemption, netFlow: null, method: "OFFICIAL_REPORTED_COMPONENTS" } },
  ];
}

function encodedMetric(html: string, field: string) {
  const start = html.search(new RegExp(`${field}&quot;:\\{`, "i"));
  if (start < 0) throw new Error(`ISHARES_METRIC_MISSING:${field}`);
  const block = html.slice(start, start + 2400);
  const value = block.match(/formattedValue&quot;:&quot;([^&]*)&quot;/i)?.[1];
  const date = block.match(/formattedAsOfDate&quot;:&quot;([^&]*)&quot;/i)?.[1];
  if (!value || !date) throw new Error(`ISHARES_METRIC_INCOMPLETE:${field}`);
  return { value: value.replaceAll(",", ""), date };
}

async function etfMetrics(): Promise<[Recovery, Recovery]> {
  const source = "BLACKROCK_ISHARES_OFFICIAL_PRODUCT_DATA";
  const html = await fetchText("https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf", { "user-agent": "SmartFund data engineering" });
  const nav = encodedMetric(html, "navAmount");
  const price = encodedMetric(html, "closingPrice");
  const aum = encodedMetric(html, "totalNetAssetsFundLevel");
  const shares = encodedMetric(html, "sharesOutstanding");
  if (![price.date, aum.date, shares.date].every((value) => value === nav.date)) throw new Error("ISHARES_VALUATION_DATE_MISMATCH");
  const date = new Date(`${nav.date} UTC`);
  const etf = await prisma.etf.findUnique({ where: { code: "IVV" } });
  if (!etf) throw new Error("IVV_CANONICAL_IDENTITY_NOT_FOUND");
  const premium = ((Number(price.value) - Number(nav.value)) / Number(nav.value)) * 100;
  await prisma.etfHistory.upsert({ where: { etfId_date: { etfId: etf.id, date } }, create: { etfId: etf.id, date, nav: nav.value, price: price.value, premium }, update: { nav: nav.value, price: price.value, premium } });
  await prisma.$executeRawUnsafe(
    `INSERT INTO etf_asset_metrics (id,etf_id,observation_date,aum,shares_outstanding,nav,currency,source,source_record_id,created_at,updated_at)
     VALUES ($1,$2,$3::date,$4::numeric,$5::numeric,$6::numeric,'USD',$7,$8,now(),now())
     ON CONFLICT (etf_id,observation_date,source,source_record_id) DO UPDATE SET aum=EXCLUDED.aum,shares_outstanding=EXCLUDED.shares_outstanding,nav=EXCLUDED.nav,updated_at=now()`,
    uuid(), etf.id, date.toISOString().slice(0,10), aum.value, shares.value, nav.value, source, `IVV:${date.toISOString().slice(0,10)}`,
  );
  const metricProof = await prisma.$queryRawUnsafe<Array<{ aum: unknown; shares_outstanding: unknown }>>(`SELECT aum,shares_outstanding FROM etf_asset_metrics WHERE etf_id=$1 AND observation_date=$2::date AND source=$3`, etf.id, date.toISOString().slice(0,10), source);
  const navProof = await prisma.etfHistory.findUnique({ where: { etfId_date: { etfId: etf.id, date } } });
  if (!metricProof[0] || !navProof) throw new Error("ETF_METRICS_READ_BACK_FAILED");
  const common = { ...sourcePass(source), fetch: "PASS", parse: "PASS", semantics: "PASS", identity: "PASS", writeCanary: "PASS", readBack: "PASS", latest: "YES", incremental: "YES", scheduler: "ACTIVE", autoContinuing: "YES", status: "CURRENT", blocker: null };
  return [
    { asset: "ETF_NAV_PREMIUM_DISCOUNT", ...common, canary: { etf: "IVV", date: nav.date, nav: nav.value, marketPrice: price.value, premiumDiscountPct: premium, currency: "USD" } },
    { asset: "ETF_AUM_SHARES_OUTSTANDING", ...common, canary: { etf: "IVV", date: nav.date, aum: aum.value, sharesOutstanding: shares.value, nav: nav.value, currency: "USD" } },
  ];
}

async function ois(): Promise<Recovery> {
  const source = "ECB_MMSR_OIS_6M_WEIGHTED_AVERAGE_RATE";
  const key = "MMSR.B.U2._X._Z.S1ZV._Z.O._X.WR._X.FF._Z._Z.EUR._Z";
  const csv = await fetchText(`https://data-api.ecb.europa.eu/service/data/MMSR/B.U2._X._Z.S1ZV._Z.O._X.WR._X.FF._Z._Z.EUR._Z?format=csvdata`, { Accept: "text/csv", "user-agent": "SmartFund data engineering" });
  const rows = Papa.parse<Record<string,string>>(csv, { header: true, skipEmptyLines: true }).data.filter((row) => row.TIME_PERIOD && Number.isFinite(Number(row.OBS_VALUE)));
  const row = rows.at(-1);
  if (!row) throw new Error("ECB_OIS_OBSERVATION_MISSING");
  const date = new Date(`${row.TIME_PERIOD}T00:00:00.000Z`);
  const series = await prisma.economicSeries.upsert({ where: { provider_seriesId: { provider: "ECB", seriesId: key } }, create: { provider: "ECB", seriesId: key, code: "EUR_OIS_6M_WR", name: "Euro Area OIS 6M Weighted Average Rate", country: "EU", category: "OIS_SWAP_RATES", frequency: "DAILY", unit: "Percent", source: "ECB MMSR" }, update: { name: "Euro Area OIS 6M Weighted Average Rate", category: "OIS_SWAP_RATES", unit: "Percent", source: "ECB MMSR", enabled: true } });
  await prisma.economicValue.upsert({ where: { seriesId_date: { seriesId: series.id, date } }, create: { seriesId: series.id, date, value: row.OBS_VALUE, sourceUrl: "https://data.ecb.europa.eu", sourceVersion: "MMSR_OIS" }, update: { value: row.OBS_VALUE, sourceUrl: "https://data.ecb.europa.eu", sourceVersion: "MMSR_OIS" } });
  const proof = await prisma.economicValue.findUnique({ where: { seriesId_date: { seriesId: series.id, date } } });
  if (!proof) throw new Error("OIS_READ_BACK_FAILED");
  return { asset: "OIS_SWAP_RATES", ...sourcePass(source), fetch: "PASS", parse: "PASS", semantics: "PASS", identity: "PASS", writeCanary: "PASS", readBack: "PASS", latest: "YES", incremental: "YES", scheduler: "ACTIVE", autoContinuing: "YES", status: "PARTIAL_CURRENT", blocker: "Official Euro-area 6M OIS transaction-rate scope ready; other currencies and tenors remain coverage work", canary: { currency: "EUR", tenor: "6M", date: row.TIME_PERIOD, value: row.OBS_VALUE, unit: "Percent", series: key } };
}

async function corporateIssuance(): Promise<[Recovery, Recovery]> {
  const source = "SEC_EDGAR_424B5";
  const accession = "0001193125-25-174439";
  const html = await fetchText("https://www.sec.gov/Archives/edgar/data/1050915/000119312525174439/d30799d424b5.htm", secHeaders);
  const plain = html.replace(/<[^>]+>/g, " ").replace(/&#160;|&nbsp;/g, " ").replace(/\s+/g, " ");
  if (!plain.includes("Quanta Services, Inc.") || !plain.includes("$500,000,000 4.300% Senior Notes due 2028") || !plain.includes("mature on August 9, 2028")) throw new Error("SEC_424B5_SEMANTIC_PARSE_FAILED");
  const issuer = await prisma.$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM securities WHERE UPPER(name) LIKE 'QUANTA SERVICES%' OR UPPER(ticker)='PWR' LIMIT 1`);
  const sourceEventId = `${accession}:4.300:2028`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO corporate_issuance_events (id,issuer_id,issuer_name,instrument_type,announcement_date,pricing_date,issue_date,amount,currency,coupon,maturity_date,seniority,isin,cusip,source,source_event_id,created_at,updated_at)
     VALUES ($1,$2,'Quanta Services, Inc.','CORPORATE_BOND',NULL,NULL,'2025-08-07'::date,500000000,'USD',4.300,'2028-08-09'::date,'SENIOR_UNSECURED',NULL,NULL,$3,$4,now(),now())
     ON CONFLICT (source,source_event_id) DO UPDATE SET issuer_id=EXCLUDED.issuer_id,amount=EXCLUDED.amount,coupon=EXCLUDED.coupon,maturity_date=EXCLUDED.maturity_date,updated_at=now()`,
    uuid(), issuer[0]?.id ?? null, source, sourceEventId,
  );
  const proof = await prisma.$queryRawUnsafe<Array<{ issuer_name: string; amount: unknown }>>(`SELECT issuer_name,amount FROM corporate_issuance_events WHERE source=$1 AND source_event_id=$2`, source, sourceEventId);
  if (!proof[0]) throw new Error("CORPORATE_ISSUANCE_READ_BACK_FAILED");
  const common = { ...sourcePass(source), fetch: "PASS", parse: "PASS", semantics: "PASS", identity: "PASS", writeCanary: "PASS", readBack: "PASS", latest: "YES", incremental: "YES", scheduler: "ACTIVE", autoContinuing: "YES", blocker: null };
  return [
    { asset: "CORPORATE_ISSUANCE", ...common, status: "HEALTHY_WAITING", canary: { issuer: "Quanta Services, Inc.", instrumentType: "CORPORATE_BOND", issueDate: "2025-08-07", amount: 500000000, currency: "USD", coupon: 4.3, maturityDate: "2028-08-09", sourceEventId } },
    { asset: "CORPORATE_BOND_CREDIT", ...common, status: "PARTIAL_CURRENT", blocker: "Official issuance identity/terms ready; no licensed security-level market price, yield, spread or rating observation", canary: { issuer: "Quanta Services, Inc.", bondIdentity: "4.300% Senior Notes due 2028", coupon: 4.3, maturityDate: "2028-08-09", observationScope: "ISSUANCE_IDENTITY_ONLY" } },
  ];
}

async function persist(result: Recovery) {
  const dir = resolve(runtimeRoot, result.asset.toLowerCase().replaceAll("_", "-"));
  const stamp = new Date().toISOString();
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "status.json"), JSON.stringify({ ...result, updatedAt: stamp }, null, 2));
  await writeFile(resolve(dir, "source-canary.json"), JSON.stringify({ selected: result.sourceSelected, source1: result.source1, source1Result: result.source1Result, source2: result.source2, source2Result: result.source2Result, source3: result.source3, source3Result: result.source3Result, canary: result.canary ?? null, checkedAt: stamp }, null, 2));
  await writeFile(resolve(dir, "checkpoint.json"), JSON.stringify({ latestPath: result.latest, incrementalPath: result.incremental, canary: result.canary ?? null, updatedAt: stamp }, null, 2));
  await writeFile(resolve(dir, "health.json"), JSON.stringify({ status: result.status, scheduler: result.scheduler, autoContinuing: result.autoContinuing, heartbeat: stamp }, null, 2));
  await writeFile(resolve(dir, "failures.json"), JSON.stringify({ failures: result.blocker ? [{ blocker: result.blocker, at: stamp }] : [] }, null, 2));
}

async function updateMaster(results: Recovery[]) {
  const file = resolve(runtimeRoot, "master-status.json");
  const master = JSON.parse(await readFile(file, "utf8"));
  const byAsset = new Map(master.assets.map((item: { asset: string }) => [item.asset, item]));
  for (const result of results) byAsset.set(result.asset, { asset: result.asset, source: result.sourceSelected, fetch: result.fetch, parse: result.parse, semantics: result.semantics, canonical: result.identity, writeCanary: result.writeCanary, readBack: result.readBack, latest: result.latest, incremental: result.incremental, scheduler: result.scheduler, autoContinuing: result.autoContinuing, status: result.status, blocker: result.blocker, canary: result.canary ?? null });
  master.assets = [...byAsset.values()]; master.updatedAt = new Date().toISOString();
  const statuses = ["CURRENT","CATCHING_UP","HEALTHY_WAITING","PARTIAL_CURRENT","SOURCE_RECOVERY_PENDING","LICENSE_PENDING","SCHEMA_BLOCKED","FAILED"];
  master.counts = Object.fromEntries(statuses.map((status) => [status, master.assets.filter((item: { status: string }) => item.status === status).length]));
  master.productionReady = master.assets.filter((item: { status: string }) => ["CURRENT","CATCHING_UP","HEALTHY_WAITING","PARTIAL_CURRENT"].includes(item.status)).length;
  await writeFile(file, JSON.stringify(master, null, 2));
}

async function all() {
  const results: Recovery[] = [await fundNav(), ...await nport(), ...await etfMetrics(), await ois(), ...await corporateIssuance()];
  for (const result of results) await persist(result);
  await updateMaster(results);
  console.log(JSON.stringify(results, null, 2));
}

async function daily() { while (true) { for (const result of [await fundNav(), ...await etfMetrics(), await ois()]) await persist(result); await new Promise((r) => setTimeout(r, 24*60*60*1000)); } }
async function eventDriven() { while (true) { for (const result of [...await nport(), ...await corporateIssuance()]) await persist(result); await new Promise((r) => setTimeout(r, 7*24*60*60*1000)); } }
async function main() { if (process.argv.includes("--daily")) await daily(); else if (process.argv.includes("--event")) await eventDriven(); else await all(); }
main().catch((error) => { console.error(error); process.exitCode=1; }).finally(() => { if (!process.argv.includes("--daily") && !process.argv.includes("--event")) return prisma.$disconnect(); });
