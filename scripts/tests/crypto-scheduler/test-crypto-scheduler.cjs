// Targeted, offline tests: production module runs against an in-memory DB/provider double.
// No credentials, network, or production database are used.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = process.env.CRYPTO_TEST_ROOT || path.resolve(__dirname, '..', '..', '..');
const ts = require(path.join(root, 'node_modules/typescript'));
const yaml = require(path.join(root, 'node_modules/js-yaml'));
const modulePath = path.join(root,'lib/cron/cryptoMarketcap.ts');
let cp=null, markets=[], runs=new Map(), leases=new Map(), observations=[], requested=[], missing=new Set(), httpFailure=false, failCommit=false;
const key = n => `yahoo-${String(n).padStart(4,'0')}-usd`;
function reset(n=501){cp=null;markets=Array.from({length:n},(_,i)=>({id:key(i),providerSymbol:`S${i}-USD`,baseAssetId:`a${i}`}));runs=new Map();leases=new Map();observations=[];requested=[];missing=new Set();httpFailure=false;failCommit=false;}
const prisma={
  cryptoMarket:{findMany:async a=>markets.filter(m=>!a.where.id||m.id>a.where.id.gt).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,a.take)},
  $queryRawUnsafe:async(sql,job,owner)=>{
    if(sql.includes('INSERT INTO production_scheduler_locks')){if(leases.has(job))return[];leases.set(job,owner);return[{owner}];}
    if(sql.includes('SELECT owner'))return leases.get(job)===owner?[{owner}]:[];
    throw Error('unexpected query '+sql);
  },
  $executeRawUnsafe:async(sql,...args)=>{
    if(sql.startsWith('DELETE FROM production_scheduler_locks')){if(leases.get(args[0])===args[1])leases.delete(args[0]);return 1;}
    if(sql.includes('WITH incoming')){let n=0;for(const v of JSON.parse(args[0])){if(!observations.some(o=>o.assetId===v.assetId&&o.observedAt>=v.observedAt)){observations.push(v);n++;}}return n;}
    if(sql.includes('INSERT INTO production_scheduler_checkpoints')){cp={lastSymbol:args[3],processed:args[4],succeeded:args[5],failed:args[6]};return 1;}
    if(sql.includes('UPDATE production_scheduler_runs')){if(failCommit)throw Error('SIMULATED_COMMIT_FAILURE');return 1;}
    throw Error('unexpected execute '+sql);
  },
  $transaction:async fn=>{const oldCp=structuredClone(cp),oldObs=structuredClone(observations);try{return await fn(prisma);}catch(e){cp=oldCp;observations=oldObs;throw e;}}
};
const context={
  beginRun:async input=>{if(runs.has(input.runKey))return{runId:runs.get(input.runKey),skipped:true};const runId=`r${runs.size}`;runs.set(input.runKey,runId);return{runId,skipped:false};},
  readCheckpoint:async()=>structuredClone(cp),finishRun:async()=>{}
};
const source=fs.readFileSync(modulePath,'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
assert.equal(compiled.diagnostics.length,0);
const moduleObject={exports:{}};
vm.runInNewContext(compiled.outputText,{module:moduleObject,exports:moduleObject.exports,
  require:n=>n==='@/lib/prisma'?{prisma}:n.includes('runContext')?context:n.includes('yahooClient')?{getAuth:async()=>({cookie:'test',crumb:'test'}),invalidateAuth:()=>{}}:(()=>{throw Error(n)})(),
  URL,Response,AbortSignal,Date,Map,Number,JSON,Error,console,crypto:require('node:crypto').webcrypto,
  fetch:async url=>{if(httpFailure)return new Response('{}',{status:429});const symbols=url.searchParams.get('symbols').split(',');assert(symbols.length<=50);requested.push(symbols);return Response.json({quoteResponse:{error:null,result:symbols.filter(s=>!missing.has(s)).map(symbol=>({symbol,marketCap:123,circulatingSupply:10,regularMarketTime:1700000000}))}});}
});
const api=moduleObject.exports;
const invoke=async id=>(await api.withCryptoLease('marketcap',owner=>api.runMarketcapSlice(owner,id))).json();
(async()=>{
  reset(); const a=await invoke('A');assert.equal(a.processed,250);assert.equal(cp.lastSymbol,key(249));assert.equal(a.wrapped,false);const count=requested.length;
  const duplicate=await invoke('A');assert.equal(duplicate.skipped,true);assert.equal(requested.length,count);assert.equal(cp.processed,250);
  const b=await invoke('B');assert.equal(b.processed,250);assert.equal(cp.lastSymbol,key(499));assert.equal(requested[count][0],'S250-USD');
  const c=await invoke('C');assert.equal(c.processed,1);assert.equal(c.wrapped,true);assert.equal(cp.lastSymbol,null);
  const d=await invoke('D');assert.equal(d.updated,0);assert.equal(d.staleSkipped,250);assert.equal(observations.length,501);
  console.log('MARKETCAP_CONTINUATION_TEST: PASS');console.log('MARKETCAP_DEDUPE_TEST: PASS');console.log('MARKETCAP_NEXT_SLICE_TEST: PASS');
  reset();await invoke('A');markets=markets.filter(m=>m.id!==key(249)&&m.id!==key(250));missing.add('S251-USD');markets.push({id:'yahoo-0000-new',providerSymbol:'NEW-USD',baseAssetId:'new'});
  const deletion=await invoke('B');assert.equal(requested[5][0],'S251-USD');assert.equal(deletion.failedMarkets.length,1);assert.equal(deletion.wrapped,true);assert.equal(cp.lastSymbol,null);
  const rotation=await invoke('C');assert(requested.flat().includes('NEW-USD'));assert.equal(rotation.processed,250);
  reset(250);assert.equal((await invoke('exact')).wrapped,true);
  reset(1);missing.add('S0-USD');assert.equal((await invoke('missing')).failedMarkets.length,1);assert.equal(cp.lastSymbol,null);assert.equal(cp.processed,1);
  reset();httpFailure=true;assert.equal((await invoke('transport')).ok,false);assert.equal(cp,null);httpFailure=false;await invoke('retry-next');assert.equal(cp.processed,250);
  reset();failCommit=true;assert.equal((await invoke('rollback')).ok,false);assert.equal(cp,null);assert.equal(observations.length,0);failCommit=false;await invoke('next');assert.equal(cp.processed,250);
  reset();leases.set('YAHOO_CRYPTO_MARKETCAP','other');assert.equal((await invoke('locked')).reason,'SKIP_LOCKED');assert.equal(requested.length,0);
  reset();const concurrent=await Promise.all([invoke('concurrent'),invoke('concurrent')]);assert.equal(concurrent.filter(r=>r.skipped).length,1);assert.equal(cp.processed,250);assert.equal(observations.length,250);
  assert.equal(api.cryptoRunKey('marketcap',0),api.cryptoRunKey('marketcap',1000));assert.notEqual(api.cryptoRunKey('marketcap',0),api.cryptoRunKey('marketcap',1800000));
  assert.equal(api.cryptoRunKey('marketcap',0,'same'),api.cryptoRunKey('marketcap',1800000,'same'));
  console.log('CURSOR_MUTATION_MISSING_STALE_ROLLBACK_LEASE_TESTS: PASS');
  const route=fs.readFileSync(path.join(root,'app/api/cron/yahoo-crypto/route.ts'),'utf8');
  const before=fs.readFileSync(path.join(__dirname,'route.before.ts'),'utf8');
  const checkpointBody=s=>s.slice(s.indexOf('  try {\n    let cursor')).replace(/\r/g,'');
  assert.equal(checkpointBody(route),checkpointBody(before));
  console.log('QUOTE_CHECKPOINT_PRESERVED: PASS');console.log('HISTORY_CHECKPOINT_PRESERVED: PASS');
  const current=fs.readFileSync(path.join(root,'.github/workflows/cloud-data-ingestion.yml'),'utf8');
  const old=yaml.load(fs.readFileSync(path.join(__dirname,'workflow.before.yml'),'utf8'));
  const next=yaml.load(current);
  assert.equal(next.on.schedule.length,old.on.schedule.length+3);
  assert.deepEqual(next.on.schedule.slice(0,old.on.schedule.length),old.on.schedule);
  assert.deepEqual(next.concurrency,old.concurrency);
  const oldSteps=old.jobs.ingest.steps.filter(s=>s.name!=='Select job');
  for(const step of oldSteps)assert.deepEqual(next.jobs.ingest.steps.find(s=>s.name===step.name),step);
  for(const phase of ['quote','marketcap','history'])assert(next.on.workflow_dispatch.inputs.job.options.includes('crypto-'+phase));
  assert(current.includes('github.run_id'));assert(!current.includes('github.run_attempt'));assert(!next.jobs.ingest.steps.find(s=>s.name==='Crypto bounded slice').run.includes('--retry'));
  console.log('SHARED_WORKFLOW_PARSE: PASS');console.log('FX_SCHEDULER_AND_EXISTING_WORKFLOW_STEPS_UNCHANGED: PASS');
})().catch(e=>{console.error(e);process.exitCode=1;});
