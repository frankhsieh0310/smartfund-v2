import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const runtime = join(root, 'runtime', 'equity-index-futures');
const outDir = join(runtime, 'p0-recovery');
const json = async (path:string) => JSON.parse(await readFile(path, 'utf8'));
const atomic = async (path:string, value:unknown) => { const tmp=`${path}.${process.pid}.tmp`; await writeFile(tmp,JSON.stringify(value,null,2)+'\n'); await rename(tmp,path); };
const now = () => new Date().toISOString();

function classifyHistorical(task:any) {
  if (task.status === 'PENDING_OFFICIAL_ADAPTER') return 'ADAPTER_NOT_IMPLEMENTED';
  return 'OTHER_VERIFIED';
}

function classifyLatest(error:string) {
  if (/SOURCE_NOT_PROVIDED/.test(error)) return 'SYMBOL_MAPPING';
  if (/429|timeout|network|fetch/i.test(error)) return 'TRANSIENT_NETWORK';
  if (/license/i.test(error)) return 'LICENSE';
  return 'OTHER_VERIFIED';
}

async function lines(path:string) {
  try { return (await readFile(path,'utf8')).split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x)); }
  catch { return []; }
}

async function main() {
  await mkdir(outDir,{recursive:true});
  const universe=await json(join(root,'config','equity-index-futures-universe.json'));
  const sourceMatrix=await json(join(root,'config','equity-index-futures-venue-source-matrix.json'));
  const dataContract=await json(join(root,'config','equity-index-futures-p0-data-contract.json'));
  const historical=await lines(join(runtime,'retry','historical-pending.ndjson'));
  const latest=await lines(join(runtime,'retry','latest.ndjson'));
  const historicalByBlocker=Object.groupBy(historical,classifyHistorical);
  const latestLatest=new Map<string,any>(); for(const item of latest) latestLatest.set(item.instrumentId,item);
  const latestByBlocker=Object.groupBy([...latestLatest.values()],x=>classifyLatest(String(x.error||'')));
  const dbSignals=['DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','SUPABASE_DB_URL','NEON_DATABASE_URL'].filter(n=>Boolean(process.env[n]));
  const gate={
    productionDbReality: dbSignals.length ? 'CONNECTION_SIGNAL_PRESENT_NOT_CENSUSED' : 'BLOCKED_NO_CONNECTION_SIGNAL',
    productRootIdentity: 'PARTIAL_BASIC_ONLY', listedContractMaster:'BLOCKED_PRODUCTION_DB', contractSpecification:'BLOCKED_SOURCE_VERIFICATION',
    underlyingLink:'EXPLICIT_UNRESOLVED', currentContractPath:'BLOCKED_LISTED_CONTRACT_MASTER', historyContractPath:'BLOCKED_LISTED_CONTRACT_MASTER',
    settlementContract:'BLOCKED_LISTED_CONTRACT_MASTER', volumeOiContract:'BLOCKED_LISTED_CONTRACT_MASTER', lifecycle:'BLOCKED_LISTED_CONTRACT_MASTER',
    continuousContract:'BLOCKED_NO_MULTIPLE_VERIFIED_CONTRACTS', rollAudit:'BLOCKED_NO_REAL_ROLL', freshness:'CONTRACT_DEFINED_NOT_IMPLEMENTED',
    provenance:'CONTRACT_DEFINED_NOT_IMPLEMENTED', coverageMatrix:'PARTIAL', detail:'FAIL', search:'PARTIAL', screener:'FAIL', compare:'FAIL', ranking:'FAIL',
    p0ProductionPathReady:false, depthGate:'FAIL'
  };
  const report={asset:'GLOBAL_EQUITY_INDEX_FUTURES',mode:'BOUNDED_P0_RECOVERY_PREFLIGHT',generatedAt:now(),writeCanary:false,backgroundActivated:false,singleWriterPreserved:true,rootCount:universe.instruments.length,canonicalGrain:dataContract.canonicalGrain,sourceDiscovery:{venues:sourceMatrix.venues.filter((v:any)=>v.batch===1).map((v:any)=>v.venue),candidateLimit:2},queueRootCause:{historicalTotal:historical.length,historicalByBlocker:Object.fromEntries(Object.entries(historicalByBlocker).map(([k,v])=>[k,(v as any[]).length])),latestDistinct:latestLatest.size,latestByBlocker:Object.fromEntries(Object.entries(latestByBlocker).map(([k,v])=>[k,(v as any[]).length]))},gate};
  await atomic(join(outDir,'preflight.json'),report);
  await atomic(join(outDir,'checkpoint.json'),{...report,status:'STOPPED_AT_GATE',reason:'Production DB reality and listed-contract identity are prerequisites; no fake contracts or root-history promotion permitted.'});
  console.log(JSON.stringify(report,null,2));
}

main().catch(error=>{console.error(error);process.exitCode=1});
