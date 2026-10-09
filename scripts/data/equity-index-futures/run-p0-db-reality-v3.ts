import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root=resolve(import.meta.dirname,'../../..');
const output=join(root,'runtime','equity-index-futures','p0-db-listed-contract-canary-v3');
const atomic=async(path:string,value:unknown)=>{const tmp=`${path}.${process.pid}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2)+'\n');await rename(tmp,path)};

function loadDatabaseUrl(text:string){
  const line=text.split(/\r?\n/).find(x=>/^\s*DATABASE_URL\s*=/.test(x));
  if(!line)return null;
  return line.slice(line.indexOf('=')+1).trim().replace(/^['"]|['"]$/g,'');
}

function classify(error:any){
  const s=String(error?.message||error);
  if(/password authentication|authentication failed|P1000/i.test(s))return'AUTH_FAILURE';
  if(/P1001|can't reach database|ECONNREFUSED|ETIMEDOUT/i.test(s))return'DATABASE_UNREACHABLE';
  if(/ENOTFOUND|EAI_AGAIN|dns/i.test(s))return'DNS_FAILURE';
  if(/certificate|TLS|SSL/i.test(s))return'TLS_FAILURE';
  if(/P1013|invalid.*connection|string.*invalid/i.test(s))return'CONNECTION_STRING_INVALID';
  if(/too many connections|connection limit/i.test(s))return'CONNECTION_LIMIT';
  if(/pool|pgbouncer/i.test(s))return'POOLER_FAILURE';
  if(/PrismaClientInitializationError|P10\d\d/i.test(s))return'PRISMA_INITIALIZATION_ERROR';
  return'OTHER_VERIFIED_CAUSE';
}

async function main(){
  await mkdir(output,{recursive:true});
  const url=loadDatabaseUrl(await readFile(join(root,'.env'),'utf8'));
  if(!url){const report={connectionPass:false,rootCause:'ENV_CONFIGURATION_ERROR'};await atomic(join(output,'db-reality.json'),report);console.log(JSON.stringify(report));return}
  process.env.DATABASE_URL=url;
  const {PrismaClient}=await import('@prisma/client');
  const prisma=new PrismaClient();
  const started=Date.now();
  try{
    const result=await prisma.$transaction(async(tx:any)=>{
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const identity=await tx.$queryRawUnsafe("SELECT current_database() AS database_name, current_schema() AS schema_name, version() AS server_version");
      const relations=await tx.$queryRawUnsafe("SELECT table_schema, table_name FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema') AND (lower(table_name) LIKE '%future%' OR lower(table_name) LIKE '%continuous%' OR lower(table_name) LIKE '%roll%') ORDER BY table_schema, table_name LIMIT 100");
      const columns=await tx.$queryRawUnsafe("SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') AND (lower(table_name) LIKE '%future%' OR lower(table_name) LIKE '%continuous%' OR lower(table_name) LIKE '%roll%') ORDER BY table_schema, table_name, ordinal_position LIMIT 1000");
      const contractCounts=await tx.$queryRawUnsafe("SELECT COALESCE(asset_class,'<NULL>') AS asset_class, count(*)::text AS row_count FROM public.futures_contracts GROUP BY asset_class ORDER BY asset_class");
      const observationCounts=await tx.$queryRawUnsafe("SELECT COALESCE(asset_class,'<NULL>') AS asset_class, count(*)::text AS row_count FROM public.futures_observations GROUP BY asset_class ORDER BY asset_class");
      const continuousCount=await tx.$queryRawUnsafe("SELECT count(*)::text AS row_count FROM public.futures_continuous_series s JOIN public.futures_product_roots r ON r.id=s.root_id WHERE r.asset_class='EQUITY_INDEX_FUTURES'");
      const rollCount=await tx.$queryRawUnsafe("SELECT count(*)::text AS row_count FROM public.futures_roll_events e JOIN public.futures_continuous_series s ON s.id=e.continuous_series_id JOIN public.futures_product_roots r ON r.id=s.root_id WHERE r.asset_class='EQUITY_INDEX_FUTURES'");
      const indexes=await tx.$queryRawUnsafe("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('futures_contracts','futures_observations') ORDER BY tablename,indexname");
      const equityContracts=await tx.$queryRawUnsafe("SELECT id::text, exchange, root_symbol, contract_symbol, contract_month::text, expiration::text, currency, underlying, status, source, verification_status, source_url FROM public.futures_contracts WHERE asset_class='EQUITY_INDEX_FUTURES' ORDER BY exchange,contract_symbol LIMIT 10");
      const equityObservations=await tx.$queryRawUnsafe("SELECT o.contract_id::text, c.exchange, c.contract_symbol, o.observed_at::text, o.settlement::text, o.open::text, o.high::text, o.low::text, o.close::text, o.volume::text, o.open_interest::text, o.source, o.source_record_id, o.verification_status, o.source_url, o.retrieved_at::text, o.parser_version, o.source_checksum, o.quality_status FROM public.futures_observations o JOIN public.futures_contracts c ON c.id=o.contract_id WHERE o.asset_class='EQUITY_INDEX_FUTURES' ORDER BY c.exchange,c.contract_symbol,o.observed_at LIMIT 20");
      const required={
        futures_contracts:['asset_class','exchange','root_id','contract_symbol','contract_month','expiration','currency','status','source','verification_status','source_url'],
        futures_observations:['contract_id','observed_at','settlement','open','high','low','close','volume','open_interest','source','source_record_id','verification_status']
      };
      const byTable=new Map<string,Set<string>>();for(const c of columns as any[]){if(!byTable.has(c.table_name))byTable.set(c.table_name,new Set());byTable.get(c.table_name)!.add(c.column_name)}
      const missing=Object.fromEntries(Object.entries(required).map(([t,names])=>[t,names.filter(n=>!byTable.get(t)?.has(n))]));
      const schemaCompatibility=(missing.futures_contracts.length||missing.futures_observations.length||!byTable.get('futures_contracts')?.has('underlying_id'))?'ADDITIVE_EXTENSION_REQUIRED':'SCHEMA_COMPATIBLE';
      return{identity,relations:relations.map((x:any)=>`${x.table_schema}.${x.table_name}`),contractCounts,observationCounts,continuousCount,rollCount,indexes,equityContracts,equityObservations,missingRequiredColumns:missing,canonicalUnderlyingIdPresent:Boolean(byTable.get('futures_contracts')?.has('underlying_id')),schemaCompatibility};
    },{timeout:10000});
    const report={connectionPass:true,rootCause:null,readLatencyMs:Date.now()-started,...result};
    await atomic(join(output,'db-reality.json'),report);
    console.log(JSON.stringify(report,null,2));
  }catch(error:any){
    const report={connectionPass:false,rootCause:classify(error),readLatencyMs:Date.now()-started,errorCode:error?.code||null,errorClass:error?.name||null};
    await atomic(join(output,'db-reality.json'),report);
    console.log(JSON.stringify(report,null,2));
  }finally{await prisma.$disconnect()}
}

main().catch(error=>{console.error(error);process.exitCode=1});
