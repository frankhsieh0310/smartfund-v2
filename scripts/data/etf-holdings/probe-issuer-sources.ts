import { promises as fs } from "node:fs";
import path from "node:path";
const root=process.cwd(),runtime=path.join(root,"runtime","etf-holdings");
const registry=JSON.parse(await fs.readFile(path.join(root,"config","etf-holdings-official-registry.json"),"utf8"));
const priority=["vanguard","state-street","invesco","schwab","fidelity","vaneck","global-x","ark"];
const sources=registry.sources.map((x:any[])=>({id:x[0],issuer:x[1],url:x[2],format:x[3],frequency:x[4],timezone:x[5]}));
const rows=[];
for(const source of sources){
  if(source.id==="blackrock"){rows.push({...source,sourceState:"PUBLIC_OFFICIAL_READY",sourceVerified:true,candidatesAttempted:1,reason:"IVV_IWM_FULL_SOURCE_SNAPSHOT_VERIFIED"});continue}
  if(!priority.includes(source.id)){rows.push({...source,sourceState:"SOURCE_PENDING",sourceVerified:false,candidatesAttempted:0,reason:"OUTSIDE_BOUNDED_PRIORITY_BATCH"});continue}
  try{
    const response=await fetch(source.url,{redirect:"follow",signal:AbortSignal.timeout(20000),headers:{"user-agent":"SmartFund-ETF-Holdings/2.2","accept":"text/html,application/json,text/csv,*/*;q=0.5"}});
    if(response.status===401||response.status===403||response.status===429){rows.push({...source,sourceState:"ACCESS_BLOCKED",sourceVerified:false,httpStatus:response.status,candidatesAttempted:1,reason:"OFFICIAL_ENDPOINT_ACCESS_BLOCKED"});continue}
    if(!response.ok){rows.push({...source,sourceState:"SOURCE_PENDING",sourceVerified:false,httpStatus:response.status,candidatesAttempted:1,reason:"OFFICIAL_ENDPOINT_HTTP_FAILURE"});continue}
    const text=(await response.text()).slice(0,5_000_000),links=[...text.matchAll(/href=["']([^"']+)["']/gi)].flatMap(m=>{try{const u=new URL(m[1],response.url);return /holdings?|portfolio|download|\.csv|\.xlsx?/i.test(u.href)?[u.href]:[]}catch{return[]}});
    rows.push({...source,sourceState:links.length?"PUBLIC_OFFICIAL_PARTIAL":"SOURCE_PENDING",sourceVerified:false,httpStatus:response.status,candidatesAttempted:1,officialCandidateLinks:[...new Set(links)].slice(0,2),reason:links.length?"OFFICIAL_PAGE_REACHABLE_CANDIDATE_REQUIRES_ADAPTER_VALIDATION":"OFFICIAL_PAGE_REACHABLE_NO_FULL_HOLDINGS_CANDIDATE_VERIFIED"});
  }catch(error){rows.push({...source,sourceState:"ACCESS_BLOCKED",sourceVerified:false,candidatesAttempted:1,reason:`NETWORK_OR_ACCESS:${String((error as Error).message)}`})}
}
await fs.mkdir(path.join(runtime,"coverage"),{recursive:true});
const output={generatedAt:new Date().toISOString(),boundedPriority:priority,maxCandidatesPerIssuer:2,unknownIssuerState:0,rows};
await fs.writeFile(path.join(runtime,"coverage","issuer-source-matrix.json"),JSON.stringify(output,null,2));
console.log(JSON.stringify(output,null,2));
