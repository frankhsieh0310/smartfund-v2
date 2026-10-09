import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prisma } from '../../lib/prisma';
import { reverseHoldings, reverseSQL, resolveTargets, rankProducts, paginate, compareProducts, type Target, type Query } from '../../lib/data-platform/reverseHoldings';
import { canonicalReversePage, appendReversePage } from '../../../tw-industry-radar/canonicalReverse';

const query: Query = (sql,...p)=>prisma.$queryRawUnsafe(sql,...p);
const target: Target={id:'stock-A',ticker:'AAA.US',bare:'AAA',bare_unique:false,country:'US',exchange:'NYSE',name:'Alpha',security_ids:['sec-A'],names:['alpha'],unique_names:['alpha']};

async function regression() {
  // Read-only VALUES/JSON fixtures exercise the actual production SQL. No temp tables or writes.
  const e=(id:string,code:string)=>({id,code,name:code,exchange:'TWSE',region:'TW',isin:null,category:null,is_active:true});
  const snap=(id:string,etf_id:string,date:string)=>({id,etf_id,effective_date:date,source:'Issuer',source_type:'ISSUER_OFFICIAL_PCF',verification_status:'COMPLETE',completeness_status:'COMPLETE',quality_status:'COMPLETE',canonical_row_count:1,parsed_row_count:1,retrieved_at:'2020-01-01T00:00:00Z'});
  const pos=(snapshot_id:string,security_id:string)=>({snapshot_id,security_id,ticker:null,country:'US',holding_name:security_id==='sec-A'?'Alpha':'Beta',weight:4,holding_type:'EQUITY',asset_class:'EQUITY',quantity:1,raw_row:{}});
  const data={
    etfs:[e('e1','00111'),e('e2','00222'),e('e3','00333'),e('e4','00333.TW')],
    etf_holding_snapshots:[snap('old','e1','2020-01-01'),snap('new','e1','2020-02-01'),snap('valid','e2','2020-01-01'),snap('future','e2','2999-01-01'),snap('alias1','e3','2020-01-01'),snap('alias2','e4','2020-02-01')],
    etf_holdings:[pos('old','sec-A'),pos('new','sec-B'),pos('valid','sec-B'),pos('future','sec-A'),pos('alias1','sec-A'),pos('alias2','sec-A')],
    funds:[{id:'f1',code:'F1',name:'Fund1',is_active:true},{id:'f2',code:'F2',name:'Fund2',is_active:true}],
    fund_share_classes:[{fund_id:'f1',master_fund_id:'master'},{fund_id:'f2',master_fund_id:'master'}],
    fund_master:[{id:'master',canonical_name:'Master',representative_fund_id:'f2'}],
    holdings:[{fund_id:'f1',asset_type:'FUND',as_of_date:'2020-01-01',source:'MONEYDJ',filing_id:null,security_id:'sec-A',holding_code:null,ticker:null,holding_name:'Alpha',country:'US',weight:10},{fund_id:'f2',asset_type:'FUND',as_of_date:'2020-02-01',source:'MONEYDJ',filing_id:null,security_id:'sec-B',holding_code:null,ticker:null,holding_name:'Beta',country:'US',weight:20}]
  };
  const columns:Record<string,string>={etfs:'id text,code text,name text,exchange text,region text,isin text,category text,is_active boolean',etf_holding_snapshots:'id text,etf_id text,effective_date date,source text,source_type text,verification_status text,completeness_status text,quality_status text,canonical_row_count int,parsed_row_count int,retrieved_at timestamptz',etf_holdings:'snapshot_id text,security_id text,ticker text,country text,holding_name text,weight numeric,holding_type text,asset_class text,quantity numeric,raw_row jsonb',funds:'id text,code text,name text,is_active boolean',fund_share_classes:'fund_id text,master_fund_id text',fund_master:'id text,canonical_name text,representative_fund_id text',holdings:'fund_id text,asset_type text,as_of_date date,source text,filing_id text,security_id text,holding_code text,ticker text,holding_name text,country text,weight numeric'};
  const fixtures=Object.entries(columns).map(([table,cols])=>`${table} AS (SELECT * FROM jsonb_to_recordset($2::jsonb->'${table}') AS x(${cols}))`).join(',');
  const sql=reverseSQL.replace('WITH targets AS',`WITH ${fixtures}, targets AS`);
  const actual=rankProducts(await query(sql,JSON.stringify([target]),JSON.stringify(data)));
  assert.deepEqual(actual.map(x=>x.id),['ETF:TW:00333']); // exited A, future A, other share-class A excluded; alias once
  const guarded={...data,securities:[{id:'wrong-market',country:'JP'}],
    etfs:[e('g1','00444'),{...e('g2','00555'),name:'2x leveraged Alpha'},e('g3','00666')],
    etf_holding_snapshots:[snap('correction','g1','2020-02-01'),snap('synthetic','g2','2020-02-01'),{...snap('undated','g3','2020-02-01'),effective_date:null,source_type:'PROVIDER_OBSERVATION'}],
    etf_holdings:[{...pos('correction','wrong-market'),ticker:'AAA.US',holding_name:'Alpha'}, {...pos('synthetic','sec-A'),holding_type:'SECURITY',quantity:null},pos('undated','sec-A')]};
  const guardedSQL=sql.replace('WITH etfs AS',`WITH securities AS (SELECT * FROM jsonb_to_recordset($2::jsonb->'securities') AS x(id text,country text)), etfs AS`);
  const guardedRows=rankProducts(await query(guardedSQL,JSON.stringify([target]),JSON.stringify(guarded)));
  assert.deepEqual(guardedRows.map(x=>x.id),['ETF:TW:00444','ETF:TW:00666']);
  assert.equal(guardedRows[1].date,null);assert.equal(guardedRows[1].freshness,'UNKNOWN');
  const numbered=Array.from({length:205},(_,i)=>({...actual[0],id:String(i),code:String(i).padStart(3,'0'),matched_count:i%3+1,matched_weight_sum:i/10})).sort(compareProducts);
  assert.equal(numbered.length,205);
  for(let i=1;i<numbered.length;i++)assert(compareProducts(numbered[i-1],numbered[i])<=0);
  const p1=paginate(numbered,1,100),p2=paginate(numbered,2,100),p3=paginate(numbered,3,100);
  assert.equal(p1.total,205);assert.equal(p2.total,205);assert.equal(p3.results.length,5);
  assert.equal(new Set([...p1.results,...p2.results,...p3.results].map(x=>x.id)).size,205);
  assert(compareProducts(p1.results.at(-1)!,p2.results[0])<=0);
  assert.deepEqual(canonicalReversePage({ok:true,...p1}).results,p1.results);
  assert.equal(appendReversePage({ok:true,...p1},{ok:true,...p2}).results.length,200);
  assert.throws(()=>appendReversePage({ok:true,...p1},{ok:true,...p1}));
  const fakeQuery:Query=async <T>(s:string)=> (s.includes('FROM stocks s WHERE s.is_active') ? [{...target,ticker:'AAA.US'}, {...target,id:'other',ticker:'AAA.JP',country:'JP'}] : []) as T[];
  await assert.rejects(()=>resolveTargets(fakeQuery,['AAA']));
  assert.equal((await resolveTargets(fakeQuery,['AAA.US']))[0].country,'US');
  console.log('FOCUSED_REGRESSIONS: PASS (identity, latest snapshot, master, product dedupe, sort, pagination, App normalization)');
}

async function live() {
  const cases=['2330.TW','2317.TW','2454.TW','2330.TW,2317.TW,2454.TW','NVDA','AAPL','MSFT','7203.T','005930.KS','0700.HK','600519.SS','ASML.AS'];
  // Final bounded revalidation shares the identical snapshot query across these specific targets only.
  // Filter by canonical target ID, then use the same rank/paginate functions as the API.
  const shared=process.argv.includes('--shared-query');
  const targets=shared?await resolveTargets(query,[...new Set(cases.flatMap(x=>x.split(',')))]):[];
  const rows=shared?await query<import('../../lib/data-platform/reverseHoldings').MatchRow>(reverseSQL,JSON.stringify(targets)):[];
  const fetchPage=async(symbols:string,page=1)=>{
    if(!shared)return reverseHoldings(query,{tickers:symbols.split(','),limit:100,page});
    const ids=new Set(targets.filter(t=>symbols.split(',').includes(t.ticker)).map(t=>t.id));
    const ranked=rankProducts(rows.filter(r=>ids.has(r.stock_id)));
    return {ok:true,...paginate(ranked,page,100),etf_total_products:ranked.filter(x=>x.type==='ETF').length,fund_total_products:ranked.filter(x=>x.type==='基金').length};
  };
  for(const symbols of cases){
    const p=await fetchPage(symbols);
    assert(p.etf_total_products>0,`${symbols} ETF=0`);
    if(!['7203.T','005930.KS'].includes(symbols))assert(p.fund_total_products>0,`${symbols} FUND=0`);
    assert.equal(new Set(p.results.map(x=>x.id)).size,p.results.length);
    for(let i=1;i<p.results.length;i++)assert(compareProducts(p.results[i-1],p.results[i])<=0);
    for(const r of p.results){assert(!r.date||r.date<=new Date().toISOString().slice(0,10));if(r.source==='YAHOO_QUOTE_SUMMARY'&&r.type==='基金')assert.equal(r.date,null);}
    if(symbols==='2330.TW'){
      const x=p.results.find(x=>x.code==='0052');assert(x);
      const db=await query<{date:string,weight:string}>(`SELECT s.effective_date::text date,h.weight::text weight FROM etf_holdings h JOIN etf_holding_snapshots s ON s.id=h.snapshot_id WHERE s.id::text=$1 AND h.ticker='2330'`,x.snapshotId);
      assert.equal(x.date,db[0].date);assert.equal(x.holdings[0].weight,Number(db[0].weight));
      assert.deepEqual(canonicalReversePage(p).results.find(r=>r.id===x.id),x);
      console.log('0052_DB_API_APP',JSON.stringify({date:x.date,weight:x.holdings[0].weight}));
    }
    if(symbols==='0700.HK') assert.equal(p.results.filter(x=>x.id==='ETF:TW:00752').length,1);
    if(symbols==='NVDA'){
      const p2=await fetchPage('NVDA',2);
      assert.equal(p.total,p2.total);assert(compareProducts(p.results.at(-1)!,p2.results[0])<=0);
      assert.equal(new Set([...p.results,...p2.results].map(r=>r.id)).size,p.results.length+p2.results.length);
      console.log('NVDA_PAGINATION: PASS');
    }
    console.log(JSON.stringify({case:symbols,etf:p.etf_total_products,fund:p.fund_total_products,total:p.total,sortViolations:0,sample:p.results.filter(x=>x.type==='基金').slice(0,1).map(x=>({id:x.id,date:x.date,snapshot:x.snapshotId}))}));
  }
  const app=readFileSync('../tw-industry-radar/App.tsx','utf8');const block=app.slice(app.indexOf('function GlobalLookupPage'),app.indexOf('type HoldingSet'));
  assert(!/productData|fundData|\.sort\(/.test(block));assert(block.includes('data?.results.map'));
  assert(app.includes('<GlobalLookupPage back={back} twOnly/>'));
  console.log('APP_SINGLE_SOURCE: PASS');
}
(async()=>{try{await regression();if(process.argv.includes('--live'))await live();}finally{await prisma.$disconnect();}})().catch(e=>{console.error(e);process.exitCode=1;});
