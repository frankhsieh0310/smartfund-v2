import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const DAY = 86400000;
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, n) => isoDay(Date.parse(date) + n * DAY);
const sourceUrl = symbol => `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
const assetClass = category => ({Commodity:'COMMODITY_FUTURES',Equity:'EQUITY_INDEX_FUTURES',Treasury:'TREASURY_FUTURES',Rate:'INTEREST_RATE_FUTURES',Currency:'CURRENCY_FUTURES'})[category];
export const TRUE_NEW_HEADS = new Set(['MGC=F','SIL=F','B0=F']);
export const BZ_CANONICAL_ID = '7ceb9102-ff27-4040-a181-26aaabbd6193';
export const HISTORY_GRAINS = ['VENDOR_CONTINUOUS_ROOT_SERIES','YAHOO_HEAD_SERIES_ADJUSTMENT_UNKNOWN'];
const venue = x => ({CMX:'COMEX',NYM:'NYMEX',CBT:'CBOT',NYB:'ICE'})[x] ?? x;
const approvedHeads = new Set('ES GF HE LE NQ RTY CL CC KC OJ SB YM ZB ZN ZF ZT GC MGC SI SIL PL HG PA HO NG RB BZ B0 ZC ZO KE ZR ZM ZL ZS'.split(' ').map(x=>x+'=F'));
function yahooEvidence(url, symbol) {
  try { const u=new URL(url), path=decodeURIComponent(u.pathname); return ['finance.yahoo.com','query1.finance.yahoo.com','query2.finance.yahoo.com'].includes(u.hostname)
    && (path.startsWith('/quote/'+symbol+'/') || path==='/v8/finance/chart/'+symbol); } catch { return false; }
}
export function reconcileHead(record, prior) {
  if(record.symbolType!=='HEAD' || !approvedHeads.has(record.providerSymbol)) throw Error('Outside approved HEAD scope');
  if(!prior) return TRUE_NEW_HEADS.has(record.providerSymbol)?'TRUE_NEW':'QUARANTINE';
  if(prior.root_symbol!==record.root || !yahooEvidence(prior.source_url,record.providerSymbol)) return 'QUARANTINE';
  if(record.providerSymbol==='BZ=F') return prior.root_id===BZ_CANONICAL_ID && prior.root_exchange==='ICE'
    && prior.asset_class==='ENERGY_FUTURES' && prior.root_source==='YAHOO_FINANCE' ? 'REUSE':'QUARANTINE';
  const expected=record.category==='Treasury'?'INTEREST_RATE_FUTURES':assetClass(record.category);
  return venue(prior.root_exchange)===venue(record.exchange) && venue(prior.exchange)===venue(record.exchange)
    && prior.asset_class===expected ? 'REUSE':'QUARANTINE';
}
export async function loadManifest() {
  const m = JSON.parse(await readFile(new URL('../../../config/yahoo-futures-phase1.json', import.meta.url), 'utf8'));
  if (m.heads.length !== 35 || m.months.length !== 451 || m.monthHistoryEnabled || m.newsEnabled) throw Error('Invalid phase-1 scope');
  if (new Set([...m.heads, ...m.months].map(x => x.providerSymbol)).size !== 486) throw Error('Duplicate manifest symbols');
  for (const h of m.heads) if (!h.providerSymbol.endsWith('=F') || h.symbolType !== 'HEAD') throw Error('HEAD scope required');
  return m;
}
export function parseChart(body, symbol, from, to) {
  const r = body.chart?.result?.[0];
  if (body.chart?.error || !r || r.meta?.symbol !== symbol || r.meta.dataGranularity !== '1d') throw Error('Invalid Yahoo daily chart');
  const q = r.indicators?.quote?.[0];
  if (!q) throw Error('Missing OHLCV');
  const rows = new Map();
  for (let i = 0; i < (r.timestamp ?? []).length; i++) {
    const date = isoDay(r.timestamp[i] * 1000);
    if (date < from || date >= to) continue;
    const values = ['open','high','low','close','volume'].map(k => q[k]?.[i]);
    // Missing bars must not erase existing complete observations.
    if (values.every(v => v == null)) continue;
    if (!values.every(v => typeof v === 'number' && Number.isFinite(v))) throw Error('Partial OHLCV bar');
    const [open,high,low,close,volume] = values;
    if (high < Math.max(open,close,low) || low > Math.min(open,close,high) || !Number.isSafeInteger(volume) || volume < 0) throw Error('Invalid OHLCV values');
    rows.set(date, {date,open,high,low,close,volume});
  }
  return [...rows.values()].sort((a,b) => a.date.localeCompare(b.date));
}
export async function fetchDaily(symbol, from, to) {
  if (!symbol.endsWith('=F')) throw Error('Month history disabled');
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&period1=${Date.parse(from)/1000}&period2=${Date.parse(to)/1000}`;
  const fetchedAt = new Date().toISOString(); // Request start, not late response completion.
  const response = await fetch(url, {signal:AbortSignal.timeout(20000),headers:{Accept:'application/json'}});
  if (!response.ok) throw Error(`Yahoo HTTP ${response.status}`);
  return {body:await response.json(), fetchedAt, url};
}

// One dedicated connection per Store. The caller never shares it between jobs.
export class Store {
  constructor(connection) { this.db = connection; }
  query(sql, args = []) { return this.db.query(sql,args); }
  async transaction(fn) {
    await this.query('BEGIN');
    try { const value = await fn(); await this.query('COMMIT'); return value; }
    catch (error) { await this.query('ROLLBACK'); throw error; }
  }
  async metadata(record) {
    if(record.symbolType!=='HEAD') throw Error('Month metadata reconciliation deferred');
    const prior=(await this.query(`SELECT m.root_id,m.exchange,m.source_url,m.field_disposition,r.root_symbol,
      r.exchange AS root_exchange,r.asset_class,r.source AS root_source FROM futures_yahoo_symbol_mappings m
      JOIN futures_product_roots r ON r.id=m.root_id WHERE m.yahoo_symbol=$1 FOR UPDATE OF m`,[record.providerSymbol])).rows[0];
    const decision=reconcileHead(record,prior);
    if(decision==='QUARANTINE') throw Error('HEAD identity quarantined: '+record.providerSymbol);
    if(prior) {
      // Never rewrite canonical identity, legacy mapping fields, or existing metadata provenance.
      await this.query(`UPDATE futures_yahoo_symbol_mappings SET field_disposition=field_disposition || $2::jsonb
        WHERE yahoo_symbol=$1 AND (field_disposition->'yahooPhase1Provider'->>'sourceTimestamp' IS NULL
          OR field_disposition->'yahooPhase1Provider'->>'sourceTimestamp' <= $3)`,
        [record.providerSymbol,JSON.stringify({yahooPhase1Provider:{...record,canonicalRootId:prior.root_id,reconciliation:'REUSE_EXISTING'}}),record.sourceTimestamp ?? '']);
      return prior.root_id;
    }
    // Only the three explicitly reviewed NEW heads may create roots. Recheck for new equivalents.
    if((await this.query('SELECT id FROM futures_product_roots WHERE root_symbol=$1 LIMIT 1',[record.root])).rows.length)
      throw Error('New HEAD now has a possible equivalent; reconcile before creating');
    const rootId=randomUUID();
    await this.query(`INSERT INTO futures_product_roots
      (id,commodity_id,asset_class,official_product_name,root_symbol,exchange,currency,country,jurisdiction,timezone,status,source,source_url,verification_status,license_status)
      VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$7,'UNKNOWN','ACTIVE','YAHOO',$8,'PROVIDER_METADATA','UNVERIFIED')`,
      [rootId,assetClass(record.category),record.name,record.root,venue(record.exchange),record.currency ?? 'UNKNOWN',record.region,sourceUrl(record.providerSymbol)]);
    await this.query(`INSERT INTO futures_yahoo_symbol_mappings
      (id,root_id,yahoo_symbol,category,exchange,mapping_status,source_url,contract_name,currency,field_disposition)
      VALUES($1,$2,$3,$4,$5,'PROVIDER_SYMBOL_ROOT_ONLY',$6,$7,$8,$9::jsonb)`,
      [randomUUID(),rootId,record.providerSymbol,record.category,venue(record.exchange),sourceUrl(record.providerSymbol),record.name,record.currency,
        JSON.stringify({yahooPhase1Provider:{...record,canonicalRootId:rootId,reconciliation:'TRUE_NEW'},adjustmentStatus:'NOT_ESTABLISHED'})]);
    return rootId;
  }
  async bars(rootId, symbol, rows, fetchedAt, url) {
    if (!Number.isFinite(Date.parse(fetchedAt))) throw Error('Missing fetch timestamp');
    if (rows.length && (await this.query(`SELECT 1 FROM futures_root_market_observations WHERE yahoo_symbol=$1
      AND observed_date >= $2 AND observed_date <= $3
      AND (source <> 'YAHOO' OR root_id <> $4 OR source_grain NOT IN ('VENDOR_CONTINUOUS_ROOT_SERIES','YAHOO_HEAD_SERIES_ADJUSTMENT_UNKNOWN')) LIMIT 1`,
      [symbol,rows[0].date,rows.at(-1).date,rootId])).rows.length) throw Error('Existing observation semantics require reconciliation');
    for (const r of rows) await this.query(`INSERT INTO futures_root_market_observations
      (id,root_id,yahoo_symbol,observed_date,open,high,low,close,volume,source,source_url,source_grain,retrieved_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'YAHOO',$10,'VENDOR_CONTINUOUS_ROOT_SERIES',$11)
      ON CONFLICT(yahoo_symbol,observed_date) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,
      close=EXCLUDED.close,volume=EXCLUDED.volume,retrieved_at=EXCLUDED.retrieved_at,source_url=EXCLUDED.source_url,updated_at=NOW()
      WHERE futures_root_market_observations.source='YAHOO'
        AND futures_root_market_observations.root_id=EXCLUDED.root_id
        AND futures_root_market_observations.source_grain IN ('VENDOR_CONTINUOUS_ROOT_SERIES','YAHOO_HEAD_SERIES_ADJUSTMENT_UNKNOWN')
        AND futures_root_market_observations.retrieved_at < EXCLUDED.retrieved_at`,
      [randomUUID(),rootId,symbol,r.date,r.open,r.high,r.low,r.close,r.volume,url,fetchedAt]);
  }
}
export async function ingestMetadata(store, records) {
  if (records.length < 1 || records.length > 25) throw Error('Metadata batch must be 1..25');
  return store.transaction(async () => { await store.query("SELECT pg_advisory_xact_lock(hashtext('smartfund:FUTURES_YAHOO_GLOBAL_HISTORY'))::text"); let done=0; for (const r of records) { try { await store.metadata(r); done++; } catch(e) { if(r.providerSymbol!=='BZ=F'||!e.message.startsWith('HEAD identity quarantined:')) throw e; } } return done; });
}
export const DATA_QUALITY_QUARANTINED = ['CC=F','KC=F','OJ=F'];
export function classifyHistoryFailure(error, stage) {
  const reason=error?.message ?? String(error);
  if(/Partial OHLCV|Invalid OHLCV values/.test(reason))return 'DATA_QUALITY_QUARANTINED';
  if(/NO_DATA|Missing OHLCV/.test(reason))return 'SOURCE_NO_DATA';
  if(/identity|semantics|canonical/i.test(reason))return 'IDENTITY_ERROR';
  if(/Stale Yahoo/.test(reason))return 'SOURCE_STALE';
  return stage==='fetch'?'FETCH_ERROR':stage==='parse'?'PARSE_ERROR':'WRITE_ERROR';
}
const repairable = type => ['FETCH_ERROR','PARSE_ERROR','WRITE_ERROR','IDENTITY_ERROR','LAGGING'].includes(type);
// Shared scheduler-run details are the health transport; no new table or dashboard.
export function futuresHealth({sourceLatest=null,dbLatest=null,state='UNKNOWN',lastSuccess=null,
  nextCheck=null,autoSync=false,backfillStatus='UNKNOWN'}={}) {
  const lag=sourceLatest&&dbLatest?Math.max(0,(Date.parse(sourceLatest)-Date.parse(dbLatest))/DAY):null;
  const failed=['FETCH_ERROR','PARSE_ERROR','WRITE_ERROR','IDENTITY_ERROR','DATA_QUALITY_QUARANTINED'].includes(state);
  const noData=state==='SOURCE_NO_DATA';
  const complete=backfillStatus==='COMPLETE'&&autoSync&&lag===0&&!failed&&!noData&&['NOOP','UPDATED'].includes(state);
  return {SOURCE:'YAHOO',SOURCE_LATEST:sourceLatest,DB_LATEST:dbLatest,LAG:lag,COMPLETE:complete,
    INCOMPLETE:!complete,FAILED:failed,NO_DATA:noData,LAST_SUCCESS:lastSuccess,NEXT_CHECK:nextCheck,
    AUTO_SYNC:autoSync,BACKFILL_STATUS:backfillStatus,STATE:state};
}

export async function runHistory(store, manifest, options, fetcher = fetchDaily) {
  const {start,end,invocationId,mode='backfill',maxRequests=3,windowDays=7,concurrency=2} = options;
  if (!['backfill','incremental'].includes(mode) || !invocationId || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)
      || !Number.isFinite(Date.parse(start)) || !(start < end) || end > isoDay(Date.now())
      || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2
      || !Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 3 || !Number.isInteger(windowDays) || windowDays < 1 || windowDays > 31) throw Error('Invalid bounded history options (end exclusive, closed UTC days only)');
  const symbols = options.symbols ?? manifest.heads.map(x=>x.providerSymbol);
  if (!symbols.length || new Set(symbols).size !== symbols.length || symbols.some(s=>!manifest.heads.some(h=>h.providerSymbol===s))) throw Error('Outside 35 HEAD allowlist');
  const digest = createHash('sha256').update(JSON.stringify({symbols,start,end,mode,identities:symbols.map(s=>manifest.heads.find(h=>h.providerSymbol===s))})).digest('hex').slice(0,24);
  const job = 'yahoo-futures-phase1-history', key = `${job}:${digest}`, runKey = `${key}:${invocationId}`;
  return store.transaction(async () => {
    // Share the legacy Yahoo writer mutex; retain the phase lock for checkpoint serialization.
    await store.query("SELECT pg_advisory_xact_lock(hashtext('smartfund:FUTURES_YAHOO_GLOBAL_HISTORY'))::text");
    // One phase lock across all windows: row locking lasts through writes AND checkpoint commit.
    await store.query(`INSERT INTO production_scheduler_locks(job_id,owner,expires_at,created_at,updated_at) VALUES($1,$2,NOW()+INTERVAL '5 minutes',NOW(),NOW()) ON CONFLICT(job_id) DO NOTHING`,[job,invocationId]);
    await store.query('SELECT job_id FROM production_scheduler_locks WHERE job_id=$1 FOR UPDATE NOWAIT',[job]);
    if ((await store.query('SELECT id FROM production_scheduler_runs WHERE run_key=$1',[runKey])).rows.length) return {skipped:true,reason:'DUPLICATE_INVOCATION',rows:0};
    const cp = (await store.query('SELECT last_symbol,target_trade_date::text AS target_trade_date,processed,succeeded,failed FROM production_scheduler_checkpoints WHERE checkpoint_key=$1',[key])).rows[0];
    if (cp && cp.last_symbol === null) return {skipped:true,reason:'WINDOW_COMPLETE',rows:0};
    let index = cp ? symbols.indexOf(cp.last_symbol) : 0;
    if (index < 0) throw Error('Checkpoint symbol mismatch');
    let cursor = cp?.target_trade_date ? isoDay(new Date(cp.target_trade_date).getTime()) : start;
    const runId = randomUUID(); let count=0, requests=0, processed=Number(cp?.processed ?? 0), succeeded=Number(cp?.succeeded ?? 0);
    const windows=[], quarantined=[], failures=[], queue=[], health=[];
    let failed=Number(cp?.failed ?? 0);
    // Plan under the existing market lock; only network fetches run concurrently.
    while(index < symbols.length && queue.length < maxRequests) {
      const symbol = symbols[index], head = manifest.heads.find(x=>x.providerSymbol===symbol);
      if(mode==='incremental' && DATA_QUALITY_QUARANTINED.includes(symbol)) {
        quarantined.push(symbol);health.push({symbol,...futuresHealth({state:'DATA_QUALITY_QUARANTINED'})});
        index++;cursor=start;continue;
      }
      if (head.firstTradeDate) cursor = cursor < head.firstTradeDate ? head.firstTradeDate : cursor;
      if (mode === 'incremental' && cursor === start) {
        const latest = (await store.query('SELECT MAX(observed_date)::text AS latest FROM futures_root_market_observations WHERE yahoo_symbol=$1 AND source=$2',[symbol,'YAHOO'])).rows[0]?.latest;
        const overlapStart = latest ? addDays(isoDay(new Date(latest).getTime()),-3) : addDays(end,-7);
        cursor = overlapStart > cursor ? overlapStart : cursor;
      }
      if (cursor >= end) { index++; cursor=start; continue; }
      const until = addDays(cursor,windowDays) < end ? addDays(cursor,windowDays) : end;
      await store.query('SAVEPOINT head_preflight');
      try {
        const rootId=await store.metadata(head);
        queue.push({symbol,head,rootId,from:cursor,to:until});
        await store.query('RELEASE SAVEPOINT head_preflight');
      } catch(e) {
        await store.query('ROLLBACK TO SAVEPOINT head_preflight');
        await store.query('RELEASE SAVEPOINT head_preflight');
        quarantined.push(symbol); failures.push({symbol,from:cursor,to:end,reason:e.message,type:classifyHistoryFailure(e,'write'),repairable:repairable(classifyHistoryFailure(e,'write'))}); failed++;
        index++; cursor=start; continue;
      }
      cursor=until;
      if(cursor >= end) { index++; cursor=start; }
    }
    let next=0;
    const responses=new Array(queue.length);
    const groups=[...new Set(queue.map(q=>q.symbol))].map(symbol=>
      queue.map((q,i)=>({q,i})).filter(x=>x.q.symbol===symbol));
    await Promise.allSettled(Array.from({length:Math.min(concurrency,groups.length)},async()=>{
      for(;;){const group=groups[next++];if(!group)return;
        // One request at a time per symbol; different symbols share the small pool.
        for(const {q,i} of group) {
          try { responses[i]={value:await fetcher(q.symbol,q.from,q.to)}; }
          catch(error){ responses[i]={error}; }
        }
      }
    }));
    requests=queue.length;
    for(let i=0;i<queue.length;i++) {
      const {symbol,head,rootId,from,to}=queue[i];
      if(quarantined.includes(symbol))continue;
      await store.query('SAVEPOINT history_window');
      let stage='fetch';
      try {
        if(responses[i]?.error)throw responses[i].error;
        const result=responses[i]?.value;
        if(!result)throw Error('Missing worker result');
        stage='parse';
        const bars=parseChart(result.body,symbol,from,to);
        const marketTime=result.body.chart.result[0].meta.regularMarketTime;
        if(!Number.isFinite(marketTime))throw Error('Missing Yahoo source timestamp');
        const metadata=(await store.query('SELECT field_disposition FROM futures_yahoo_symbol_mappings WHERE yahoo_symbol=$1',[symbol])).rows[0].field_disposition;
        const knownTime=metadata.lastHistorySourceTime ?? (head.sourceTimestamp ? Date.parse(head.sourceTimestamp)/1000 : 0);
        if(marketTime < knownTime)throw Error('Stale Yahoo source response');
        stage='write';
        const existing=mode==='incremental'?(await store.query('SELECT observed_date::text AS date,open,high,low,close,volume,retrieved_at,root_id,source,source_grain FROM futures_root_market_observations WHERE yahoo_symbol=$1 AND observed_date >= $2 AND observed_date < $3',[symbol,from,to])).rows:[];
        const latest=(await store.query('SELECT MAX(observed_date)::text AS latest FROM futures_root_market_observations WHERE yahoo_symbol=$1 AND source=$2',[symbol,'YAHOO'])).rows[0]?.latest ?? null;
        if(existing.some(r=>r.root_id!==rootId||r.source!=='YAHOO'||!HISTORY_GRAINS.includes(r.source_grain)))throw Error('Existing observation semantics require reconciliation');
        const changed=mode==='incremental'?bars.filter(bar=>{const old=existing.find(r=>r.date===bar.date);return !old||['open','high','low','close','volume'].some(k=>old[k]==null||(k==='volume'?Number(old[k])!==bar[k]:Number(old[k]).toFixed(8)!==bar[k].toFixed(8)));}):bars;
        if(changed.some(bar=>{const old=existing.find(r=>r.date===bar.date);return old&&Date.parse(old.retrieved_at)>=Date.parse(result.fetchedAt);}))throw Error('Stale Yahoo retrieval');
        const state=bars.length===0?'SOURCE_NO_DATA':changed.length?'UPDATED':'NOOP';
        await store.query('UPDATE futures_yahoo_symbol_mappings SET field_disposition=field_disposition || $2::jsonb WHERE yahoo_symbol=$1',
          [symbol,JSON.stringify({lastHistorySourceTime:marketTime})]);
        if(changed.length)await store.bars(rootId,symbol,changed,result.fetchedAt,result.url);
        await store.query('RELEASE SAVEPOINT history_window');
        count+=changed.length; processed++; succeeded++; windows.push({symbol,from,to,rows:changed.length,state});
        const sourceLatest=bars.at(-1)?.date ?? null;
        const dbLatest=sourceLatest&&(!latest||sourceLatest>latest)?sourceLatest:latest;
        health.push({symbol,...futuresHealth({sourceLatest,dbLatest,state,lastSuccess:bars.length?result.fetchedAt:null,
          backfillStatus:options.backfillStatus?.[symbol]??'UNKNOWN'})});
      } catch(e) {
        await store.query('ROLLBACK TO SAVEPOINT history_window');
        await store.query('RELEASE SAVEPOINT history_window');
        quarantined.push(symbol); failures.push({symbol,from,to:end,reason:e.message,type:classifyHistoryFailure(e,stage),repairable:repairable(classifyHistoryFailure(e,stage))}); failed++; processed++;
        health.push({symbol,...futuresHealth({state:classifyHistoryFailure(e,stage)})});
      }
    }
    // A quarantined symbol must not hold the market cursor; its gap remains in run details.
    if(index < symbols.length && quarantined.includes(symbols[index])) { index++; cursor=start; }
    const done=index===symbols.length;
    await store.query(`INSERT INTO production_scheduler_runs(id,job_id,exchange,run_type,status,started_at,completed_at,attempted,completed,failed,run_key,details)
      VALUES($1,$2,'YAHOO',$3,'COMPLETED',NOW(),NOW(),$4,$7,$8,$5,$6::jsonb)`,[runId,job,mode,requests,runKey,JSON.stringify({windows,rows:count,done,quarantined,failures,health}),windows.length,failures.length]);
    await store.query(`INSERT INTO production_scheduler_checkpoints(checkpoint_key,job_id,run_id,last_symbol,processed,succeeded,failed,target_trade_date,run_type,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$9,$7,$8,NOW(),NOW()) ON CONFLICT(checkpoint_key) DO UPDATE SET run_id=EXCLUDED.run_id,last_symbol=EXCLUDED.last_symbol,
      processed=EXCLUDED.processed,succeeded=EXCLUDED.succeeded,failed=EXCLUDED.failed,target_trade_date=EXCLUDED.target_trade_date,updated_at=NOW()`,
      [key,key,runId,done?null:symbols[index],processed,succeeded,done?end:cursor,mode,failed]);
    return {runId,rows:count,requests,done,windows,quarantined,failures,health,checkpoint:{symbol:done?null:symbols[index],date:done?end:cursor}};
  });
}

// Daily cycle and backfill remain independent checkpoint keys (mode + stable bounds).
export async function runLiveHistory(store,manifest,{invocationId,end=isoDay(Date.now()),...options},fetcher=fetchDaily) {
  return runHistory(store,manifest,{...options,invocationId,start:addDays(end,-7),end,mode:'incremental'},fetcher);
}
// Explicit failure subset only: never reset the original market checkpoint or replay success.
export async function repairHistoryRun(store,manifest,{runId,invocationId,maxRequests=3},fetcher=fetchDaily) {
  if(!invocationId||!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>3)throw Error('Invalid repair cap');
  const prior=(await store.query('SELECT job_id,details FROM production_scheduler_runs WHERE id=$1',[runId])).rows[0];
  if(prior?.job_id!=='yahoo-futures-phase1-history')throw Error('Not a Futures history run');
  const results=[];let used=0;
  for(const [i,f] of (prior.details.failures??[]).entries()) {
    if(!f.repairable||!repairable(f.type)||DATA_QUALITY_QUARANTINED.includes(f.symbol)||used>=maxRequests)continue;
    const r=await runHistory(store,manifest,{symbols:[f.symbol],start:f.from,end:f.to,mode:'backfill',
      invocationId:invocationId+'-repair-'+runId+'-'+i,maxRequests:maxRequests-used,windowDays:31},fetcher);
    used+=r.requests??0;results.push(r);
  }
  return {results,requests:used};
}

// Explicit local-only entry point. No dotenv, production URL fallback, schema creation or scheduler.
async function main() {
  const [command,...args] = process.argv.slice(2);
  const manifest = await loadManifest();
  if (command === 'plan') { console.log(JSON.stringify({heads:manifest.heads.length,months:manifest.months.length,history:'1d HEAD only',news:false})); return; }
  const url = process.env.YAHOO_FUTURES_LOCAL_DATABASE_URL;
  if (!url || !['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)) throw Error('Explicit local test database URL required');
  const {PrismaClient} = await import('@prisma/client');
  const db = new PrismaClient({datasources:{db:{url}}});
  try {
    // Prisma interactive transaction guarantees a dedicated connection; Store nesting is handled here.
    await db.$transaction(async tx => {
      const adapter={query:async (sql,params=[])=> {
        if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return {rows:[]};
        if (/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) return {rows:await tx.$queryRawUnsafe(sql,...params)};
        await tx.$executeRawUnsafe(sql,...params); return {rows:[]};
      }};
      const store=new Store(adapter);
      if(command==='metadata-heads') for(let i=0;i<manifest.heads.length;i+=25) await ingestMetadata(store,manifest.heads.slice(i,i+25));
      else if(command==='metadata-months') throw Error('Month metadata reconciliation deferred; manifest only');
      else if(command==='history') console.log(JSON.stringify(await runHistory(store,manifest,{start:args[0],end:args[1],invocationId:args[2],mode:args[3]??'backfill'})));
      else throw Error('Use plan, metadata-heads, metadata-months, history START END INVOCATION [mode]');
    },{timeout:120000});
  } finally { await db.$disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
