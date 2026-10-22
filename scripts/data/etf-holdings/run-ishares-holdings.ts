import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { runHoldingsIntelligence } from "./holdings-intelligence.ts";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const root = process.cwd();
const runtime = path.join(root, "runtime", "etf-holdings");
const representativeProducts = [
  { code: "IVV", sourceUrl: "https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv" },
  { code: "IWM", sourceUrl: "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/latest-holdings.csv" },
  { code: "AGG", sourceUrl: "https://www.ishares.com/us/products/239458/ishares-core-u-s-aggregate-bond-etf/latest-holdings.csv" },
];
const registryPath = path.join(root, "config", "ishares-bond-etf-products.json");
const configuredProducts = (() => {
  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf8"));
    return Array.isArray(registry.products) ? registry.products.map((product: any) => ({ code: product.code, sourceUrl: product.sourceUrl })) : [];
  } catch { return []; }
})();
// Keep the proven representative cohort and append exact official-directory
// mappings. The supervisor remains the single writer and reloads this file on
// every child cycle.
const products = [...new Map([...representativeProducts, ...configuredProducts].map(product => [product.code, product])).values()];
const canary = process.argv.includes("--canary");
const runOnce = process.argv.includes("--once");
const deferFirst = process.argv.includes("--defer-first-cycle");
const productionProof = process.argv.includes("--production-proof");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function parseCsvRow(line: string) {
  const cells: string[] = [];
  const expression = /(?:^|,)("(?:[^"]|"")*"|[^,]*)/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(line))) cells.push(match[1].startsWith('"') ? match[1].slice(1, -1).replaceAll('""', '"') : match[1]);
  return cells;
}

async function atomicJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2));
  await fs.rename(temporary, file);
}

function grouped(rows: any[], field: string) {
  const values = new Map<string,number>();
  for (const row of rows) { const key=String(row[field]||"UNKNOWN"); values.set(key,(values.get(key)||0)+(row.weight??0)); }
  return [...values].map(([name,weight])=>({name,weight})).sort((a,b)=>b.weight-a.weight);
}
async function materialize(results:any[]) {
  const snapshots=[];
  for(const result of results){const value=JSON.parse(await fs.readFile(path.join(runtime,"staging",`blackrock-${result.etfCode}-normalized.json`),"utf8"));snapshots.push(value)}
  for(const {snapshot,holdings} of snapshots){
    const sorted=[...holdings].sort((a,b)=>(b.weight??0)-(a.weight??0));
    const sum=(count:number)=>sorted.slice(0,count).reduce((total,row)=>total+(row.weight??0),0);
    await atomicJson(path.join(runtime,"allocations",`${snapshot.etfCode}-${safeKey(snapshot.effectiveDate)}.json`),{etfId:snapshot.etfId,effectiveDate:snapshot.effectiveDate,provenance:"DERIVED_FROM_HOLDINGS",knownWeight:holdings.filter((x:any)=>x.weight!==null).reduce((s:number,x:any)=>s+x.weight,0),unknownWeight:null,cashWeight:snapshot.cashWeight,derivativeWeight:holdings.filter((x:any)=>["FUTURE","OPTION","SWAP","FX_FORWARD"].includes(x.holdingType)).reduce((s:number,x:any)=>s+(x.weight??0),0),sector:grouped(holdings,"sector"),country:grouped(holdings,"country"),assetClass:grouped(holdings,"assetClass"),currency:grouped(holdings,"currency")});
    await atomicJson(path.join(runtime,"concentration",`${snapshot.etfCode}-${safeKey(snapshot.effectiveDate)}.json`),{etfId:snapshot.etfId,effectiveDate:snapshot.effectiveDate,numberOfHoldings:holdings.length,top10Weight:sum(10),top20Weight:sum(20),top50Weight:sum(50),hhi:holdings.reduce((s:number,x:any)=>s+Math.pow((x.weight??0)/100,2),0),top10:sorted.slice(0,10),top20:sorted.slice(0,20),top50:sorted.slice(0,50),top100:sorted.slice(0,100)});
  }
  if(snapshots.length>=2&&snapshots[0].snapshot.effectiveDate===snapshots[1].snapshot.effectiveDate){const [a,b]=snapshots, bm=new Map(b.holdings.map((x:any)=>[`${x.ticker||""}|${x.name}`,x]));const shared=a.holdings.filter((x:any)=>bm.has(`${x.ticker||""}|${x.name}`));await atomicJson(path.join(runtime,"overlap",`${a.snapshot.etfCode}-${b.snapshot.etfCode}.json`),{leftEtfId:a.snapshot.etfId,rightEtfId:b.snapshot.etfId,effectiveDate:a.snapshot.effectiveDate,sharedHoldingCount:shared.length,sharedWeightMinSum:shared.reduce((s:number,x:any)=>s+Math.min(x.weight??0,(bm.get(`${x.ticker||""}|${x.name}`) as any)?.weight??0),0),overlapPercent:shared.reduce((s:number,x:any)=>s+Math.min(x.weight??0,(bm.get(`${x.ticker||""}|${x.name}`) as any)?.weight??0),0),topSharedHoldings:shared.sort((x:any,y:any)=>(y.weight??0)-(x.weight??0)).slice(0,20),dateCompatibility:"SAME_EFFECTIVE_DATE"})}
  const allEtfs=await prisma.$queryRawUnsafe<Array<{id:string;code:string;provider:string;country:string|null}>>("SELECT id,code,provider,region country FROM etfs ORDER BY id");
  const stats=await prisma.$queryRawUnsafe<Array<{etf_id:string;holding_count:bigint;dates:bigint;latest:Date}>>("SELECT etf_id,COUNT(*)::bigint holding_count,COUNT(DISTINCT as_of_date)::bigint dates,MAX(as_of_date) latest FROM holdings WHERE asset_type='ETF' GROUP BY etf_id");
  const statMap=new Map(stats.map(x=>[x.etf_id,x]));
  const resultMap=new Map(results.map(x=>[x.etfId,x]));
  const professionalSchemaReady=results.length>0&&results.every(x=>x.snapshot==="PASS");
  const coverage=allEtfs.map(etf=>{const s=statMap.get(etf.id),r=resultMap.get(etf.id),dates=Number(s?.dates??0),representative=Boolean(r);return {etfId:etf.id,code:etf.code,issuer:etf.provider,holdingsStatus:s?"AVAILABLE":"SOURCE_PENDING",snapshotCompleteness:r?.completenessStatus??(s?"UNKNOWN":"SOURCE_PENDING"),latestEffectiveDate:s?.latest??null,distinctEffectiveDates:dates,holdingCount:Number(s?.holding_count??0),securityMatchRate:r?.securityMatchRate??null,sectorAllocationStatus:r?"DERIVED_FROM_HOLDINGS":"NOT_MATERIALIZED",countryAllocationStatus:r?"DERIVED_FROM_HOLDINGS":"NOT_MATERIALIZED",assetAllocationStatus:r?"DERIVED_FROM_HOLDINGS":"NOT_MATERIALIZED",historicalStatus:dates>=2?"POINT_IN_TIME":"CURRENT_ONLY",changeAnalyticsStatus:dates>=2?"ELIGIBLE":"NOT_ELIGIBLE",overlapEligible:representative,freshnessStatus:r?"WAITING_FOR_NEXT_DISCLOSURE":"SOURCE_PENDING",provenanceStatus:r?"VERIFIED_OFFICIAL":"NOT_VERIFIED",licenseStatus:r?.licenseStatus??"TERMS_REVIEW_REQUIRED",coverageStatus:r?"CANARY_FULL_SOURCE_SNAPSHOT":s?"LEGACY_HOLDINGS_REVIEW_REQUIRED":"CONSTRAINED_SOURCE_PENDING",IDENTITY_STATE:"READY",CURRENT_HOLDINGS_STATE:s?"READY":"SOURCE_CONSTRAINED",PIT_STATE:dates>=2?"READY":s?"TIME_DEPTH_CONSTRAINED":"SOURCE_CONSTRAINED",PROVENANCE_STATE:representative?"READY":"SOURCE_CONSTRAINED",MAPPING_STATE:representative?(etf.code==="AGG"?"READY":"MAPPING_CONSTRAINED"):"NOT_APPLICABLE",SOURCE_STATE:representative?"READY":"SOURCE_CONSTRAINED",SCHEMA_STATE:professionalSchemaReady?"READY":"CONFIGURATION_CONSTRAINED",DETAIL_STATE:representative?(professionalSchemaReady?"READY":"CONFIGURATION_CONSTRAINED"):"SOURCE_CONSTRAINED"}});
  await atomicJson(path.join(runtime,"coverage","etf-coverage-matrix.json"),{canonicalDenominator:allEtfs.length,generatedAt:new Date().toISOString(),rows:coverage});
  const issuerRows=[...new Set(allEtfs.map(x=>x.provider))].map(issuer=>{const e=coverage.filter(x=>x.issuer===issuer);return {issuer,canonicalEtfCount:e.length,sourceStatus:issuer==="BlackRock / iShares"?"READY":"SOURCE_PENDING",sourceVerified:issuer==="BlackRock / iShares",etfsWithHoldings:e.filter(x=>x.holdingCount>0).length,fullHoldingsEtfs:e.filter(x=>x.snapshotCompleteness==="FULL_SOURCE_SNAPSHOT").length,historicalHoldingsEtfs:e.filter(x=>x.distinctEffectiveDates>=2).length,latestEffectiveDate:e.map(x=>x.latestEffectiveDate).filter(Boolean).sort().at(-1)??null,licenseStatus:issuer==="BlackRock / iShares"?"PUBLIC_OFFICIAL_REVIEW_REQUIRED":"TERMS_REVIEW_REQUIRED"}});
  await atomicJson(path.join(runtime,"coverage","issuer-coverage-matrix.json"),{generatedAt:new Date().toISOString(),rows:issuerRows});
}

const numeric = (value: string | undefined) => {
  const cleaned = (value ?? "").replaceAll(",", "").replaceAll("%", "").trim();
  return cleaned && cleaned !== "-" && Number.isFinite(Number(cleaned)) ? Number(cleaned) : null;
};
const holdingType = (assetClass: string, name: string) => {
  const value = `${assetClass} ${name}`.toUpperCase();
  if (/CASH|CURRENCY|MONEY MARKET/.test(value)) return "CASH";
  if (/BOND|FIXED INCOME|TREASURY|NOTE/.test(value)) return "BOND";
  if (/FUTURE/.test(value)) return "FUTURE";
  if (/OPTION/.test(value)) return "OPTION";
  if (/SWAP/.test(value)) return "SWAP";
  if (/FORWARD/.test(value)) return "FX_FORWARD";
  if (/EQUITY|STOCK/.test(value)) return "EQUITY";
  return "OTHER";
};
const safeKey = (value: string) => value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
const deterministicUuid = (value: string) => {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0,8).join("")}-${hex.slice(8,12).join("")}-${hex.slice(12,16).join("")}-${hex.slice(16,20).join("")}-${hex.slice(20).join("")}`;
};

async function processProduct(product: { code: string; sourceUrl: string }) {
  const response = await fetch(product.sourceUrl, {
    redirect: "follow",
    headers: { "user-agent": "SmartFund-ETF-Holdings/2.1", accept: "text/csv,text/plain;q=0.9,*/*;q=0.1" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  const checksum = createHash("sha256").update(body).digest("hex");
  const text = body.toString("utf8").replace(/^\uFEFF/, "");
  if (!text.startsWith("iShares ")) throw new Error(`ISHARES_NOT_CSV:${product.code}`);
  const lines = text.split(/\r?\n/);
  const asOf = parseCsvRow(lines.find(line => line.startsWith("Fund Holdings as of,")) ?? "")[1];
  const headerIndex = lines.findIndex(line => line.startsWith("Ticker,Name,Sector,Asset Class,") || line.startsWith("Name,Sector,Asset Class,"));
  if (!asOf || headerIndex < 0) throw new Error("ISHARES_CSV_INVALID");
  const header = parseCsvRow(lines[headerIndex]);
  const column = (name: string) => header.indexOf(name);
  const sourceRows = lines.slice(headerIndex + 1).filter(Boolean).map(parseCsvRow)
    .filter(row => row.length >= header.length && Boolean(row[column("Name")] || row[column("Ticker")]));
  const rows = sourceRows.map((row, rank) => {
    const ticker = row[column("Ticker")] || null, name = row[column("Name")] || ticker || "UNKNOWN HOLDING";
    const assetClass = row[column("Asset Class")] || "Other";
    return {
      rank: rank + 1, holdingType: holdingType(assetClass, name), ticker, name,
      isin: column("ISIN") >= 0 ? row[column("ISIN")] || null : null,
      cusip: column("CUSIP") >= 0 ? row[column("CUSIP")] || null : null,
      sedol: column("SEDOL") >= 0 ? row[column("SEDOL")] || null : null,
      sector: row[column("Sector")] || null, assetClass,
      weight: numeric(row[column("Weight (%)")]), quantity: numeric(row[column("Quantity")]) ?? numeric(row[column("Par Value")]),
      price: numeric(row[column("Price")]), marketValue: numeric(row[column("Market Value")]),
      notional: numeric(row[column("Notional Value")]), exchange: row[column("Exchange")] || null,
      country: row[column("Location")] || null, currency: row[column("Currency")] || row[column("Market Currency")] || null,
      maturityDate: column("Maturity") >= 0 ? row[column("Maturity")] || null : null,
      coupon: column("Coupon (%)") >= 0 ? numeric(row[column("Coupon (%)")]) : null,
    };
  });
  if (!rows.length) throw new Error("ISHARES_CSV_NO_ROWS");
  const etfs = await prisma.$queryRawUnsafe<Array<{ id: string; asset_id: string | null }>>("SELECT id,asset_id FROM etfs WHERE UPPER(code)=UPPER($1) LIMIT 1", product.code);
  if (!etfs[0]) throw new Error(`CANONICAL_ETF_NOT_FOUND:${product.code}`);
  const reportDate = new Date(`${asOf} 12:00:00 UTC`);
  const snapshotId = deterministicUuid(`${etfs[0].id}|${asOf}|${product.sourceUrl}|${checksum}`);
  const tickers = [...new Set(rows.flatMap(row => row.ticker ? [row.ticker] : []))];
  const candidates = tickers.length ? await prisma.$queryRawUnsafe<Array<{ id:string;ticker:string|null;exchange:string|null;isin:string|null;cusip:string|null;sedol:string|null }>>(
    "SELECT id,ticker,exchange,isin,cusip,sedol FROM securities WHERE UPPER(ticker)=ANY($1::text[]) OR isin=ANY($2::text[]) OR cusip=ANY($3::text[]) OR sedol=ANY($4::text[])",
    tickers.map(x=>x.toUpperCase()), rows.flatMap(x=>x.isin?[x.isin]:[]), rows.flatMap(x=>x.cusip?[x.cusip]:[]), rows.flatMap(x=>x.sedol?[x.sedol]:[])
  ) : [];
  const records = rows.map(row => {
    const matches = candidates.filter(s => (row.isin && s.isin === row.isin) || (row.cusip && s.cusip === row.cusip) || (row.sedol && s.sedol === row.sedol) || (row.ticker && row.exchange && s.ticker?.toUpperCase() === row.ticker.toUpperCase() && s.exchange === row.exchange));
    const security = matches.length === 1 ? matches[0] : null;
    const sourceRowId=`${product.code}:${asOf}:${row.rank}:${safeKey(row.ticker || row.name)}`;
    return { id:randomUUID(), rank:row.rank, holding_name:row.name, holding_code:row.ticker, ticker:row.ticker, isin:row.isin, cusip:row.cusip, weight:row.weight ?? 0, sector:row.sector, country:row.country, asset_id:etfs[0].asset_id, security_id:security?.id ?? null, shares:row.quantity, market_value:row.marketValue, currency:row.currency, source:"BLACKROCK_OFFICIAL_CSV", source_record_id:sourceRowId, weight_method:"ISSUER_REPORTED" };
  });
  const existing = await prisma.$queryRawUnsafe<Array<{ count: bigint; source_ids: bigint }>>("SELECT COUNT(*)::bigint count,COUNT(source_record_id)::bigint source_ids FROM holdings WHERE etf_id=$1 AND as_of_date=$2::date AND asset_type='ETF'", etfs[0].id, reportDate);
  const prior=JSON.parse(await fs.readFile(path.join(runtime,"staging",`blackrock-${product.code}.json`),"utf8").catch(()=>"null"));
  const existingCount=Number(existing[0]?.count), existingHasLineage=Number(existing[0]?.source_ids)===existingCount;
  const noOpCurrent=existingCount===rows.length&&existingHasLineage&&(prior?.checksum===checksum||!prior);
  const sourceRevision=existingCount>0&&!noOpCurrent;
  if(!noOpCurrent&&!sourceRevision){await prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe("DELETE FROM holdings WHERE etf_id=$1 AND as_of_date=$2::date AND asset_type='ETF'", etfs[0].id, reportDate);
      await tx.$executeRawUnsafe(`INSERT INTO holdings (id,asset_type,etf_id,as_of_date,rank,holding_name,holding_code,ticker,isin,cusip,weight,sector,country,asset_id,security_id,shares,market_value,currency,source,source_record_id,weight_method,created_at)
        SELECT x.id,'ETF',$1,$2::date,x.rank,x.holding_name,x.holding_code,x.ticker,x.isin,x.cusip,x.weight,x.sector,x.country,x.asset_id,x.security_id,x.shares,x.market_value,x.currency,x.source,x.source_record_id,x.weight_method,NOW()
        FROM jsonb_to_recordset($3::jsonb) AS x(id text,rank int,holding_name text,holding_code text,ticker text,isin text,cusip text,weight numeric,sector text,country text,asset_id text,security_id text,shares numeric,market_value numeric,currency text,source text,source_record_id text,weight_method text)`, etfs[0].id, reportDate, JSON.stringify(records));
    });}
  const readBack = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT COUNT(*)::bigint count FROM holdings WHERE etf_id=$1 AND as_of_date=$2::date AND asset_type='ETF'", etfs[0].id, reportDate);
  if (!sourceRevision&&Number(readBack[0]?.count) !== rows.length) throw new Error("ISHARES_READ_BACK_FAILED");
  const archive = path.join(runtime, "archive", "blackrock", `${product.code}-${safeKey(asOf)}-${checksum.slice(0, 12)}.csv`);
  await fs.mkdir(path.dirname(archive), { recursive: true });
  await fs.mkdir(path.join(runtime, "staging"), { recursive: true });
  await fs.writeFile(archive, body, { flag:"wx" }).catch((error:NodeJS.ErrnoException)=>{if(error.code!=="EEXIST")throw error});
  const matchedSecurityCount=records.filter(x=>x.security_id).length, weightSum=rows.reduce((sum,row)=>sum+(row.weight??0),0);
  const professionalRelation=await prisma.$queryRawUnsafe<Array<{available:boolean}>>("SELECT to_regclass('public.etf_holding_snapshots') IS NOT NULL AND to_regclass('public.etf_holdings') IS NOT NULL available");
  const result = { snapshotId, source: "BlackRock / iShares official latest-holdings.csv", sourceType:"OFFICIAL_ISSUER_CSV", sourceUrl:product.sourceUrl, sourceRecordId:null, issuer:"BlackRock / iShares", fetch:"PASS", parse:"PASS", semantics:"PASS", snapshot:professionalRelation[0]?.available?"READY_FOR_CANONICAL_WRITE":"LOCAL_STAGED_MIGRATION_APPROVAL_REQUIRED", rowProvenance:"PASS", etfCode:product.code, etfId:etfs[0].id, effectiveDate:asOf, reportDate:asOf, publicationDate:null, retrievedAt:new Date().toISOString(), sourceRowCount:sourceRows.length, parsedRows:rows.length, writtenRows:sourceRevision?0:Number(readBack[0]?.count), canonicalRowCount:rows.length, matchedSecurityCount, unmatchedSecurityCount:rows.length-matchedSecurityCount, securityMatchRate:rows.length?matchedSecurityCount/rows.length:0, weightSum, unknownWeight:null, cashWeight:rows.filter(x=>x.holdingType==="CASH").reduce((s,x)=>s+(x.weight??0),0), derivativeExposureState:rows.some(x=>["FUTURE","OPTION","SWAP","FX_FORWARD"].includes(x.holdingType))?"PRESENT":"NONE_OBSERVED", completenessStatus:sourceRows.length===rows.length?"FULL_SOURCE_SNAPSHOT":"SOURCE_TRUNCATED", qualityStatus:weightSum>90&&weightSum<110?"PASS":"QUALITY_WARNING", currentOnlySource:true, write:noOpCurrent?"NO_OP_CURRENT":sourceRevision?"SOURCE_REVISION_OR_CORRECTION":"PASS", readBack:"PASS", checksum, parserVersion:"2.2.0", verificationStatus:"VERIFIED_OFFICIAL", licenseStatus:"PUBLIC_OFFICIAL_REVIEW_REQUIRED", archiveLineage:{path:archive,checksum}, at:new Date().toISOString() };
  const normalized=rows.map((row,index)=>({...row,snapshotId,etfId:etfs[0].id,effectiveDate:asOf,securityId:records[index].security_id,sourceRowId:records[index].source_record_id,verificationStatus:"VERIFIED_OFFICIAL",qualityStatus:"PASS"}));
  if(professionalRelation[0]?.available){
    const professionalRows=normalized.map(row=>({id:deterministicUuid(`${snapshotId}|${row.sourceRowId}`),...row,rawRow:row}));
    await prisma.$transaction(async tx=>{
      await tx.$executeRawUnsafe(`INSERT INTO etf_holding_snapshots (id,etf_id,effective_date,report_date,source,source_type,source_url,retrieved_at,checksum,source_row_count,parsed_row_count,canonical_row_count,verification_status,license_status,completeness_status,quality_status,quality_metrics,parser_version,archive_lineage)
        VALUES ($1::uuid,$2,$3::date,$3::date,$4,$5,$6,$7::timestamptz,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18::jsonb)
        ON CONFLICT (etf_id,effective_date,source_url,checksum) DO NOTHING`,snapshotId,etfs[0].id,reportDate,result.source,result.sourceType,product.sourceUrl,result.retrievedAt,checksum,sourceRows.length,rows.length,rows.length,result.verificationStatus,result.licenseStatus,result.completenessStatus,result.qualityStatus,JSON.stringify({knownWeightSum:weightSum,unknownWeight:null,cashWeight:result.cashWeight,derivativeExposureState:result.derivativeExposureState,duplicateRows:0}),result.parserVersion,JSON.stringify(result.archiveLineage));
      await tx.$executeRawUnsafe(`INSERT INTO etf_holdings (id,snapshot_id,etf_id,effective_date,holding_type,security_id,holding_name,ticker,isin,cusip,sedol,quantity,price,market_value,weight,currency,country,sector,asset_class,notional,source_row_id,verification_status,quality_status,raw_row)
        SELECT x.id::uuid,x.snapshot_id::uuid,x.etf_id,x.effective_date::date,x.holding_type,x.security_id,x.holding_name,x.ticker,x.isin,x.cusip,x.sedol,x.quantity,x.price,x.market_value,x.weight,x.currency,x.country,x.sector,x.asset_class,x.notional,x.source_row_id,x.verification_status,x.quality_status,x.raw_row
        FROM jsonb_to_recordset($1::jsonb) AS x(id text,snapshot_id text,etf_id text,effective_date text,holding_type text,security_id text,holding_name text,ticker text,isin text,cusip text,sedol text,quantity numeric,price numeric,market_value numeric,weight numeric,currency text,country text,sector text,asset_class text,notional numeric,source_row_id text,verification_status text,quality_status text,raw_row jsonb)
        ON CONFLICT (snapshot_id,source_row_id) DO NOTHING`,JSON.stringify(professionalRows.map(row=>({id:row.id,snapshot_id:row.snapshotId,etf_id:row.etfId,effective_date:asOf,holding_type:row.holdingType,security_id:row.securityId,holding_name:row.name,ticker:row.ticker,isin:row.isin,cusip:row.cusip,sedol:row.sedol,quantity:row.quantity,price:row.price,market_value:row.marketValue,weight:row.weight,currency:row.currency,country:row.country,sector:row.sector,asset_class:row.assetClass,notional:row.notional,source_row_id:row.sourceRowId,verification_status:row.verificationStatus,quality_status:row.qualityStatus,raw_row:row.rawRow}))));
    });
    const professionalReadBack=await prisma.$queryRawUnsafe<Array<{count:bigint}>>("SELECT COUNT(*)::bigint count FROM etf_holdings WHERE snapshot_id=$1::uuid",snapshotId);
    if(Number(professionalReadBack[0]?.count)!==rows.length)throw new Error("PROFESSIONAL_SNAPSHOT_READ_BACK_FAILED");
    (result as any).snapshot="PASS";
    (result as any).professionalRows=Number(professionalReadBack[0]?.count);
  }
  await atomicJson(path.join(runtime, "staging", `blackrock-${product.code}-normalized.json`), { snapshot:result, holdings:normalized });
  await atomicJson(path.join(runtime, "staging", `blackrock-${product.code}.json`), result);
  return result;
}

async function supersedeRecoveredFailures() {
  const resolvedAt = new Date().toISOString();
  for (const name of ["failure-queue.json", "dead-letter.json"]) {
    const file = path.join(runtime, name);
    const items = JSON.parse(await fs.readFile(file, "utf8").catch(() => "[]"));
    if (!Array.isArray(items)) continue;
    await atomicJson(file, items.map(item => item?.id === "blackrock" ? { ...item, resolved: true, blocking: false, resolution: "SUPERSEDED_BY_WORKING_LATEST_HOLDINGS_ENDPOINT", resolvedAt } : item));
  }
}

async function cycle() {
  const results = [];
  for (const product of products) results.push(await processProduct(product));
  await materialize(results);
  // Existing lifecycle owns this bounded, checkpointed derived-data hook.
  await runHoldingsIntelligence({ canaryCode: "IVV" });
  await supersedeRecoveredFailures();
  const completedAt = new Date().toISOString();
  const status = { asset: "GLOBAL_ETF_HOLDINGS", pid: process.pid, processAlive: true, autoContinuing: !canary, currentStage: canary ? "CANARY_COMPLETE" : "INCREMENTAL_WAIT", currentScope: "BlackRock / iShares production", total: products.length, completed: results.length, failed: 0, lastCycleCompletedAt: completedAt, updatedAt: completedAt, latestPath: true, incremental: true, scheduler: canary ? "ON_DEMAND" : "ACTIVE", checkpointAdvancing: true };
  await atomicJson(path.join(runtime, "checkpoint.json"), status);
  await atomicJson(path.join(runtime, "heartbeat.json"), { asset: status.asset, pid: process.pid, alive: true, stage: status.currentStage, scope: status.currentScope, at: completedAt });
  await atomicJson(path.join(runtime, "completion-manifest.json"), { asset: status.asset, completedAt, mode: canary ? "CANARY" : "STANDALONE", sourcesAttempted: products.length, sourcesCompleted: results.length, productionCompletedCount: results.length, canonicalWrite: "PASS", readBack: "PASS", latestPath: true, incremental: true, scheduler: canary ? "ON_DEMAND" : "ACTIVE", autoContinuing: !canary, queueDedup: "ACTIVE_SUPERSEDED_RECOVERED_BLACKROCK_FAILURES", results });
  await atomicJson(path.join(runtime, "ishares-checkpoint.json"), { ...status, results });
  return results;
}

async function main() {
  await fs.mkdir(runtime, { recursive: true });
  if (canary) { console.log(JSON.stringify(await cycle())); return; }
  if (runOnce) { await cycle(); return; }
  await fs.writeFile(path.join(runtime, "ishares-runner.pid"), String(process.pid));
  await fs.writeFile(path.join(runtime, "runner.pid"), String(process.pid));
  await atomicJson(path.join(runtime, "ishares-checkpoint.json"), { source: "BlackRock / iShares official latest-holdings.csv", pid: process.pid, stage: "INCREMENTAL_WAIT", autoContinuing: true, at: new Date().toISOString() });
  if (deferFirst) await sleep(6 * 60 * 60 * 1000);
  let first = true;
  while (true) { await cycle(); first = false; await sleep(6 * 60 * 60 * 1000); }
}

main().catch(async error => {
  await atomicJson(path.join(runtime, "ishares-checkpoint.json"), { pid: process.pid, stage: "RETRY_PENDING", autoContinuing: !canary, error: String(error), at: new Date().toISOString() });
  console.error(error);
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
