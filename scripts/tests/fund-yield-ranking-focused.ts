// Read-only validation of the complete materialized universe and the real API response.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rankFundYields, readFundYieldSnapshot, fundYieldPage, snapshotPath, type FundYieldEntry } from '../../lib/yahoo/fundYieldRanking';
import { getYahooDirectYield } from '../../lib/yahoo/distributionYield';
import { GET } from '../../app/api/rankings/etf-dividend/route';
import { prisma } from '../../lib/prisma';

async function main() {
  const snapshot=await readFundYieldSnapshot();
  const checkpoint:Record<string,FundYieldEntry>=JSON.parse(await readFile(snapshotPath.replace(/\.json$/,'.pending.json'),'utf8'));
  const all=Object.values(checkpoint);
  assert.equal(all.length,snapshot.mappedCount);
  const expected=all.filter(r=>r.yahooYield!==null).sort((a,b)=>b.yahooYield!-a.yahooYield!||a.shareClassId.localeCompare(b.shareClassId));
  assert.equal(snapshot.rows.length,expected.length);
  assert.equal(new Set(snapshot.rows.map(r=>r.shareClassId)).size,snapshot.rows.length);
  const originalFetch=globalThis.fetch;let pageRequests=0;
  globalThis.fetch=async(input,init)=>{pageRequests++;return originalFetch(input,init);};
  const page1=await(await GET(new Request('http://local/api?type=fund&limit=20'))).json();
  const page2=await(await GET(new Request(`http://local/api?type=fund&limit=20&offset=20&snapshot=${snapshot.version}`))).json();
  globalThis.fetch=originalFetch;assert.equal(pageRequests,0,'Pagination must not fetch Yahoo');
  assert.deepEqual(page1.data.map((r:any)=>r.shareClassId),expected.slice(0,20).map(r=>r.shareClassId));
  assert.deepEqual(page2.data.map((r:any)=>r.shareClassId),expected.slice(20,40).map(r=>r.shareClassId));
  assert.ok(page1.data.at(-1).yahooYield>=page2.data[0].yahooYield);
  const zeros=all.filter(r=>r.yahooYield===0),missing=all.filter(r=>r.yahooYield===null);
  assert.ok(zeros.length>0&&missing.length>0);
  assert.equal(rankFundYields(zeros).length,zeros.length);assert.equal(rankFundYields(missing).length,0);
  assert.throws(()=>fundYieldPage({...snapshot,failedCount:1},0,20));
  assert.equal((await GET(new Request('http://local/api?type=fund&snapshot=obsolete'))).status,409);
  // Five spread-out real share classes, not hardcoded products or yield values.
  const samples=[0,.25,.5,.75,1].map(n=>expected[Math.floor(n*(expected.length-1))]);
  const app=await readFile(process.argv[2],'utf8');const f6=app.slice(app.indexOf('function DividendPage('),app.indexOf('// ---- shared Fund + ETF'));
  const modelExpression=f6.match(/const rows=productType==='ETF'\?p.assets:([\s\S]*?);setAssets/);
  assert.ok(modelExpression,'App must preserve the API row order/value');
  const uiModel=new Function('p',`return ${modelExpression[1]}`);
  const results=[];
  for(const row of samples){
    const index=expected.findIndex(r=>r.shareClassId===row.shareClassId);
    const page=await(await GET(new Request(`http://local/api?type=fund&limit=1&offset=${index}`))).json();
    const yahoo=await getYahooDirectYield(row.code);
    assert.equal(page.data[0].yahooYield,yahoo);
    const display=uiModel(page)[0];assert.equal(display.yahoo_yield_pct,yahoo);assert.equal(display.symbol,row.code);
    results.push({code:row.code,shareClassId:row.shareClassId,yahoo,api:page.data[0].yahooYield,uiModel:display.yahoo_yield_pct});
  }
  const web=await readFile('app/rankings/dividend/page.tsx','utf8');assert.ok(!web.includes('.sort('));
  assert.ok(!f6.includes('.sort('));assert.ok(f6.includes('/api/rankings/etf-dividend?type=fund'));
  console.log(JSON.stringify({universe:snapshot.universeCount,mapped:snapshot.mappedCount,withYield:expected.length,coverage:expected.length/snapshot.universeCount*100,top20:'PASS',pageOrder:'PASS',pageRequests,page1Lowest:page1.data.at(-1).yahooYield,page2Highest:page2.data[0].yahooYield,zeroCount:zeros.length,missingCount:missing.length,zeroVsMissing:'PASS',samples:results,frontendSortRemoved:true},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
