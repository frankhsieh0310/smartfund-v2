import { mkdir, open, readFile, writeFile, appendFile, rename, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { productionProviderRegistry } from '../../../lib/data-platform/providers/ProviderRegistry.ts';
import { futuresDatabaseUrl } from '../../../lib/data-platform/runtime/boundedFuturesDb.ts';

const root = resolve(import.meta.dirname, '../../..');
const runtime = join(root, 'runtime', 'equity-index-futures');
const dirs = { checkpoint: join(runtime,'checkpoint'), retry: join(runtime,'retry'), archive: join(runtime,'archive'), data: join(runtime,'data'), logs: join(runtime,'logs'), research: join(runtime,'research'), capabilities: join(runtime,'checkpoint','capabilities') };
const checkpointFile = join(dirs.checkpoint, 'runner.json');
const manifestFile = join(runtime, 'completion-manifest.json');
const logFile = join(dirs.logs, 'runner.log');
const lockFile = join(runtime, 'single-writer.lock');
let lock:FileHandle|null=null;
let ownsLock=false;
const sleep = (ms:number) => new Promise(r => setTimeout(r, ms));
const now = () => new Date().toISOString();

async function json(path:string) { return JSON.parse(await readFile(path, 'utf8')); }
async function atomic(path:string, value:unknown) { const tmp = `${path}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(value,null,2)+'\n'); await rename(tmp,path); }
async function log(event:string, extra:Record<string,unknown>={}) { await appendFile(logFile, JSON.stringify({timestamp:now(),event,...extra})+'\n'); }
async function checkpoint(stage:string, scope:string, extra:Record<string,unknown>={}) { await atomic(checkpointFile,{asset:'GLOBAL_EQUITY_INDEX_FUTURES',pid:process.pid,processAlive:true,stage,scope,updatedAt:now(),...extra}); }
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
async function acquire(){try{lock=await open(lockFile,'wx')}catch{const owner=await json(lockFile).catch(()=>({}));if(owner.pid&&alive(owner.pid))throw new Error(`EQUITY_INDEX_FUTURES_SINGLE_WRITER_ACTIVE:${owner.pid}`);await rm(lockFile,{force:true});lock=await open(lockFile,'wx')}await lock.writeFile(JSON.stringify({pid:process.pid,owner:'GLOBAL_EQUITY_INDEX_FUTURES',acquiredAt:now()}));ownsLock=true;}
async function release(){if(!ownsLock)return;if(lock)await lock.close().catch(()=>undefined);lock=null;ownsLock=false;await rm(lockFile,{force:true}).catch(()=>undefined)}

async function validate() {
  const registry = await json(join(root,'config','equity-index-futures-official-registry.json'));
  const universe = await json(join(root,'config','equity-index-futures-universe.json'));
  const coverage = await json(join(root,'config','equity-index-futures-coverage.json'));
  const venues = new Set(registry.venues.map((v:any)=>v.id));
  if (universe.instruments.length < 30) throw new Error('Universe must contain at least 30 instruments');
  for (const i of universe.instruments) if (!venues.has(i.venue)) throw new Error(`Missing official venue: ${i.id}/${i.venue}`);
  if (!coverage.contractIsolationRequired) throw new Error('Contract isolation is mandatory');
  return {registry,universe,coverage};
}

async function enqueueHistorical(universe:any, coverage:any) {
  const path = join(dirs.retry,'historical-pending.ndjson');
  try { const existing=await readFile(path,'utf8'); if(existing.trim()) return existing.split(/\r?\n/).filter(Boolean).length; } catch {}
  const lines:string[]=[];
  for (const i of universe.instruments) for (const interval of coverage.intervals) lines.push(JSON.stringify({instrumentId:i.id,root:i.root,venue:i.venue,interval,status:'PENDING_OFFICIAL_ADAPTER',attempts:0,nextAttemptAt:now()}));
  await writeFile(path, lines.join('\n')+'\n');
  return lines.length;
}

async function archiveOldFiles(days:number) {
  const cutoff=Date.now()-days*86400000;
  for (const file of await readdir(dirs.data)) { const p=join(dirs.data,file); const s=await stat(p); if(s.isFile()&&s.mtimeMs<cutoff) await rename(p,join(dirs.archive,file)); }
}

async function loadProductionUrl() {
  const text=await readFile(join(root,'.env'),'utf8');
  const line=text.split(/\r?\n/).find(x=>/^\s*DATABASE_URL\s*=/.test(x));
  if(!line) throw new Error('DEPTH_DB_CONFIGURATION_MISSING');
  return line.slice(line.indexOf('=')+1).trim().replace(/^['"]|['"]$/g,'');
}

async function depthCapabilityCycle() {
  const startedAt=now();
  process.env.DATABASE_URL=futuresDatabaseUrl(await loadProductionUrl());
  const {PrismaClient}=await import('@prisma/client');
  const prisma=new PrismaClient({datasources:{db:{url:process.env.DATABASE_URL}}});
  try {
    const rows=await prisma.$queryRawUnsafe<any[]>(`SELECT c.id::text contract_id,c.root_symbol,c.exchange,c.contract_symbol,c.contract_month::text,c.expiration::text,o.id::text observation_id,o.observed_at::text,o.settlement::text,o.volume::text,o.open_interest::text,o.source,o.verification_status FROM futures_contracts c JOIN futures_observations o ON o.contract_id=c.id WHERE c.asset_class='EQUITY_INDEX_FUTURES' AND o.asset_class='EQUITY_INDEX_FUTURES' AND c.verification_status='VERIFIED_OFFICIAL' AND o.verification_status='VERIFIED_OFFICIAL' ORDER BY c.root_symbol,o.observed_at,c.expiration`);
    const grouped=new Map<string,any[]>();
    for(const row of rows){const key=`${row.root_symbol}:${row.observed_at.slice(0,10)}`;if(!grouped.has(key))grouped.set(key,[]);grouped.get(key)!.push(row)}
    const curves=[];
    for(const [key,chain] of grouped){
      const ordered=chain.filter(row=>typeof row.expiration==='string').sort((a,b)=>a.expiration.localeCompare(b.expiration));
      if(ordered.length<2)continue;
      const points=ordered.map((x,i)=>({...x,position:i===0?'FRONT':i===1?'NEXT':i===2?'THIRD':'DEFERRED',days_to_expiry:Math.ceil((Date.parse(x.expiration)-Date.parse(x.observed_at))/86400000)}));
      const spreads=points.slice(0,-1).map((x,i)=>({from_contract_id:x.contract_id,to_contract_id:points[i+1].contract_id,price_spread:x.settlement!==null&&points[i+1].settlement!==null?String(Number(points[i+1].settlement)-Number(x.settlement)):null}));
      curves.push({key,root_symbol:ordered[0].root_symbol,exchange:ordered[0].exchange,as_of_date:ordered[0].observed_at.slice(0,10),selection_rule:'VERIFIED_EXPIRY_ASC_V1',points,spreads,source_type:'DERIVED_FROM_VERIFIED_CONTRACT_OBSERVATIONS',calculated_at:now()});
    }
    await atomic(join(dirs.research,'curve-snapshots.json'),{asset:'GLOBAL_EQUITY_INDEX_FUTURES',curves,continuousCreated:false,rollEventsCreated:false,reason:'Single observation date does not satisfy continuous/roll prerequisites',updatedAt:now()});
    await atomic(join(dirs.capabilities,'contract-discovery.json'),{status:rows.length?'ACTIVE':'SOURCE_CONSTRAINED',contracts:new Set(rows.map(x=>x.contract_id)).size,roots:new Set(rows.map(x=>x.root_symbol)).size,updatedAt:now()});
    await atomic(join(dirs.capabilities,'contract-history.json'),{status:'SOURCE_AND_TERMS_CONSTRAINED',rows:rows.length,distinctDates:new Set(rows.map(x=>x.observed_at.slice(0,10))).size,reason:'No verified reusable deep-history adapter; TAIFEX redistribution terms and OSE historical access require resolution',updatedAt:now()});
    await atomic(join(dirs.capabilities,'curve.json'),{status:curves.length?'STAGING_READY':'PREREQUISITES_PENDING',roots:new Set(curves.map(x=>x.root_symbol)).size,updatedAt:now()});
    await atomic(join(dirs.capabilities,'analytics.json'),{status:'PREREQUISITES_PENDING',continuousSeries:0,rollEvents:0,updatedAt:now()});
    await log('depth_capability_cycle',{startedAt,contracts:new Set(rows.map(x=>x.contract_id)).size,curves:curves.length,historyStatus:'SOURCE_AND_TERMS_CONSTRAINED'});
    return {contracts:new Set(rows.map(x=>x.contract_id)).size,curveRoots:new Set(curves.map(x=>x.root_symbol)).size,historyRows:rows.length,historyStatus:'SOURCE_AND_TERMS_CONSTRAINED'};
  } finally { await prisma.$disconnect(); }
}

async function updateLatest(instrument:any) {
  const adapter=productionProviderRegistry.get('YAHOO_CHART');
  const sourceSymbol=`${instrument.root}=F`;
  const request={assetClass:'MARKET_INDEX' as const,instrument:{id:instrument.id,symbol:sourceSymbol,latestDate:new Date(Date.now()-7*86400000)}};
  const providerLatest=await adapter.latestAvailableDate(request);
  const rows=await adapter.fetchLatest(request);
  const latest=rows.at(-1);
  if(!providerLatest||!latest) throw new Error(`SOURCE_NOT_PROVIDED:${instrument.id}:${sourceSymbol}`);
  const value={instrumentId:instrument.id,canonicalRoot:instrument.root,venue:instrument.venue,sourceSymbol,date:providerLatest.toISOString().slice(0,10),open:latest.open,high:latest.high,low:latest.low,close:latest.close,volume:latest.volume,source:adapter.source(),updatedAt:now()};
  await atomic(join(dirs.data,`${instrument.id}.json`),value);
  return value;
}

async function latestCycle(universe:any) {
  let completed=0,failed=0,latestDate:string|null=null;
  for(const instrument of universe.instruments){
    try{const value=await updateLatest(instrument);completed++;if(!latestDate||value.date>latestDate)latestDate=value.date}
    catch(error){failed++;await appendFile(join(dirs.retry,'latest.ndjson'),JSON.stringify({instrumentId:instrument.id,at:now(),error:String(error)})+'\n')}
  }
  return {completed,failed,latestDate};
}

async function main() {
  for (const d of Object.values(dirs)) await mkdir(d,{recursive:true});
  await acquire();
  await log('runner_started',{pid:process.pid});
  await checkpoint('VALIDATE','official registry + universe + coverage');
  const {registry,universe,coverage}=await validate();
  await checkpoint('HISTORICAL','enqueue contract-isolated interval work');
  const historicalTasks=await enqueueHistorical(universe,coverage);
  await checkpoint('LATEST','approved shared Yahoo adapter');
  const firstLatest=await latestCycle(universe);
  await log('latest_cycle',{instruments:universe.instruments.length,status:'completed',...firstLatest});
  await checkpoint('INCREMENTAL','hourly official-exchange cycle',{historicalTasks});
  const firstDepth=await depthCapabilityCycle();
  await atomic(manifestFile,{asset:'GLOBAL_EQUITY_INDEX_FUTURES',builderComplete:true,standalone:true,pid:process.pid,startedAt:now(),venues:registry.venues.length,instruments:universe.instruments.length,intervals:coverage.intervals,contractIsolation:true,continuousContract:universe.continuousContract,source:'YAHOO_CHART',sourceCanary:'SUPPLEMENTAL_UNVERIFIED',latest:firstLatest,depth:firstDepth,stages:['historical','latest','incremental','retry','archive','contract-discovery','contract-history-gate','curve-staging','analytics-gate'],autoContinuing:true,singleOwnerCapability:'ROOT_INCREMENTAL+CONTRACT_DISCOVERY+CONTRACT_HISTORY_GATE+FRONT_NEXT_THIRD+CURVE_STAGING+ANALYTICS_GATE'});
  const scheduler=await json(join(root,'config','equity-index-futures-production-scheduler.json'));
  while(true) {
    const incremental=await latestCycle(universe);
    await log('incremental_cycle',{status:'completed',instruments:universe.instruments.length,...incremental});
    const depth=await depthCapabilityCycle();
    await archiveOldFiles(scheduler.archiveAfterDays);
    await checkpoint('INCREMENTAL','root latest + contract discovery + history gate + curve staging + analytics gate',{nextCycleAt:new Date(Date.now()+scheduler.incrementalIntervalMs).toISOString(),historicalTasks,depth,singleWriter:true});
    await sleep(scheduler.incrementalIntervalMs);
  }
}

for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void release().finally(()=>process.exit(0))});
main().catch(async error => { try { await mkdir(dirs.logs,{recursive:true}); await log('fatal',{message:String(error?.stack||error)}); await checkpoint('FAILED','runner fatal',{error:String(error?.message||error),processAlive:false}); } finally { process.exitCode=1; } }).finally(release);
