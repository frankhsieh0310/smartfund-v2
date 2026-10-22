/** Production smoke only. Creation of this wrapper is NOT authorization to run it.
 * Future invocation requires --execute, an explicit production DB URL, and a stable invocation ID.
 * PG_MODULE may point to an externally installed pg package; no dotenv or DB URL fallback.
 */
import { createRequire } from 'node:module';
import { Store, loadManifest, runHistory, DAY } from './yahoo-phase1.mjs';

const args=process.argv.slice(2);
const value=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
const symbols=['GC=F','CL=F','ES=F'];
const expectedIds={
  'GC=F':'35ff5db4-16ba-4392-a48e-efd96fbc485d',
  'CL=F':'ceebeb1f-3616-4d38-ab85-a7de76455d9a',
  'ES=F':'6b021e23-daf1-4510-a9c0-c329233e804a',
};
const day=ms=>new Date(ms).toISOString().slice(0,10);
const end=value('--end')??day(Date.now());
if(!/^\d{4}-\d{2}-\d{2}$/.test(end)||!Number.isFinite(Date.parse(end))||day(Date.parse(end))!==end
   ||end>day(Date.now())||end<day(Date.now()-DAY))throw Error('End must be today or yesterday UTC');
const start=day(Date.parse(end)-7*DAY);
const invocationId=value('--invocation');
const execute=args.includes('--execute');
for(let i=0;i<args.length;i++) {
  if(args[i]==='--execute')continue;
  if(['--end','--invocation'].includes(args[i])&&args[i+1]){i++;continue;}
  throw Error('Unsupported argument');
}
if(!execute) {
  console.log(JSON.stringify({mode:'PLAN_ONLY',symbols,start,end,endExclusive:true,maxRequests:3,windowDays:7,
    trueNewCreate:false,monthWrites:false,productionWriteExecuted:false}));
} else {
  if(!invocationId||!/^[A-Za-z0-9_-]{1,80}$/.test(invocationId))throw Error('Explicit stable invocation ID required');
  const url=process.env.YAHOO_FUTURES_PRODUCTION_DATABASE_URL;
  if(!url)throw Error('Explicit YAHOO_FUTURES_PRODUCTION_DATABASE_URL required');
  const require=createRequire(import.meta.url);
  const {Client}=require(process.env.PG_MODULE||'pg');
  // Keep Postgres DATE independent of workstation timezone.
  require(process.env.PG_MODULE||'pg').types.setTypeParser(1082,x=>x);
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000});
  const manifest=await loadManifest();
  const metrics={inserted:0,updated:0,unchanged:0};
  class SmokeStore extends Store {
    async transaction(fn) {
      return super.transaction(async()=>{
        await this.query("SET LOCAL statement_timeout='25s'");
        await this.query("SET LOCAL lock_timeout='5s'");
        await this.query("SELECT pg_advisory_xact_lock(hashtext('smartfund:FUTURES_YAHOO_GLOBAL_HISTORY'))::text");
        const mapped=(await this.query('SELECT yahoo_symbol,root_id FROM futures_yahoo_symbol_mappings WHERE yahoo_symbol=ANY($1) FOR UPDATE',[symbols])).rows;
        if(mapped.length!==3||mapped.some(x=>expectedIds[x.yahoo_symbol]!==x.root_id))throw Error('Production identity preflight failed');
        return fn();
      });
    }
    async metadata(record) {
      if(!symbols.includes(record.providerSymbol))throw Error('Smoke only permits the three existing HEADs');
      const id=await super.metadata(record);
      if(id!==expectedIds[record.providerSymbol])throw Error('Canonical ID changed');
      return id;
    }
    async bars(rootId,symbol,rows,fetchedAt,url) {
      if(!symbols.includes(symbol)||rootId!==expectedIds[symbol]||rows.some(r=>r.date<start||r.date>=end)||rows.length>7)
        throw Error('Outside fixed smoke scope');
      const before=(await this.query('SELECT observed_date::text AS date,retrieved_at FROM futures_root_market_observations WHERE yahoo_symbol=$1 AND observed_date >= $2 AND observed_date < $3',[symbol,start,end])).rows;
      await super.bars(rootId,symbol,rows,fetchedAt,url);
      for(const row of rows) {
        const old=before.find(x=>x.date===row.date);
        if(!old)metrics.inserted++;
        else if(Date.parse(old.retrieved_at)<Date.parse(fetchedAt))metrics.updated++;
        else metrics.unchanged++;
      }
    }
  }
  const snapshot=async()=> (await client.query(`SELECT id,root_id,yahoo_symbol,observed_date::text,open,high,low,close,volume,source_grain,retrieved_at
    FROM futures_root_market_observations WHERE yahoo_symbol=ANY($1) AND observed_date >= $2 AND observed_date < $3 ORDER BY yahoo_symbol,observed_date`,[symbols,start,end])).rows;
  try {
    await client.connect();
    const store=new SmokeStore(client);
    const options={symbols,start,end,mode:'incremental',maxRequests:3,windowDays:7,invocationId:'production-smoke-'+invocationId};
    const result=await runHistory(store,manifest,options);
    if(result.quarantined?.length || result.failures?.length)throw Error('Smoke contains quarantined symbols');
    const after=await snapshot();
    // Same invocation key must dedupe before any Yahoo request or further write.
    const rerun=await runHistory(store,manifest,options,()=>{throw Error('Dedupe attempted another Yahoo request');});
    const identical=JSON.stringify(after)===JSON.stringify(await snapshot());
    if(!rerun.skipped||!identical)throw Error('Idempotent rerun verification failed');
    console.log(JSON.stringify({symbols,start,end,result,metrics,idempotentRerun:true,trueNewCreated:false,monthWrites:false}));
  } catch {
    // Never include DB connection details or credentials in terminal output.
    console.error('PRODUCTION_SMOKE_FAILED: stop and inspect; a completed first invocation may already be committed.');
    process.exitCode=1;
  } finally {await client.end();}
}
