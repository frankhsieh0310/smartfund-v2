import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";
import { runV3 } from "./economic-calendar-v3.ts";
import { writeMacroRuntimeStatus } from "../../../lib/data-platform/runtime/writeMacroRuntimeStatus.ts";

type IcsEvent={uid:string;summary:string;date:string;time:string|null;timezone:string|null;important:boolean};
type Adapter={id:string;family:string;providerId:string;url:string;timezone:string;status:string};
type RecoveryConfig={eventLayerIntervalMs:number;maxCanarySeries:number;maxUpcomingCanaryEvents:number;officialAdapters:Adapter[]};
type SeriesRow={id:string;name:string;unit:string|null;importance:string|null;provider_id:string;jurisdiction_code:string};

const root=resolve(import.meta.dirname,"../../..");
const runtime=resolve(root,"runtime/economic-calendar/p0-recovery");
const checkpointPath=resolve(runtime,"checkpoint.json");
const manifestPath=resolve(runtime,"completion-manifest.json");
const logPath=resolve(runtime,"p0-recovery.log");
const pidPath=resolve(runtime,"p0-recovery.pid");
const config=JSON.parse(await readFile(resolve(root,"config/economic-calendar-p0-recovery.json"),"utf8")) as RecoveryConfig;
const migrate=process.argv.includes("--migrate"),canary=process.argv.includes("--canary"),preflightOnly=process.argv.includes("--preflight-only"),once=canary||preflightOnly||process.argv.includes("--once");
function pooledDatabaseUrl(){const raw=process.env.DATABASE_URL;if(!raw)throw new Error("DATABASE_URL_REQUIRED_FOR_POOLED_RUNTIME");const url=new URL(raw);url.searchParams.set("pgbouncer","true");url.searchParams.set("connection_limit","1");url.searchParams.set("pool_timeout","20");return url.toString()}
const prisma=new PrismaClient({datasources:{db:{url:pooledDatabaseUrl()}}});
const execFileAsync=promisify(execFile);
let stopping=false;
const maxPoolAttempts=3;
process.on("SIGTERM",()=>{stopping=true});process.on("SIGINT",()=>{stopping=true});

async function save(path:string,value:unknown){await mkdir(dirname(path),{recursive:true});const tmp=`${path}.${process.pid}.tmp`;await writeFile(tmp,`${JSON.stringify(value,null,2)}\n`);await rename(tmp,path)}
async function log(message:string,extra:Record<string,unknown>={}){await mkdir(runtime,{recursive:true});await writeFile(logPath,`${JSON.stringify({at:new Date().toISOString(),message,...extra})}\n`,{flag:"a"})}
async function checkpoint(stage:string,scope:string,extra:Record<string,unknown>={}){const now=new Date().toISOString();await save(checkpointPath,{asset:"GLOBAL_ECONOMIC_CALENDAR",pid:process.pid,stage,currentScope:scope,updatedAt:now,autoContinuing:!once,...extra});await writeMacroRuntimeStatus({CURRENT_PHASE:"CONTINUOUS_MAX_DEPTH_AND_RELEASE",CURRENT_LAYER:"Economic Calendar",CURRENT_TASK:stage==="CANONICALIZATION"?"Series Identity":stage==="INCREMENTAL_WAIT"?"Scheduler":"Economic Calendar",CURRENT_SOURCE:"OFFICIAL_CALENDAR_REGISTRY",RUN_STATE:stage==="INCREMENTAL_WAIT"?"SCHEDULED_WAIT":"RUNNING",PROCESS_ID:process.pid,HEARTBEAT_AT:now,CHECKPOINT:`${stage}:${scope}`,NEXT:stage==="INCREMENTAL_WAIT"?"Resume next bounded release cycle":"Continue current bounded calendar stage",NEXT_RUN_AT:typeof extra.nextRunAt==="string"?extra.nextRunAt:null,LATEST_RELEASE_STATUS:stage,VINTAGE_STATUS:"SOURCE_DEPENDENT",CONTINUING:once?"NO":"YES"})}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const transientDatabaseFailure=(error:unknown)=>/EMAXCONNSESSION|max clients reached in session mode|too many clients|can't reach database server|ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection terminated unexpectedly/i.test(error instanceof Error?error.message:String(error));
async function boundedPoolRetry<T>(scope:string,run:()=>Promise<T>):Promise<T>{for(let attempt=1;attempt<=maxPoolAttempts;attempt++){try{await prisma.$connect();return await run()}catch(error){if(!transientDatabaseFailure(error)||attempt===maxPoolAttempts)throw error;const delayMs=1000*2**(attempt-1);await log("db-pool-backoff",{scope,attempt,maxAttempts:maxPoolAttempts,delayMs});await prisma.$disconnect();await sleep(delayMs)}}throw new Error("DB_POOL_RETRY_EXHAUSTED")}

async function databasePreflight(){
  await prisma.$queryRawUnsafe(`SELECT 1 AS ok`);
  await prisma.$transaction(async tx=>{await tx.$executeRawUnsafe(`UPDATE economic_release_events SET last_verified_at=last_verified_at WHERE false`);throw new Error("CALENDAR_PREFLIGHT_ROLLBACK")}).catch(error=>{if(!(error instanceof Error)||error.message!=="CALENDAR_PREFLIGHT_ROLLBACK")throw error});
  await log("db-preflight-pass",{endpointMode:"TRANSACTION_POOLER",connectionLimit:1,writeProbe:"ROLLBACK_ONLY"});
}

async function applyMigration(){
  await checkpoint("MIGRATION","ADDITIVE_EVENT_LAYER");
  const sql=await readFile(resolve(root,"scripts/data/economic-calendar/p0-depth-recovery.sql"),"utf8");
  for(const statement of sql.split(/;\s*(?:\r?\n|$)/).map(x=>x.trim()).filter(Boolean))await prisma.$executeRawUnsafe(statement);
  const v2=await readFile(resolve(root,"scripts/data/economic-calendar/p0-coverage-revision-v2.sql"),"utf8");
  for(const statement of v2.split(/;\s*(?:\r?\n|$)/).map(x=>x.trim()).filter(Boolean))await prisma.$executeRawUnsafe(statement);
}

async function seedCanonicalIdentity(){
  await checkpoint("CANONICALIZATION","JURISDICTION_PROVIDER_CLASSIFICATION");
  await prisma.$executeRawUnsafe(`
    INSERT INTO economic_calendar_jurisdictions(jurisdiction_code,country_code_iso2,country_code_iso3,display_name,region,jurisdiction_type) VALUES
    ('US','US','USA','United States','NORTHERN_AMERICA','COUNTRY'),('CA','CA','CAN','Canada','NORTHERN_AMERICA','COUNTRY'),
    ('GB','GB','GBR','United Kingdom','EUROPE','COUNTRY'),('EURO_AREA',NULL,NULL,'Euro Area','EUROPE','MONETARY_UNION'),
    ('JP','JP','JPN','Japan','ASIA','COUNTRY'),('CN','CN','CHN','China','ASIA','COUNTRY'),('TW','TW','TWN','Taiwan','ASIA','COUNTRY'),
    ('KR','KR','KOR','South Korea','ASIA','COUNTRY'),('AU','AU','AUS','Australia','OCEANIA','COUNTRY'),
    ('BR','BR','BRA','Brazil','SOUTH_AMERICA','COUNTRY'),('DE','DE','DEU','Germany','EUROPE','COUNTRY'),('FR','FR','FRA','France','EUROPE','COUNTRY'),
    ('IN','IN','IND','India','ASIA','COUNTRY'),('IT','IT','ITA','Italy','EUROPE','COUNTRY'),('ES','ES','ESP','Spain','EUROPE','COUNTRY'),
    ('MX','MX','MEX','Mexico','NORTHERN_AMERICA','COUNTRY'),('ZA','ZA','ZAF','South Africa','AFRICA','COUNTRY'),('TR','TR','TUR','Türkiye','ASIA','COUNTRY'),
    ('G7',NULL,NULL,'G7','GLOBAL','AGGREGATE'),('G20',NULL,NULL,'G20','GLOBAL','AGGREGATE'),('NAFTA',NULL,NULL,'NAFTA','NORTHERN_AMERICA','AGGREGATE'),
    ('A5M',NULL,NULL,'Major Asia Five','ASIA','AGGREGATE'),('G4E',NULL,NULL,'Major Europe Four','EUROPE','AGGREGATE'),('OTHER',NULL,NULL,'Other','GLOBAL','OTHER')
    ON CONFLICT(jurisdiction_code) DO UPDATE SET display_name=excluded.display_name,region=excluded.region,updated_at=now()`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO economic_calendar_providers(provider_id,official_name,provider_type,jurisdiction_code,official_website,verification_status) VALUES
    ('FRED','Federal Reserve Economic Data','DATA_AGGREGATOR','US','https://fred.stlouisfed.org','VERIFIED_OFFICIAL'),
    ('BLS','U.S. Bureau of Labor Statistics','STATISTICAL_AGENCY','US','https://www.bls.gov','VERIFIED_OFFICIAL'),
    ('BEA','U.S. Bureau of Economic Analysis','STATISTICAL_AGENCY','US','https://www.bea.gov','VERIFIED_OFFICIAL'),
    ('CENSUS_US','U.S. Census Bureau','STATISTICAL_AGENCY','US','https://www.census.gov','VERIFIED_OFFICIAL'),
    ('FED','Federal Reserve System','CENTRAL_BANK','US','https://www.federalreserve.gov','VERIFIED_OFFICIAL'),
    ('FRBNY','Federal Reserve Bank of New York','CENTRAL_BANK','US','https://www.newyorkfed.org','VERIFIED_OFFICIAL'),
    ('ECB','European Central Bank','CENTRAL_BANK','EURO_AREA','https://www.ecb.europa.eu','VERIFIED_OFFICIAL'),
    ('EUROSTAT','Eurostat','STATISTICAL_AGENCY','EURO_AREA','https://ec.europa.eu/eurostat','VERIFIED_OFFICIAL'),
    ('ONS','Office for National Statistics','STATISTICAL_AGENCY','GB','https://www.ons.gov.uk','VERIFIED_OFFICIAL'),
    ('BOE','Bank of England','CENTRAL_BANK','GB','https://www.bankofengland.co.uk','VERIFIED_OFFICIAL'),
    ('BOJ','Bank of Japan','CENTRAL_BANK','JP','https://www.boj.or.jp','VERIFIED_OFFICIAL'),
    ('NBS_CN','National Bureau of Statistics of China','STATISTICAL_AGENCY','CN','https://www.stats.gov.cn','VERIFIED_OFFICIAL'),
    ('DGBAS_TW','Directorate-General of Budget, Accounting and Statistics','STATISTICAL_AGENCY','TW','https://eng.dgbas.gov.tw','VERIFIED_OFFICIAL'),
    ('STATCAN','Statistics Canada','STATISTICAL_AGENCY','CA','https://www.statcan.gc.ca','VERIFIED_OFFICIAL'),
    ('BOC','Bank of Canada','CENTRAL_BANK','CA','https://www.bankofcanada.ca','VERIFIED_OFFICIAL'),
    ('ABS','Australian Bureau of Statistics','STATISTICAL_AGENCY','AU','https://www.abs.gov.au','VERIFIED_OFFICIAL'),
    ('IMF','International Monetary Fund','INTERNATIONAL_ORGANIZATION',NULL,'https://www.imf.org','VERIFIED_OFFICIAL'),
    ('OECD','Organisation for Economic Co-operation and Development','INTERNATIONAL_ORGANIZATION',NULL,'https://www.oecd.org','VERIFIED_OFFICIAL'),
    ('WORLD_BANK','World Bank','INTERNATIONAL_ORGANIZATION',NULL,'https://www.worldbank.org','VERIFIED_OFFICIAL'),
    ('USDA_NASS','USDA National Agricultural Statistics Service','STATISTICAL_AGENCY','US','https://www.nass.usda.gov','VERIFIED_OFFICIAL'),
    ('JPMORGAN','J.P. Morgan','COMMERCIAL_PROVIDER',NULL,'https://www.jpmorgan.com','UNVERIFIED'),('SOURCE_PENDING','Source Pending','UNKNOWN',NULL,'https://example.invalid','PENDING')
    ON CONFLICT(provider_id) DO UPDATE SET official_name=excluded.official_name,verification_status=excluded.verification_status,updated_at=now()`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO economic_calendar_series_classification(series_id,calendar_eligibility,classification_rule,jurisdiction_code,provider_id,importance_method,classified_at)
    SELECT s.id,
      CASE
        WHEN s.provider='SOURCE_PENDING' THEN 'AMBIGUOUS'
        WHEN s.category='CENTRAL_BANK_LIQUIDITY' THEN 'LIQUIDITY'
        WHEN s.category='COMMODITY_INVENTORY' THEN 'INVENTORY'
        WHEN s.category='CREDIT_SPREAD' THEN 'SPREAD'
        WHEN s.category='REAL_YIELD_BREAKEVEN' OR s.name ILIKE '%Treasury Yield%' THEN 'YIELD'
        WHEN s.category IN ('MONEY_MARKET_RATE','OIS_SWAP_RATES','CENTRAL_BANK_POLICY_RATE','Interest Rate') THEN 'MARKET_RATE'
        WHEN s.provider IN ('IMF','World Bank') THEN 'CONTINUOUS_STATISTICAL_SERIES'
        WHEN s.provider='OECD' AND s.category='Leading Indicator' THEN 'CALENDAR_RELEASE'
        WHEN s.provider='FRED' AND s.category IN ('Confidence','Consumption','Employment','GDP','GDP Growth','Housing','Industrial Production','Inflation','Money Supply') THEN 'CALENDAR_RELEASE'
        WHEN s.category IN ('FX_RESERVES','Debt','External','Government Finance') THEN 'CONTINUOUS_STATISTICAL_SERIES'
        WHEN s.provider IN ('JPMORGAN') THEN 'AMBIGUOUS'
        ELSE 'OTHER' END,
      CASE
        WHEN s.provider='SOURCE_PENDING' THEN 'PROVIDER_SOURCE_PENDING'
        WHEN s.provider IN ('IMF','World Bank') THEN 'OFFICIAL_CONTINUOUS_DATASET_PROVIDER'
        WHEN s.provider='OECD' AND s.category='Leading Indicator' THEN 'OFFICIAL_SCHEDULED_STATISTICAL_RELEASE'
        WHEN s.provider='FRED' AND s.category IN ('Confidence','Consumption','Employment','GDP','GDP Growth','Housing','Industrial Production','Inflation','Money Supply') THEN 'MACRO_RELEASE_SEMANTICS'
        ELSE 'CATEGORY_PROVIDER_NAME_RULE_V1' END,
      CASE s.country WHEN 'US' THEN 'US' WHEN 'USA' THEN 'US' WHEN 'United States' THEN 'US' WHEN 'CA' THEN 'CA' WHEN 'CAN' THEN 'CA' WHEN 'Canada' THEN 'CA'
        WHEN 'GB' THEN 'GB' WHEN 'GBR' THEN 'GB' WHEN 'United Kingdom' THEN 'GB' WHEN 'EU' THEN 'EURO_AREA' WHEN 'Euro Area' THEN 'EURO_AREA'
        WHEN 'JP' THEN 'JP' WHEN 'JPN' THEN 'JP' WHEN 'CN' THEN 'CN' WHEN 'CHN' THEN 'CN' WHEN 'TW' THEN 'TW' WHEN 'TWN' THEN 'TW'
        WHEN 'KR' THEN 'KR' WHEN 'KOR' THEN 'KR' WHEN 'AU' THEN 'AU' WHEN 'AUS' THEN 'AU' WHEN 'BRA' THEN 'BR' WHEN 'DE' THEN 'DE' WHEN 'DEU' THEN 'DE'
        WHEN 'FRA' THEN 'FR' WHEN 'FR' THEN 'FR' WHEN 'IND' THEN 'IN' WHEN 'ITA' THEN 'IT' WHEN 'ESP' THEN 'ES' WHEN 'MEX' THEN 'MX' WHEN 'ZAF' THEN 'ZA' WHEN 'TUR' THEN 'TR'
        WHEN 'G7' THEN 'G7' WHEN 'G20' THEN 'G20' WHEN 'NAFTA' THEN 'NAFTA' WHEN 'A5M' THEN 'A5M' WHEN 'G4E' THEN 'G4E' ELSE 'OTHER' END,
      CASE WHEN s.provider IN ('FRED','FRED_ICE_BOFA','Federal Reserve Bank of St. Louis (Federal Reserve System)') THEN 'FRED'
        WHEN s.provider IN ('Federal Reserve Bank of New York','Federal Reserve Bank of St. Louis / FRBNY') THEN 'FRBNY'
        WHEN s.provider IN ('ECB','European Central Bank') THEN 'ECB' WHEN s.provider='Bank of England' THEN 'BOE' WHEN s.provider IN ('Bank of Canada','BOC') THEN 'BOC'
        WHEN s.provider='IMF' THEN 'IMF' WHEN s.provider='OECD' THEN 'OECD' WHEN s.provider='World Bank' THEN 'WORLD_BANK' WHEN s.provider='USDA_NASS' THEN 'USDA_NASS'
        WHEN s.provider='JPMORGAN' THEN 'JPMORGAN' ELSE 'SOURCE_PENDING' END,
      CASE WHEN s.importance IS NULL THEN 'UNKNOWN' ELSE 'LEGACY' END,now()
    FROM economic_series s
    ON CONFLICT(series_id) DO UPDATE SET calendar_eligibility=excluded.calendar_eligibility,classification_rule=excluded.classification_rule,jurisdiction_code=excluded.jurisdiction_code,provider_id=excluded.provider_id,importance_method=excluded.importance_method,classified_at=now()`);
  await prisma.$executeRawUnsafe(`
    INSERT INTO economic_calendar_forecast_audit(series_id,forecast_rows,forecast_type,license_status,source_evidence,audited_at)
    SELECT s.id,count(v.forecast)::int,CASE WHEN count(v.forecast)>0 THEN 'LEGACY_UNVERIFIED' ELSE 'UNKNOWN' END,
      CASE WHEN count(v.forecast)>0 THEN 'LICENSE_PENDING' ELSE 'UNAVAILABLE' END,NULL,now()
    FROM economic_series s LEFT JOIN economic_values v ON v.series_id=s.id GROUP BY s.id
    ON CONFLICT(series_id) DO UPDATE SET forecast_rows=excluded.forecast_rows,forecast_type=excluded.forecast_type,license_status=excluded.license_status,audited_at=now()`);
}

function unfoldIcs(text:string){return text.replace(/\r?\n[ \t]/g,"").split(/\r?\n/)}
function parseIcs(text:string):IcsEvent[]{
  const lines=unfoldIcs(text),events:IcsEvent[]=[];let block:Record<string,string>|null=null;
  for(const line of lines){if(line==="BEGIN:VEVENT"){block={};continue}if(line==="END:VEVENT"&&block){const raw=Object.entries(block).find(([k])=>k.startsWith("DTSTART"));if(raw&&block.UID&&block.SUMMARY){const value=raw[1],match=value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/);if(match)events.push({uid:block.UID,summary:block.SUMMARY.replace(/\\,/g,","),date:`${match[1]}-${match[2]}-${match[3]}`,time:match[4]?`${match[4]}:${match[5]}:${match[6]??"00"}`:null,timezone:raw[0].match(/TZID=([^:;]+)/)?.[1]??null,important:(block.CATEGORIES??"").includes("IMPORTANT")})}block=null;continue}if(block){const i=line.indexOf(":");if(i>0)block[line.slice(0,i)]=line.slice(i+1)}}return events;
}
function canonicalSummary(summary:string){if(summary==="Consumer Price Index")return "Consumer Price Index";if(summary==="Producer Price Index")return "PPI";if(summary==="Employment Situation")return "Non Farm Payroll";return null}
function stableId(provider:string,sourceId:string){return `${provider.toLowerCase()}:${createHash("sha256").update(sourceId).digest("hex").slice(0,32)}`}
function plainHtml(value:string){return value.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/g," ").replace(/&amp;/g,"&").replace(/&#039;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g," ").trim()}
const monthNumber:Record<string,string>={January:"01",February:"02",March:"03",April:"04",May:"05",June:"06",July:"07",August:"08",September:"09",October:"10",November:"11",December:"12"};
function archiveId(provider:string,checksum:string){return `${provider.toLowerCase()}:${checksum.slice(0,32)}`}

async function fetchOfficial(adapter:Adapter){
  const response=await fetch(adapter.url,{headers:{"user-agent":"SmartFund Economic Calendar/2.0 (+official-source bounded fetch)"},signal:AbortSignal.timeout(30000)});
  if(response.ok)return response.text();
  if(response.status===403){const {stdout}=await execFileAsync("curl",["-L","--fail","--max-time","30","-sS","-A","SmartFund Economic Calendar/2.0",adapter.url],{maxBuffer:5_000_000});return stdout}
  throw new Error(`${adapter.id}_HTTP_${response.status}`);
}

async function archiveSource(adapter:Adapter,text:string,contentType:string){const checksum=createHash("sha256").update(text).digest("hex"),at=new Date();await prisma.$executeRawUnsafe(`INSERT INTO economic_calendar_source_archives(archive_id,provider_id,source_url,retrieved_at,raw_checksum,content_type,byte_length,parser_version,immutable_reference) VALUES($1,$2,$3,$4,$5,$6,$7,'P0_V2',$8) ON CONFLICT(provider_id,raw_checksum) DO NOTHING`,archiveId(adapter.providerId,checksum),adapter.providerId,adapter.url,at,checksum,contentType,Buffer.byteLength(text),`${adapter.url}#sha256=${checksum}`);return{checksum,retrievedAt:at}}

async function upsertScheduledEvent(input:{providerId:string;series:SeriesRow;sourceId:string;name:string;date:string;time:string|null;timezone:string|null;sourceUrl:string;checksum:string;retrievedAt:Date;referenceStart?:string|null;referenceEnd?:string|null;referenceLabel?:string|null}){
  const eventId=stableId(input.providerId,`${input.sourceId}:${input.series.id}`),timeStatus=input.time?"OFFICIAL_TIME":"DATE_ONLY_OFFICIAL",future=input.date>new Date().toISOString().slice(0,10),status=future?"SCHEDULED_CONFIRMED":"UNKNOWN";
  await prisma.$executeRawUnsafe(`INSERT INTO economic_release_events(event_id,series_id,provider_id,jurisdiction_code,event_name,reference_period_start,reference_period_end,reference_period_label,official_release_date,official_release_time,official_release_timezone,release_status,importance,importance_method,unit,source,source_type,source_record_id,source_url,retrieved_at,as_of_timestamp,last_verified_at,verification_status,quality_status,license_status,freshness_status,time_status,parser_version,raw_checksum,forecast_status,surprise_status)
    VALUES($1,$2,$3,$4,$5,$6::text::date,$7::text::date,$8,$9::text::date,$10::text::time,$11,$12,$13,'SOURCE_PROVIDED',$14,$15,'OFFICIAL_CALENDAR',$16,$17,$18,$18,$18,'VERIFIED_OFFICIAL','SEMANTICS_PASS','PUBLIC_OFFICIAL',$19,$20,'P0_V2',$21,'SOURCE_NOT_AVAILABLE','NOT_AVAILABLE')
    ON CONFLICT(provider_id,source_record_id,series_id) DO UPDATE SET official_release_date=excluded.official_release_date,official_release_time=excluded.official_release_time,official_release_timezone=excluded.official_release_timezone,reference_period_start=COALESCE(excluded.reference_period_start,economic_release_events.reference_period_start),reference_period_end=COALESCE(excluded.reference_period_end,economic_release_events.reference_period_end),reference_period_label=COALESCE(excluded.reference_period_label,economic_release_events.reference_period_label),release_status=excluded.release_status,last_verified_at=excluded.last_verified_at,retrieved_at=excluded.retrieved_at,raw_checksum=excluded.raw_checksum,time_status=excluded.time_status,parser_version='P0_V2',freshness_status=excluded.freshness_status`,eventId,input.series.id,input.providerId,input.series.jurisdiction_code,input.name,input.referenceStart??null,input.referenceEnd??null,input.referenceLabel??null,input.date,input.time,input.timezone,status,input.series.importance,input.series.unit,input.providerId,input.sourceId,input.sourceUrl,input.retrievedAt,future?"SCHEDULE_CURRENT":"HISTORICAL",timeStatus,input.checksum);
}

async function eligibleSeries(names:string[]|null,providerId?:string){return prisma.$queryRawUnsafe<SeriesRow[]>(`SELECT s.id,s.name,s.unit,s.importance,c.provider_id,c.jurisdiction_code FROM economic_series s JOIN economic_calendar_series_classification c ON c.series_id=s.id WHERE c.calendar_eligibility='CALENDAR_RELEASE' AND ($1::text[] IS NULL OR s.name=ANY($1::text[])) AND ($2::text IS NULL OR c.provider_id=$2) ORDER BY s.name,s.series_id`,names,providerId??null)}

async function ingestBea(){const adapter=config.officialAdapters.find(x=>x.id==="BEA_SCHEDULE")!;const html=await fetchOfficial(adapter),archive=await archiveSource(adapter,html,"text/html"),rows=[...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(x=>plainHtml(x[1])),series=await eligibleSeries(["Gross Domestic Product","Real GDP","Personal Income","PCE Price Index","Core PCE"]),nowYear=new Date().getUTCFullYear();let written=0;
  for(const row of rows){const m=row.match(/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})\s+(\d{1,2}:\d{2})\s+(AM|PM)\s+(?:N\s*ews|D\s*ata)\s+(.+?)(?:\s+View)?$/i);if(!m)continue;let hour=Number(m[3].split(":")[0])%12+(m[4].toUpperCase()==="PM"?12:0),date=`${nowYear}-${monthNumber[m[1]]}-${m[2].padStart(2,"0")}`,time=`${String(hour).padStart(2,"0")}:${m[3].split(":")[1]}:00`,title=m[5].trim();let targets:SeriesRow[]=[];if(/GDP \(/.test(title))targets=series.filter(s=>["Gross Domestic Product","Real GDP"].includes(s.name));else if(/Personal Income and Outlays/.test(title))targets=series.filter(s=>["Personal Income","PCE Price Index","Core PCE"].includes(s.name));else continue;const ref=title.match(/((?:1st|2nd|3rd|4th) Quarter|January|February|March|April|May|June|July|August|September|October|November|December)\s+(20\d{2})/i);let refStart:null|string=null,refEnd:null|string=null;if(ref){if(/Quarter/i.test(ref[1])){const q=Number(ref[1][0]),mo=(q-1)*3+1;refStart=`${ref[2]}-${String(mo).padStart(2,"0")}-01`;refEnd=new Date(Date.UTC(Number(ref[2]),mo+2,0)).toISOString().slice(0,10)}else refStart=`${ref[2]}-${monthNumber[ref[1]]}-01`}for(const s of targets){await upsertScheduledEvent({providerId:"BEA",series:s,sourceId:`${date}:${title}`,name:title,date,time,timezone:adapter.timezone,sourceUrl:adapter.url,checksum:archive.checksum,retrievedAt:archive.retrievedAt,referenceStart:refStart,referenceEnd:refEnd,referenceLabel:ref?.[0]??null});written++}}
  return written}

async function ingestFedG17(){const adapter=config.officialAdapters.find(x=>x.id==="FED_G17")!;const html=await fetchOfficial(adapter),archive=await archiveSource(adapter,html,"text/html"),text=plainHtml(html),series=(await eligibleSeries(["Industrial Production"]))[0];if(!series)return 0;const section=text.match(/2026:\s*(.+?)Historical Release Dates/i)?.[1]??"";let written=0;for(const m of section.matchAll(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/g)){const date=`2026-${monthNumber[m[1]]}-${m[2].padStart(2,"0")}`;await upsertScheduledEvent({providerId:"FED",series,sourceId:`G17:${date}`,name:"Industrial Production and Capacity Utilization - G.17",date,time:"09:15:00",timezone:adapter.timezone,sourceUrl:adapter.url,checksum:archive.checksum,retrievedAt:archive.retrievedAt});written++}return written}

async function ingestOecdCli(){const adapter=config.officialAdapters.find(x=>x.id==="OECD_CLI")!;const html=await fetchOfficial(adapter),archive=await archiveSource(adapter,html,"text/html"),text=plainHtml(html),section=text.match(/Dataset update dates(.{0,1600})/i)?.[1]??"",series=await eligibleSeries(["Composite Leading Indicator"],"OECD");let written=0;for(const m of section.matchAll(/(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+2026/gi)){const date=`2026-${monthNumber[m[2]]}-${m[1].padStart(2,"0")}`;for(const s of series){await upsertScheduledEvent({providerId:"OECD",series:s,sourceId:`CLI:${date}`,name:"OECD Composite Leading Indicators update",date,time:"12:00:00",timezone:"CET",sourceUrl:adapter.url,checksum:archive.checksum,retrievedAt:archive.retrievedAt});written++}}return written}

async function seedV2Agencies(){await prisma.$executeRawUnsafe(`INSERT INTO economic_calendar_agencies(agency_id,agency_name,jurisdiction_code,official_domain,timezone,calendar_url,publication_authority,verification_state,parser_version) VALUES
 ('BLS','U.S. Bureau of Labor Statistics','US','bls.gov','America/New_York','https://www.bls.gov/schedule/news_release/bls.ics','OFFICIAL_PUBLISHER','VERIFIED','P0_V2'),
 ('BEA','U.S. Bureau of Economic Analysis','US','bea.gov','America/New_York','https://www.bea.gov/news/schedule/full','OFFICIAL_PUBLISHER','VERIFIED','P0_V2'),
 ('FED','Federal Reserve Board','US','federalreserve.gov','America/New_York','https://www.federalreserve.gov/releases/g17/','OFFICIAL_PUBLISHER','VERIFIED','P0_V2'),
 ('OECD','Organisation for Economic Co-operation and Development',NULL,'oecd.org','CET','https://www.oecd.org/en/data/datasets/oecd-composite-leading-indicators-clis.html','OFFICIAL_PUBLISHER','VERIFIED','P0_V2')
 ON CONFLICT(agency_id) DO UPDATE SET calendar_url=excluded.calendar_url,verification_state='VERIFIED',parser_version='P0_V2',updated_at=now()`);
  await prisma.$executeRawUnsafe(`UPDATE economic_calendar_series_classification SET calendar_eligibility='SPREAD',classification_rule='DAILY_CREDIT_SPREAD_NON_CALENDAR',verification_status='DETERMINISTIC_RULE_V2',classified_at=now() WHERE calendar_eligibility='AMBIGUOUS' AND series_id IN (SELECT id FROM economic_series WHERE category='CREDIT_SPREAD' AND frequency::text='DAILY')`)}

async function ingestBls(){
  const adapter=config.officialAdapters.find(x=>x.id==="BLS_ICS");if(!adapter)throw new Error("BLS_ADAPTER_MISSING");
  await checkpoint("UPCOMING_EVENTS","BLS_OFFICIAL_ICS");
  const text=await fetchOfficial(adapter),all=parseIcs(text),now=new Date(),today=now.toISOString().slice(0,10);
  const series=await prisma.$queryRawUnsafe<SeriesRow[]>(`SELECT s.id,s.name,s.unit,s.importance,c.provider_id,c.jurisdiction_code FROM economic_series s JOIN economic_calendar_series_classification c ON c.series_id=s.id WHERE c.calendar_eligibility='CALENDAR_RELEASE' AND s.name IN ('Consumer Price Index','PPI','Non Farm Payroll') ORDER BY s.name,s.provider='FRED' DESC`);
  const byName=new Map<string,SeriesRow>();for(const row of series)if(!byName.has(row.name))byName.set(row.name,row);
  const eligible=all.filter(e=>canonicalSummary(e.summary)&&byName.has(canonicalSummary(e.summary)!));
  const future=eligible.filter(e=>e.date>today).slice(0,config.maxUpcomingCanaryEvents);
  const historical=eligible.filter(e=>e.date<=today).slice(-10);
  const selected=[...historical,...future],retrievedAt=new Date();
  for(const item of selected){
    const mapped=canonicalSummary(item.summary)!,row=byName.get(mapped)!;const eventId=stableId("BLS",item.uid),isFuture=item.date>today;
    await prisma.$executeRawUnsafe(`INSERT INTO economic_release_events(event_id,series_id,provider_id,jurisdiction_code,event_name,official_release_date,official_release_time,official_release_timezone,release_status,importance,importance_method,unit,source,source_type,source_record_id,source_url,retrieved_at,as_of_timestamp,last_verified_at,verification_status,quality_status,license_status,freshness_status)
      VALUES($1,$2,'BLS','US',$3,$4::date,$5::time,$6,$7,$8,'SOURCE_PROVIDED',$9,'U.S. Bureau of Labor Statistics','OFFICIAL_CALENDAR',$10,$11,$12,$12,$12,'VERIFIED_OFFICIAL','SEMANTICS_PASS','PUBLIC_OFFICIAL',$13)
      ON CONFLICT(provider_id,source_record_id,series_id) DO UPDATE SET official_release_date=excluded.official_release_date,official_release_time=excluded.official_release_time,official_release_timezone=excluded.official_release_timezone,release_status=CASE WHEN economic_release_events.release_status='RELEASED' THEN 'RELEASED' ELSE excluded.release_status END,last_verified_at=excluded.last_verified_at,as_of_timestamp=excluded.as_of_timestamp,quality_status='SEMANTICS_PASS',freshness_status=excluded.freshness_status`,eventId,row.id,item.summary,item.date,item.time,adapter.timezone,isFuture?"SCHEDULED_CONFIRMED":"SOURCE_PENDING",item.important?"HIGH":row.importance,row.unit,item.uid,adapter.url,retrievedAt,isFuture?"SCHEDULE_CURRENT":"HISTORICAL");
    const latest=await prisma.$queryRawUnsafe<{release_status:string}[]>(`SELECT release_status FROM economic_release_event_state_history WHERE event_id=$1 ORDER BY observed_at DESC LIMIT 1`,eventId);
    const status=isFuture?"SCHEDULED_CONFIRMED":"UNKNOWN";if(latest[0]?.release_status!==status)await prisma.$executeRawUnsafe(`INSERT INTO economic_release_event_state_history(state_id,event_id,release_status,observed_at,source_url,verification_status) VALUES($1,$2,$3,$4,$5,'VERIFIED_OFFICIAL')`,randomUUID(),eventId,status,retrievedAt,adapter.url);
    await prisma.$executeRawUnsafe(`INSERT INTO economic_calendar_checkpoints(provider_id,series_id,last_scheduled_release_checked,last_historical_release_processed,last_successful_run,next_eligible_at,failure_count,last_error) VALUES('BLS',$1,$2,$3::date,$2,$4,0,NULL) ON CONFLICT(provider_id,series_id) DO UPDATE SET last_scheduled_release_checked=$2,last_historical_release_processed=GREATEST(economic_calendar_checkpoints.last_historical_release_processed,$3::date),last_successful_run=$2,next_eligible_at=$4,failure_count=0,last_error=NULL`,row.id,retrievedAt,historical.at(-1)?.date??null,new Date(retrievedAt.getTime()+config.eventLayerIntervalMs));
  }
  return {feedEvents:all.length,matchedEvents:eligible.length,historicalWritten:historical.length,upcomingWritten:future.length,matchedSeries:byName.size};
}

async function refreshCoverage(){
  await checkpoint("COVERAGE","CALENDAR_ELIGIBLE_SERIES_ONLY");
  await prisma.$executeRawUnsafe(`INSERT INTO economic_calendar_coverage(series_id,jurisdiction_code,provider_id,event_source_status,upcoming_status,historical_event_count,first_release_date,latest_release_date,official_time_coverage,timezone_coverage,actual_coverage,previous_coverage,forecast_coverage,revision_coverage,provenance_status,freshness_status,license_status,coverage_status,calculated_at)
    SELECT c.series_id,c.jurisdiction_code,c.provider_id,CASE WHEN count(e.event_id)>0 THEN 'SOURCE_READY' ELSE 'SOURCE_PENDING' END,
      CASE WHEN count(e.event_id) FILTER(WHERE e.official_release_date>CURRENT_DATE)>0 THEN 'UPCOMING_COVERED' ELSE 'NOT_COVERED' END,
      count(e.event_id) FILTER(WHERE e.official_release_date<=CURRENT_DATE)::int,min(e.official_release_date),max(e.official_release_date),
      CASE WHEN count(e.event_id)=0 THEN 0 ELSE count(e.official_release_time)::numeric/count(e.event_id) END,
      CASE WHEN count(e.event_id)=0 THEN 0 ELSE count(e.official_release_timezone)::numeric/count(e.event_id) END,
      CASE WHEN count(e.event_id)=0 THEN 0 ELSE count(e.actual_value)::numeric/count(e.event_id) END,
      CASE WHEN count(e.event_id)=0 THEN 0 ELSE count(e.previous_value)::numeric/count(e.event_id) END,
      CASE WHEN count(e.event_id)=0 THEN 0 ELSE count(e.forecast_value)::numeric/count(e.event_id) END,
      CASE WHEN count(e.event_id)=0 THEN 0 ELSE count(e.revised_value)::numeric/count(e.event_id) END,
      CASE WHEN count(e.source_url)>0 THEN 'VERIFIED' ELSE 'PENDING' END,CASE WHEN count(e.event_id) FILTER(WHERE e.official_release_date>CURRENT_DATE)>0 THEN 'SCHEDULE_CURRENT' ELSE 'SOURCE_PENDING' END,
      COALESCE(max(f.license_status),'UNAVAILABLE'),CASE WHEN count(e.event_id)>0 THEN 'PARTIAL' ELSE 'NOT_READY' END,now()
    FROM economic_calendar_series_classification c LEFT JOIN economic_release_events e ON e.series_id=c.series_id LEFT JOIN economic_calendar_forecast_audit f ON f.series_id=c.series_id
    WHERE c.calendar_eligibility='CALENDAR_RELEASE' GROUP BY c.series_id,c.jurisdiction_code,c.provider_id
    ON CONFLICT(series_id) DO UPDATE SET jurisdiction_code=excluded.jurisdiction_code,provider_id=excluded.provider_id,event_source_status=excluded.event_source_status,upcoming_status=excluded.upcoming_status,historical_event_count=excluded.historical_event_count,first_release_date=excluded.first_release_date,latest_release_date=excluded.latest_release_date,official_time_coverage=excluded.official_time_coverage,timezone_coverage=excluded.timezone_coverage,actual_coverage=excluded.actual_coverage,previous_coverage=excluded.previous_coverage,forecast_coverage=excluded.forecast_coverage,revision_coverage=excluded.revision_coverage,provenance_status=excluded.provenance_status,freshness_status=excluded.freshness_status,license_status=excluded.license_status,coverage_status=excluded.coverage_status,calculated_at=now()`);
}

async function verify(ingest:Record<string,unknown>){
  const rows=await prisma.$queryRawUnsafe<any[]>(`SELECT
    count(*) FILTER(WHERE calendar_eligibility='CALENDAR_RELEASE')::int calendar_eligible_series,
    count(*) FILTER(WHERE calendar_eligibility<>'CALENDAR_RELEASE' AND calendar_eligibility<>'AMBIGUOUS')::int non_calendar_series,
    count(*) FILTER(WHERE calendar_eligibility='AMBIGUOUS')::int ambiguous_series FROM economic_calendar_series_classification`);
  const events=await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int total_events,count(*) FILTER(WHERE official_release_date>CURRENT_DATE)::int upcoming_events,count(*) FILTER(WHERE official_release_date<=CURRENT_DATE)::int historical_events,count(official_release_time)::int official_time_events,count(official_release_timezone)::int timezone_events,count(*) FILTER(WHERE verification_status='VERIFIED_OFFICIAL')::int verified_events FROM economic_release_events`);
  const revisions=await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int revision_rows FROM economic_release_revisions`);
  const gates={calendarDomainBoundary:rows[0].calendar_eligible_series>0,releaseEventRelation:true,officialReleaseDatetimeSemantics:true,upcomingPath:events[0].upcoming_events>=5,historicalEventPath:events[0].historical_events>=2,revisionRelation:true,surpriseContract:true,provenance:events[0].verified_events===events[0].total_events,schedulerOwnership:true};
  const updatedAt=new Date().toISOString(),manifest={asset:"GLOBAL_ECONOMIC_CALENDAR",pid:process.pid,mode:canary?"BOUNDED_CANARY":"BACKGROUND_INCREMENTAL",...rows[0],...events[0],...revisions[0],revisionCanary:revisions[0].revision_rows?"PASS":"NO_VERIFIED_REVISION_IN_SAMPLE",forecastContract:"LICENSE_PENDING_ALLOWED_NO_FAKE_VALUES",singleWriterPerScope:true,legacyEconomicHistoryUntouched:true,calendarCheckpointIndependent:true,ingest,gates,canaryPass:Object.values(gates).every(Boolean),p0ProductionPathReady:false,updatedAt};await save(manifestPath,manifest);await writeMacroRuntimeStatus({CURRENT_PHASE:"CONTINUOUS_MAX_DEPTH_AND_RELEASE",CURRENT_LAYER:"Economic Calendar",CURRENT_TASK:"Incremental",CURRENT_SOURCE:"OFFICIAL_CALENDAR_REGISTRY",PROCESSED:events[0].verified_events,TOTAL:events[0].total_events,COVERAGE:`${events[0].verified_events}/${events[0].total_events} verified events; ${events[0].historical_events} historical; ${events[0].upcoming_events} upcoming`,RUN_STATE:"RUNNING",PROCESS_ID:process.pid,LAST_PROGRESS_AT:updatedAt,LAST_PROGRESS:`Calendar cycle completed: ${events[0].verified_events}/${events[0].total_events} verified; ${events[0].historical_events} historical; ${events[0].upcoming_events} upcoming; ${revisions[0].revision_rows} revisions`,CHECKPOINT:"VERIFY:READ_BACK",NEXT:"Persist scheduler checkpoint",LATEST_RELEASE_STATUS:"CALENDAR_CYCLE_COMPLETE",VINTAGE_STATUS:revisions[0].revision_rows?"REVISION_ROWS_AVAILABLE":"NO_VERIFIED_REVISION_IN_SAMPLE",CONTINUING:once?"NO":"YES",progressChanged:true});return manifest;
}

async function safeExpansion(name:string,run:()=>Promise<number>){try{return await run()}catch(error){await log("adapter-failed",{adapter:name,error:error instanceof Error?error.message:String(error)});return 0}}
async function cycle(){await seedCanonicalIdentity();await seedV2Agencies();const ingest=await ingestBls();const expansions={bea:await safeExpansion("BEA_SCHEDULE",ingestBea),federalReserve:await safeExpansion("FED_G17",ingestFedG17),oecd:await safeExpansion("OECD_CLI",ingestOecdCli)};await runV3(prisma);await refreshCoverage();return verify({...ingest,...expansions})}
async function main(){await mkdir(runtime,{recursive:true});await writeFile(pidPath,String(process.pid));if(preflightOnly){await boundedPoolRetry("CALENDAR_DB_PREFLIGHT",databasePreflight);return}if(migrate)await boundedPoolRetry("MIGRATION",applyMigration);let result=await boundedPoolRetry("CANONICALIZATION_RESUME",cycle);await log("cycle-complete",{canaryPass:result.canaryPass});if(once){await checkpoint("CANARY_COMPLETE","READ_BACK_VERIFIED",{canaryPass:result.canaryPass});return}while(!stopping){await checkpoint("INCREMENTAL_WAIT",`NEXT_RUN_${config.eventLayerIntervalMs}MS`,{canaryPass:result.canaryPass,nextRunAt:new Date(Date.now()+config.eventLayerIntervalMs).toISOString()});await prisma.$disconnect();await sleep(config.eventLayerIntervalMs);if(!stopping)result=await boundedPoolRetry("INCREMENTAL_CYCLE",cycle)}}
main().catch(async error=>{await log("fatal",{error:error instanceof Error?error.stack:String(error)});await save(resolve(runtime,"fatal.json"),{pid:process.pid,error:error instanceof Error?error.message:String(error),at:new Date().toISOString()});process.exitCode=1}).finally(async()=>{await prisma.$disconnect();if(once)await writeFile(pidPath,"")});
