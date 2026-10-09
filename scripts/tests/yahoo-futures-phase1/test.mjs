import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Store, loadManifest, ingestMetadata, runHistory, parseChart, reconcileHead, BZ_CANONICAL_ID, TRUE_NEW_HEADS, runLiveHistory, repairHistoryRun, futuresHealth } from '../../data/futures/yahoo-phase1.mjs';
const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const store = new Store(db), manifest = await loadManifest();
const migration = async name => readFile(new URL('../../../prisma/migrations/'+name+'/migration.sql',import.meta.url),'utf8');
// Execute the actual existing repository migrations in this disposable database only.
for (const name of ['20260729090000_add_production_scheduler_state','20260729093000_add_daily_engine_lifecycle','20260801090000_exchange_aware_daily_scheduler','20260809162500_add_futures_canonical','20260810150000_commodity_futures_p0_depth_recovery']) await db.exec(await migration(name));
await db.exec('ALTER TABLE futures_product_roots ALTER COLUMN commodity_id DROP NOT NULL');
for(const name of ['20260816223000_futures_yahoo_root_history','20260816231500_futures_yahoo_full_universe']) await db.exec(await migration(name));
const fixtures=JSON.parse(await readFile(new URL('./fixtures.json',import.meta.url),'utf8'));
const symbols=['GC=F','SI=F','HG=F'];
let requests=0;
const fetcher=async(symbol,from,to)=>{requests++;return {body:fixtures[symbol],fetchedAt:'2026-09-14T15:00:00Z',url:'fixture://'+symbol};};
const count=async table=>Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
try {
  const venue=x=>({CMX:'COMEX',NYM:'NYMEX',CBT:'CBOT',NYB:'ICE'})[x]??x;
  const ids=new Map();
  for(const h of manifest.heads.filter(h=>!TRUE_NEW_HEADS.has(h.providerSymbol))) {
    const id=h.providerSymbol==='BZ=F'?BZ_CANONICAL_ID:randomUUID();ids.set(h.providerSymbol,id);
    const exchange=h.providerSymbol==='BZ=F'?'ICE':venue(h.exchange);
    const klass=h.providerSymbol==='BZ=F'?'ENERGY_FUTURES':h.category==='Treasury'?'INTEREST_RATE_FUTURES':h.category==='Equity'?'EQUITY_INDEX_FUTURES':'COMMODITY_FUTURES';
    await db.query(`INSERT INTO futures_product_roots(id,commodity_id,asset_class,official_product_name,root_symbol,exchange,currency,timezone,status,source,verification_status,license_status)
      VALUES($1,NULL,$2,$3,$4,$5,'USD','America/New_York','ACTIVE','YAHOO_FINANCE','VERIFIED','PUBLIC_DELAYED')`,[id,klass,h.name,h.root,exchange]);
    await db.query(`INSERT INTO futures_yahoo_symbol_mappings(id,root_id,yahoo_symbol,category,exchange,mapping_status,source_url,field_disposition)
      VALUES($1,$2,$3,$4,$5,'VERIFIED_YAHOO_EXACT',$6,'{"legacyEvidence":"preserve"}'::jsonb)`,[randomUUID(),id,h.providerSymbol,h.category,exchange,'https://query1.finance.yahoo.com/v8/finance/chart/'+encodeURIComponent(h.providerSymbol)]);
  }
  const rootsBefore=(await db.query('SELECT * FROM futures_product_roots ORDER BY id')).rows;
  for(const h of manifest.heads.filter(h=>!TRUE_NEW_HEADS.has(h.providerSymbol)))assert.equal(await store.transaction(()=>store.metadata(h)),ids.get(h.providerSymbol));
  assert.deepEqual((await db.query('SELECT * FROM futures_product_roots ORDER BY id')).rows,rootsBefore);
  const unchanged=(await db.query("SELECT field_disposition FROM futures_yahoo_symbol_mappings WHERE yahoo_symbol='ES=F'")).rows[0].field_disposition;
  assert.equal(unchanged.legacyEvidence,'preserve');assert.equal(unchanged.phase1,undefined);
  for(const h of manifest.heads.filter(h=>TRUE_NEW_HEADS.has(h.providerSymbol))) assert.equal(reconcileHead(h,null),'TRUE_NEW');
  const bz=manifest.heads.find(h=>h.providerSymbol==='BZ=F');
  assert.equal(reconcileHead(bz,null),'QUARANTINE');
  const bzState=(await db.query('SELECT * FROM futures_yahoo_symbol_mappings WHERE yahoo_symbol=$1',['BZ=F'])).rows[0];
  await db.query('UPDATE futures_yahoo_symbol_mappings SET root_id=$1 WHERE yahoo_symbol=$2',[ids.get('GC=F'),'BZ=F']);
  let bzFetches=0;
  const quarantined=await runHistory(store,manifest,{start:'2026-09-09',end:'2026-09-10',symbols:['BZ=F','GC=F'],invocationId:'bz-quarantine'},async(s,...rest)=>{assert.notEqual(s,'BZ=F');bzFetches++;return fetcher(s,...rest);});
  assert.deepEqual(quarantined.quarantined,['BZ=F']);assert.equal(bzFetches,1);
  await db.query('UPDATE futures_yahoo_symbol_mappings SET root_id=$1 WHERE yahoo_symbol=$2',[bzState.root_id,'BZ=F']);
  // Keep the write/resume demo independent of the quarantine test's single fixture bar.
  await db.query('DELETE FROM futures_root_market_observations');
  console.log('CANONICAL_REUSE_ALIAS_CLASS_MISSING_PHASE1_TRUE_NEW_BZ: PASS (32 reused, zero duplicate roots)');
  for(let i=0;i<35;i+=25) await ingestMetadata(store,manifest.heads.slice(i,i+25));
  assert.equal(await count('futures_yahoo_symbol_mappings'),35);
  assert.equal(await count('futures_contracts'),0); // HEAD is never a month contract.
  const head=(await db.query("SELECT field_disposition FROM futures_yahoo_symbol_mappings WHERE yahoo_symbol='GC=F'")).rows[0].field_disposition;
  assert.equal(head.yahooPhase1Provider.activeContract,'GCZ26.CMX');assert.equal(head.yahooPhase1Provider.adjustmentStatus,'NOT_ESTABLISHED');
  assert.equal(await count('futures_product_roots'),35);requests=0;
  console.log('HEAD_MASTER_INGEST_TEST: PASS');
  const base={start:'2026-09-09',end:'2026-09-14',symbols,maxRequests:1,windowDays:2};
  const a=await runHistory(store,manifest,{...base,invocationId:'a'},fetcher);
  assert.deepEqual(a.checkpoint,{symbol:'GC=F',date:'2026-09-11'});
  assert.equal(await count('futures_root_market_observations'),2);
  const duplicate=await runHistory(store,manifest,{...base,invocationId:'a'},fetcher);
  assert.equal(duplicate.skipped,true);assert.equal(requests,1);
  const b=await runHistory(new Store(db),manifest,{...base,invocationId:'b'},fetcher);
  assert.equal(b.windows[0].from,'2026-09-11');
  for(let i=0;i<10;i++){const r=await runHistory(new Store(db),manifest,{...base,invocationId:'rest-'+i},fetcher);if(r.done||r.skipped)break;}
  assert.equal(await count('futures_root_market_observations'),9);
  console.log('HISTORY_WRITE_TEST: PASS (3 symbols, 9 persisted rows)');
  console.log('HISTORY_RESUME_TEST: PASS (persisted symbol/date cursor)');
  const retry=await runHistory(store,manifest,{...base,invocationId:'complete-retry'},fetcher);
  assert.equal(retry.skipped,true);assert.equal(await count('futures_root_market_observations'),9);
  console.log('HISTORY_IDEMPOTENT_TEST: PASS');
  const revised=structuredClone(fixtures['GC=F']);revised.chart.result[0].indicators.quote[0].volume[2]=123456;
  const inc=await runHistory(store,manifest,{start:'2026-09-01',end:'2026-09-14',symbols,mode:'incremental',invocationId:'incremental',windowDays:7},async(s)=>({body:s==='GC=F'?revised:fixtures[s],fetchedAt:'2026-09-14T16:00:00Z',url:'fixture://revision'}));
  assert.equal(inc.windows[0].from,'2026-09-08');assert.equal(await count('futures_root_market_observations'),9);
  assert.equal(Number((await db.query("SELECT volume FROM futures_root_market_observations WHERE yahoo_symbol='GC=F' AND observed_date='2026-09-11'")).rows[0].volume),123456);
  const root=(await db.query("SELECT root_id FROM futures_yahoo_symbol_mappings WHERE yahoo_symbol='GC=F'")).rows[0].root_id;
  await store.bars(root,'GC=F',parseChart(fixtures['GC=F'],'GC=F','2026-09-09','2026-09-14'),'2026-09-14T14:00:00Z','fixture://stale');
  assert.equal(Number((await db.query("SELECT volume FROM futures_root_market_observations WHERE yahoo_symbol='GC=F' AND observed_date='2026-09-11'")).rows[0].volume),123456);
  const staleChart=structuredClone(fixtures['GC=F']);staleChart.chart.result[0].meta.regularMarketTime=1;
  const staleResult=await runHistory(store,manifest,{start:'2026-09-08',end:'2026-09-14',symbols:['GC=F'],invocationId:'stale-source'},async()=>({body:staleChart,fetchedAt:'2026-09-14T17:00:00Z',url:'fixture://stale-source'}));
  assert.match(staleResult.failures[0].reason,/Stale Yahoo/);
  await db.query("UPDATE futures_root_market_observations SET source_grain='OTHER_SERIES' WHERE yahoo_symbol='GC=F' AND observed_date='2026-09-09'");
  await assert.rejects(store.bars(root,'GC=F',parseChart(fixtures['GC=F'],'GC=F','2026-09-09','2026-09-10'),'2026-09-14T18:00:00Z','fixture://conflict'),/semantics/);
  await db.query("UPDATE futures_root_market_observations SET source_grain='YAHOO_HEAD_SERIES_ADJUSTMENT_UNKNOWN' WHERE yahoo_symbol='GC=F' AND observed_date='2026-09-09'");
  console.log('HISTORY_INCREMENTAL_TEST: PASS (overlap revision + stale source/fetch + semantic conflict protection)');
  const cpBefore=await count('production_scheduler_checkpoints');
  let active=0,peak=0;
  const isolated=await runHistory(store,manifest,{start:'2026-09-10',end:'2026-09-14',symbols,invocationId:'failure'},async(s)=>{
    active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;
    if(s==='SI=F')throw Error('simulated interruption');return fetcher(s);
  });
  assert.equal(peak,2);assert.equal(isolated.requests,3);
  assert.deepEqual(isolated.quarantined,['SI=F']);assert.equal(isolated.windows.length,2);
  assert.equal(await count('production_scheduler_checkpoints'),cpBefore+1);
  const failureCp=(await db.query('SELECT failed FROM production_scheduler_checkpoints WHERE run_id=$1',[isolated.runId])).rows[0];
  assert.equal(failureCp.failed,1);
  const repeat=await runHistory(store,manifest,{start:'2026-09-10',end:'2026-09-14',symbols,invocationId:'failure'},()=>{throw Error('unexpected fetch')});assert.equal(repeat.skipped,true);
  console.log('BOUNDED_CONCURRENCY_FAILURE_ISOLATION_DEDUPE: PASS');
  await assert.rejects(runHistory(store,manifest,{...base,symbols:['GCZ26.CMX'],invocationId:'month'},fetcher));
  await assert.rejects(runHistory(store,manifest,{...base,maxRequests:4,invocationId:'large'},fetcher));
  await assert.rejects(ingestMetadata(store,manifest.months.slice(0,1)),/Month metadata reconciliation deferred/);
  assert.equal(await count('futures_contracts'),0);
  assert.equal((await db.query("SELECT count(*) AS n FROM futures_root_market_observations WHERE source_grain='VENDOR_CONTINUOUS_ROOT_SERIES'")).rows[0].n,8);
  // One row was intentionally retagged to the prior local label: both labels update in place, never a second series.
  assert.equal(await count('futures_root_market_observations'),9);
  console.log('SAME_SERIES_UPSERT_AND_MONTH_WRITE_DEFERRED: PASS');
  // Revisions may restore source values once; a second daily check must be a true DB NOOP.
  const liveOpts={symbols:['GC=F'],end:'2026-09-13',invocationId:'live-first'};
  await runLiveHistory(store,manifest,liveOpts,async(s)=>({body:fixtures[s],fetchedAt:'2026-09-14T19:00:00Z',url:'fixture://live'}));
  const beforeNoop=(await db.query("SELECT * FROM futures_root_market_observations WHERE yahoo_symbol='GC=F' ORDER BY observed_date")).rows;
  const noop=await runLiveHistory(store,manifest,{...liveOpts,end:'2026-09-14',invocationId:'live-next'},async(s)=>({body:fixtures[s],fetchedAt:'2026-09-14T20:00:00Z',url:'fixture://live'}));
  assert.equal(noop.rows,0);assert.equal(noop.health[0].STATE,'NOOP');
  assert.deepEqual((await db.query("SELECT * FROM futures_root_market_observations WHERE yahoo_symbol='GC=F' ORDER BY observed_date")).rows,beforeNoop);
  const repairedSymbols=[];
  const repaired=await repairHistoryRun(store,manifest,{runId:isolated.runId,invocationId:'repair-only'},async(s,...rest)=>{repairedSymbols.push(s);return fetcher(s,...rest)});
  assert.deepEqual(repairedSymbols,['SI=F']);assert.equal(repaired.requests,1);
  const dq=await runLiveHistory(store,manifest,{symbols:['CC=F','KC=F','OJ=F'],end:'2026-09-14',invocationId:'dq-skip'},()=>{throw Error('quarantine fetched')});
  assert.equal(dq.requests,0);assert.equal(dq.quarantined.length,3);
  assert.equal(futuresHealth({sourceLatest:'2026-09-11',dbLatest:'2026-09-11',state:'NOOP',backfillStatus:'IN_PROGRESS',autoSync:true}).COMPLETE,false);
  assert.equal(futuresHealth({sourceLatest:'2026-09-11',dbLatest:'2026-09-11',state:'NOOP',backfillStatus:'COMPLETE',autoSync:true}).COMPLETE,true);
  assert.equal(futuresHealth({sourceLatest:'2026-09-11',dbLatest:'2026-09-11',state:'NOOP',backfillStatus:'COMPLETE',autoSync:false}).COMPLETE,false);
  console.log('LIVE_SOURCE_NOOP_REPAIR_SUBSET_QUARANTINE_COMPLETE_GATE: PASS');
  console.log('ISOLATED_DB_ONLY: YES; LIVE_YAHOO_REQUESTS: 0');
} finally { await db.close(); }
