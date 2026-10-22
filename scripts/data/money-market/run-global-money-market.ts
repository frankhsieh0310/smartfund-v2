import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { runRecovery, useRecoveryPrisma } from "./recover-money-market-depth.ts";

const ROOT = process.cwd();
const RUNTIME = path.join(ROOT, "runtime", "money-market");
const REGISTRY_PATH = path.join(ROOT, "config", "money-market-rate-registry.json");
const CHECKPOINT = path.join(RUNTIME, "checkpoint.json");
const HEARTBEAT = path.join(RUNTIME, "heartbeat.json");
const FAILURE_QUEUE = path.join(RUNTIME, "failure-queue.json");
const DEAD_LETTER = path.join(RUNTIME, "dead-letter.json");
const MANIFEST = path.join(RUNTIME, "completion-manifest.json");
const LOG = path.join(RUNTIME, "money-market.log");
const prisma = new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL??process.env.DATABASE_URL}}});
useRecoveryPrisma(prisma);
const args = new Set(process.argv.slice(2));
const once = args.has("--once") || args.has("--canary");
const canary = args.has("--canary");
const selectedSeries = process.argv.find(value => value.startsWith("--series="))?.slice(9) || "SOFR";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; } }
async function atomic(file, value) { await mkdir(path.dirname(file), {recursive:true}); const temp = `${file}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(value, null, 2)); await rename(temp, file); }
async function log(message) { await appendFile(LOG, `${now()} ${message}\n`); }
async function state(value) { const previous=await readJson(CHECKPOINT,{}); await atomic(CHECKPOINT, {...previous,asset:"GLOBAL_MONEY_MARKET_RATES", pid:process.pid, updatedAt:now(), autoContinuing:!once, ...value}); await atomic(HEARTBEAT, {pid:process.pid, alive:true, at:now(), stage:value.currentStage || "UNKNOWN"}); }

function isoDate(value) {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0,10);
  const date = new Date(raw); return Number.isNaN(date.valueOf()) ? null : date.toISOString().slice(0,10);
}
function numberValue(value) { const n = Number(String(value ?? "").replace(/[% ,]/g,"")); return Number.isFinite(n) ? n : null; }
function normalize(records, series, publishedAt) {
  const seen = new Set();
  return records.map((r) => ({date:isoDate(r.date), value:numberValue(r.value), source:series.sourceUrl, published_at:r.published_at || publishedAt}))
    .filter((r) => r.date && r.value !== null && !seen.has(`${r.date}|${r.value}`) && seen.add(`${r.date}|${r.value}`))
    .sort((a,b) => a.date.localeCompare(b.date));
}
function parseNyFed(body) {
  const data = JSON.parse(body); const rows = data.refRates || data.rates || data.data || [];
  return rows.map((r) => ({date:r.effectiveDate || r.effective_date || r.date, value:r.percentRate ?? r.rate ?? r.value, published_at:r.publicationDate || r.publication_date}));
}
function parseCsv(body, series) {
  const lines = body.replace(/^\uFEFF/,"").split(/\r?\n/).filter(Boolean); if (lines.length < 2) return [];
  const split = (line) => { const out=[]; let token="", quoted=false; for (const c of line) { if(c==='"') quoted=!quoted; else if(c===','&&!quoted){out.push(token);token="";} else token+=c; } out.push(token); return out; };
  const header=split(lines[0]).map((x)=>x.trim().toLowerCase());
  const dateIndex=header.findIndex((x)=>/date|time_period/.test(x));
  let valueIndex=header.findIndex((x)=>x===series.code.toLowerCase() || /obs_value|value|rate/.test(x)); if(valueIndex<0) valueIndex=1;
  return lines.slice(1).map(split).map((r)=>({date:r[dateIndex<0?0:dateIndex],value:r[valueIndex]}));
}
function parseOfficialPage(body, series) {
  const text=body.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/\s+/g," ");
  const pattern=/((?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01]))[^\d-]{0,80}(-?\d{1,2}(?:\.\d{1,6})?)/g;
  return [...text.matchAll(pattern)].map((m)=>({date:m[1],value:m[2]}));
}
function urlFor(series, stage, checkpoint) {
  if(series.adapter!=="new-york-fed") return series.sourceUrl;
  const end=new Date().toISOString().slice(0,10); let start=series.historyStart;
  if(stage!=="HISTORICAL") start=checkpoint?.series?.[series.code]?.lastDate || new Date(Date.now()-14*86400000).toISOString().slice(0,10);
  return `${series.sourceUrl}?startDate=${start}&endDate=${end}&type=rate`;
}
async function canonicalWrite(series, records, stage) {
  const canonical=await prisma.economicSeries.upsert({where:{provider_seriesId:{provider:series.administrator,seriesId:series.code}},create:{provider:series.administrator,seriesId:series.code,code:series.code,name:series.name,description:series.benchmarkType,country:series.country,category:"MONEY_MARKET_RATE",frequency:"DAILY",unit:series.unit,source:series.administrator,apiUrl:series.sourceUrl,lastUpdate:new Date(`${records.at(-1).date}T00:00:00Z`)},update:{name:series.name,country:series.country,category:"MONEY_MARKET_RATE",frequency:"DAILY",unit:series.unit,source:series.administrator,apiUrl:series.sourceUrl,lastUpdate:new Date(`${records.at(-1).date}T00:00:00Z`)}});
  const latest=await prisma.economicValue.findFirst({where:{seriesId:canonical.id},orderBy:{date:"desc"},select:{date:true}});
  let pending;
  if(stage==="HISTORICAL") {
    const existing=await prisma.economicValue.findMany({where:{seriesId:canonical.id,date:{in:records.map(record=>new Date(`${record.date}T00:00:00Z`))}},select:{date:true}});
    const dates=new Set(existing.map(row=>row.date.toISOString().slice(0,10)));
    pending=records.filter(record=>!dates.has(record.date));
  } else {
    pending=records.filter(record=>!latest||new Date(`${record.date}T00:00:00Z`)>latest.date);if(!pending.length)pending=[records.at(-1)];if(!latest)pending=[records.at(-1)];
  }
  for(const record of pending){const date=new Date(`${record.date}T00:00:00Z`),checksum=createHash("sha256").update(`${series.code}|${record.date}|${record.value}|${series.sourceUrl}`).digest("hex");await prisma.economicValue.upsert({where:{seriesId_date:{seriesId:canonical.id,date}},create:{seriesId:canonical.id,date,value:record.value,sourceUrl:series.sourceUrl,sourceVersion:"money-market-v1",rawChecksum:checksum,importedAt:new Date()},update:{value:record.value,sourceUrl:series.sourceUrl,sourceVersion:"money-market-v1",rawChecksum:checksum,importedAt:new Date()}});}
  const observation=records.at(-1),verified=await prisma.economicValue.findUnique({where:{seriesId_date:{seriesId:canonical.id,date:new Date(`${observation.date}T00:00:00Z`)}}});if(!verified||verified.value?.toString()!==String(observation.value))throw new Error("CANONICAL_READ_BACK_FAILED");return {seriesId:canonical.id,lastDate:observation.date,value:verified.value.toString(),source:series.administrator,written:pending.length};
}
async function fetchSeries(series, stage, checkpoint) {
  if(series.adapter==="source-pending") return {code:series.code,ok:false,error:`NON_RETRYABLE:${series.sourceState||"SOURCE_PENDING"}`,attempts:0,stage,at:now(),retryable:false};
  const url=urlFor(series,stage,checkpoint); let lastError="";
  for(let attempt=1;attempt<=3;attempt++) {
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),30000);
    try {
      const response=await fetch(url,{signal:controller.signal,redirect:"follow",headers:{accept:"application/json,text/csv,text/html", "user-agent":"SmartFund Money Market Builder/1.0"}});
      if(!response.ok) throw new Error(`HTTP ${response.status}`); const body=await response.text(); const publishedAt=now();
      const raw=series.adapter==="new-york-fed"?parseNyFed(body):series.adapter.endsWith("csv")?parseCsv(body,series):parseOfficialPage(body,series);
      const records=normalize(raw,series,publishedAt); if(!records.length) throw new Error("NO_PARSEABLE_OFFICIAL_RECORDS"); const canonical=await canonicalWrite(series,records,stage);
      const dir=path.join(RUNTIME,"staging",series.code); await mkdir(dir,{recursive:true});
      await atomic(path.join(dir,`${stage.toLowerCase()}.json`),{series:series.code,stage,fetchedAt:publishedAt,records});
      await atomic(path.join(RUNTIME,"latest",`${series.code}.json`),records.at(-1));
      return {code:series.code,ok:true,count:records.length,lastDate:canonical.lastDate,canonicalWrite:"PASS",readBack:"PASS",canonical,attempt};
    } catch(error) { lastError=String(error); if(attempt<3) await sleep(attempt*1000); } finally { clearTimeout(timer); }
  }
  return {code:series.code,ok:false,error:lastError,attempts:3,stage,at:now()};
}
async function runStage(stage, series, checkpoint) {
  await state({currentStage:stage,currentScope:canary?"SOFR_CANARY":"OFFICIAL_REGISTRY",status:"RUNNING",completed:0,total:series.length});
  const results=[]; for(const item of series) { const result=await fetchSeries(item,stage,checkpoint); results.push(result); checkpoint.series ||= {}; if(result.ok) checkpoint.series[item.code]={lastDate:result.lastDate,lastSuccessAt:now()}; await state({currentStage:stage,currentScope:item.code,status:"RUNNING",completed:results.length,total:series.length,series:checkpoint.series}); }
  const failed=results.filter((r)=>!r.ok); const oldDead=await readJson(DEAD_LETTER,{items:[]});
  await atomic(FAILURE_QUEUE,{updatedAt:now(),boundedRetries:3,items:failed});
  await atomic(DEAD_LETTER,{updatedAt:now(),items:[...oldDead.items,...failed].slice(-500)});
  await log(`${stage} success=${results.length-failed.length} failed=${failed.length}`); return results;
}
async function main() {
  await mkdir(path.join(RUNTIME,"latest"),{recursive:true}); await mkdir(path.join(RUNTIME,"staging"),{recursive:true});
  const registry=await readJson(REGISTRY_PATH,{series:[]}); const active=registry.series.filter((s)=>s.active && (!canary || s.code===selectedSeries)); let checkpoint=await readJson(CHECKPOINT,{series:{}});
  await log(`START pid=${process.pid} mode=${canary?"CANARY":once?"ONCE":"STANDALONE"} scope=${active.length}`);
  if(args.has("--recover-depth")) { await state({currentStage:"ARCHIVE_RECONCILIATION",currentScope:"8_SOURCE_READY_SERIES",status:"RUNNING"}); await runRecovery(); await state({currentStage:"DEPTH_RECOVERY_COMPLETE",currentScope:"8_SOURCE_READY_SERIES",status:"COMPLETE"}); }
  if(canary) { const results=await runStage("CANARY",active,checkpoint); const passed=results.length===1&&results[0].ok; await state({currentStage:passed?"CANARY_COMPLETE":"CANARY_FAILED",currentScope:selectedSeries,status:passed?"COMPLETE":"FAILED",canaryResult:results}); if(!passed) process.exitCode=2; return; }
  if(!checkpoint.historicalCompletedAt) { await runStage("HISTORICAL",active,checkpoint); checkpoint.historicalCompletedAt=now(); await atomic(CHECKPOINT,{...checkpoint,asset:"GLOBAL_MONEY_MARKET_RATES",pid:process.pid,updatedAt:now()}); }
  await runStage("LATEST",active,checkpoint);
  await atomic(MANIFEST,{asset:"GLOBAL_MONEY_MARKET_RATES",registryCount:active.length,historicalCompletedAt:checkpoint.historicalCompletedAt,latestCompletedAt:now(),sourcePolicy:"OFFICIAL_ONLY",storage:"runtime/money-market/staging",productionDbFallback:true,capabilities:["Historical","Latest","Incremental","Bounded Retry","Checkpoint","Resume","Failure Queue","Dedup","Dead Letter"]});
  if(once) { await state({currentStage:"COMPLETE",currentScope:"ALL",status:"COMPLETE",series:checkpoint.series}); return; }
  while(true) { const nextRunAt=new Date(Date.now()+86400000).toISOString(); await state({currentStage:"INCREMENTAL_WAIT",currentScope:"ALL",status:"WAIT",nextRunAt,series:checkpoint.series}); await sleep(86400000); await runStage("INCREMENTAL",active,checkpoint); }
}
main().catch(async(error)=>{ await log(`FATAL ${String(error)}`); await state({currentStage:"FAILED",currentScope:"RUNNER",status:"FAILED",error:String(error)}); process.exitCode=1; }).finally(()=>prisma.$disconnect());
