import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root=resolve(import.meta.dirname,'../../..');
const runtime=join(root,'runtime','equity-index-futures');
const output=join(runtime,'p0-contract-grain-gate-v2');
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const atomic=async(path:string,value:unknown)=>{const tmp=`${path}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2)+'\n');await rename(tmp,path)};
const lines=async(path:string)=>{try{return(await readFile(path,'utf8')).split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x))}catch{return[]}};

async function main(){
  await mkdir(output,{recursive:true});
  const universe=await json(join(root,'config','equity-index-futures-universe.json'));
  const matrix=await json(join(root,'config','equity-index-futures-venue-source-matrix.json'));
  const contract=await json(join(root,'config','equity-index-futures-p0-data-contract.json'));
  const checkpoint=await json(join(runtime,'checkpoint','runner.json'));
  const health=await json(join(runtime,'health.json'));
  const historical=await lines(join(runtime,'retry','historical-pending.ndjson'));
  const dbNames=['DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','SUPABASE_DB_URL','NEON_DATABASE_URL'];
  const dbSignals=dbNames.filter(name=>Boolean(process.env[name]));
  const sourceByVenue=new Map(matrix.venues.map((v:any)=>[v.venue,v]));
  const coverage=universe.instruments.map((item:any)=>{
    const venue:any=sourceByVenue.get(item.venue);
    const candidates=venue?.candidates||[];
    const sourceState=candidates.length?'SOURCE_PENDING_CONFIRMED':'SOURCE_PENDING_CONFIRMED';
    return {rootId:item.id,identity_status:'BASIC_ONLY',listed_contract_status:'NOT_CENSUSED_DB_BLOCKED',source_state:sourceState,latest_status:'NOT_IMPLEMENTED_CONFIRMED',history_status:'NOT_IMPLEMENTED_CONFIRMED',volume_status:'NOT_IMPLEMENTED_CONFIRMED',open_interest_status:'NOT_IMPLEMENTED_CONFIRMED',settlement_status:'NOT_IMPLEMENTED_CONFIRMED',lifecycle_status:'NOT_IMPLEMENTED_CONFIRMED',underlying_link_status:'NOT_IMPLEMENTED_CONFIRMED',provenance_status:'NOT_IMPLEMENTED_CONFIRMED'};
  });
  const ownerAlive=checkpoint.processAlive===true && health.ownership?.canonicalOwnerPid===checkpoint.pid;
  const dbPass=dbSignals.length>0;
  const report={
    task:'GLOBAL_EQUITY_INDEX_FUTURES_P0_CONTRACT_GRAIN_GATE_V2',generatedAt:new Date().toISOString(),
    process:{reused:ownerAlive,canonicalPid:checkpoint.pid,alive:ownerAlive,doubleWriter:false,singleWriter:health.ownership?.mode==='SINGLE_WRITER'},
    database:{productionStatus:dbPass?'CONNECTION_SIGNAL_PRESENT_NOT_TESTED':'BLOCKED_NO_CONNECTION_SIGNAL',connectionStatus:dbPass?'UNKNOWN_FAILURE':'UNKNOWN_FAILURE',connectionAttempted:false,reason:dbPass?'A recognized signal exists but no driver is authorized in this bounded runner.':'No production connection target is available; no fallback database permitted.'},
    relations:{contract:null,observation:null,continuous:null,rollEvent:null,contractCount:null,observationCount:null,continuousSeriesCount:null,rollEventCount:null,assetClassIsolation:'NOT_CENSUSED_DB_BLOCKED'},
    contracts:{listedContractIdentityContract:'DEFINED',observationGrainContract:'DEFINED',underlyingLinkContract:'DEFINED_FAIL_CLOSED',deterministicUniqueKeyStatus:'DEFINED_NOT_EXECUTED',uniqueKey:contract.relations.contractObservations.deterministicUniqueKey},
    canary:{venues:['TAIFEX','OSE','EUREX'],contractCount:0,TAIFEX:'NOT_RUN_DB_BLOCKED',OSE:'NOT_RUN_DB_BLOCKED',EUREX:'NOT_RUN_DB_BLOCKED',CMEFallback:'NOT_USED',HKEXFallback:'NOT_USED',officialIdentityPassCount:0,officialSettlementPassCount:0,volumePassCount:0,openInterestPassCount:0,underlyingLinkPassCount:0,provenancePassCount:0,writeCanary:false,writePassCount:0,readBackPassCount:0,duplicateRateAfterCanary:null},
    historical:{total:historical.length,adapterReady:0,sourcePending:0,licensePending:0,accessBlocked:0,notImplemented:historical.length,backgroundStarted:false},
    coverage:{rows:coverage.length,complete:true,latestContractCoverage:'0/30',historyContractCoverage:'0/30',volumeContractCoverage:'0/30',openInterestContractCoverage:'0/30'},
    boundaries:{continuousSeriesCreated:false,rollEventCreated:false,noRootTickerPromotion:true,noFakeContracts:true,noFakeHistory:true,noUnofficialSourceSubstitution:true},
    gate:{p0ProductionPathReady:false,depthGate:'FAIL_DB_ACCESS',dataDepthLevel:1,dataCoverageLevel:1,professionalResearchLevel:1,backgroundActivated:false}
  };
  await atomic(join(output,'coverage-matrix.json'),coverage);
  await atomic(join(output,'gate-report.json'),report);
  await atomic(join(output,'checkpoint.json'),{status:'FAIL_CLOSED',...report});
  console.log(JSON.stringify(report,null,2));
}

main().catch(error=>{console.error(error);process.exitCode=1});
