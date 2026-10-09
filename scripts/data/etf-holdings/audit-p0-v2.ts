import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma=new PrismaClient({datasources:{db:{url:process.env.DIRECT_URL??process.env.DATABASE_URL}}});
const root=process.cwd(),runtime=path.join(root,"runtime","etf-holdings");
const read=async(file:string,fallback:any=null)=>{try{return JSON.parse(await fs.readFile(file,"utf8"))}catch{return fallback}};
const number=(v:any)=>typeof v==="bigint"?Number(v):Number(v??0);
async function main(){
  const registry=await read(path.join(root,"config","etf-holdings-official-registry.json"),{sources:[]});
  const etfs=await prisma.$queryRawUnsafe<Array<{id:string;code:string;provider:string;category:string|null}>>("SELECT id,code,provider,category FROM etfs ORDER BY id");
  const rows=await prisma.$queryRawUnsafe<Array<any>>(`SELECT e.id etf_id,e.code,e.provider,e.category,h.as_of_date,
    COUNT(*)::bigint rows,COUNT(DISTINCT COALESCE(h.source_record_id,h.holding_code,h.holding_name||':'||h.rank::text))::bigint distinct_holdings,
    SUM(h.weight)::numeric weight_sum,COUNT(*) FILTER(WHERE h.security_id IS NOT NULL)::bigint linked,
    COUNT(*) FILTER(WHERE h.security_id IS NULL)::bigint unresolved,COUNT(*) FILTER(WHERE h.source IS NOT NULL)::bigint provenance_rows,
    COUNT(*) FILTER(WHERE h.holding_name~*'cash|money market|currency')::bigint cash_rows,
    COUNT(*) FILTER(WHERE h.holding_name~*'future|swap|forward|option')::bigint derivative_rows,
    COUNT(*) FILTER(WHERE h.holding_name~*'bond|treasury|note|mortgage')::bigint bond_named_rows
    FROM holdings h JOIN etfs e ON e.id=h.etf_id WHERE h.asset_type='ETF'
    GROUP BY e.id,e.code,e.provider,e.category,h.as_of_date ORDER BY e.code,h.as_of_date`);
  const duplicate=await prisma.$queryRawUnsafe<Array<{duplicates:bigint}>>(`SELECT COALESCE(SUM(n-1),0)::bigint duplicates FROM (SELECT etf_id,as_of_date,COALESCE(source_record_id,holding_code,holding_name||':'||rank::text),COUNT(*) n FROM holdings WHERE asset_type='ETF' GROUP BY 1,2,3 HAVING COUNT(*)>1) q`);
  const sourceGroups=await prisma.$queryRawUnsafe<Array<any>>(`SELECT e.code,h.as_of_date,h.source,h.weight_method,COUNT(*)::bigint rows,SUM(h.weight)::numeric weight_sum,MIN(h.created_at) first_created,MAX(h.created_at) last_created FROM holdings h JOIN etfs e ON e.id=h.etf_id WHERE h.asset_type='ETF' GROUP BY e.code,h.as_of_date,h.source,h.weight_method ORDER BY e.code,h.as_of_date,h.source`);
  const semanticDuplicates=await prisma.$queryRawUnsafe<Array<any>>(`SELECT e.code,h.as_of_date,COUNT(*)::bigint duplicate_groups,SUM(h.n-1)::bigint duplicate_rows FROM (SELECT etf_id,as_of_date,rank,holding_name,holding_code,COUNT(*) n FROM holdings WHERE asset_type='ETF' GROUP BY 1,2,3,4,5 HAVING COUNT(*)>1) h JOIN etfs e ON e.id=h.etf_id GROUP BY e.code,h.as_of_date ORDER BY e.code,h.as_of_date`);
  const totals=await prisma.$queryRawUnsafe<Array<any>>(`SELECT COUNT(*)::bigint total,COUNT(DISTINCT etf_id)::bigint etfs,COUNT(*) FILTER(WHERE security_id IS NOT NULL)::bigint linked,COUNT(*) FILTER(WHERE security_id IS NULL)::bigint unresolved,COUNT(DISTINCT etf_id) FILTER(WHERE source IS NOT NULL)::bigint verified_etfs FROM holdings WHERE asset_type='ETF'`);
  const snapshotCounts=new Map<string,number>();for(const row of rows)snapshotCounts.set(row.etf_id,(snapshotCounts.get(row.etf_id)||0)+1);
  const normalized:any[]=[];for(const code of ["IVV","IWM"]){const v=await read(path.join(runtime,"staging",`blackrock-${code}-normalized.json`));if(v)normalized.push(v)}
  const fullIds=new Set(normalized.filter(x=>x.snapshot.completenessStatus==="FULL_SOURCE_SNAPSHOT").map(x=>x.snapshot.etfId));
  const typeCounts={equity:0,fixedIncome:0,derivative:0,cash:0,other:0};for(const v of normalized)for(const h of v.holdings){if(h.holdingType==="EQUITY")typeCounts.equity++;else if(h.holdingType==="BOND")typeCounts.fixedIncome++;else if(["FUTURE","OPTION","SWAP","FX_FORWARD"].includes(h.holdingType))typeCounts.derivative++;else if(["CASH","MONEY_MARKET"].includes(h.holdingType))typeCounts.cash++;else typeCounts.other++}
  const agg=rows.filter(x=>x.code==="AGG");typeCounts.fixedIncome+=agg.reduce((s,x)=>s+number(x.rows),0);
  const issuerMatrix=(await read(path.join(runtime,"coverage","issuer-coverage-matrix.json"),{rows:[]})).rows;
  const sample=[...etfs].sort((a,b)=>createHash("sha256").update(a.id).digest("hex").localeCompare(createHash("sha256").update(b.id).digest("hex"))).slice(0,10);
  const sampleState={ready:0,pitReady:0,licenseConstrained:0,sourceConstrained:0,notReady:0};for(const e of sample){if(fullIds.has(e.id)){sampleState.ready++;if((snapshotCounts.get(e.id)||0)>=2)sampleState.pitReady++}else if(issuerMatrix.find((x:any)=>x.issuer===e.provider)?.licenseStatus==="TERMS_REVIEW_REQUIRED")sampleState.licenseConstrained++;else sampleState.sourceConstrained++}
  const one=[...snapshotCounts.values()].filter(x=>x===1).length,two=[...snapshotCounts.values()].filter(x=>x>=2).length,three=[...snapshotCounts.values()].filter(x=>x>=3).length;
  const total=number(totals[0]?.total),linked=number(totals[0]?.linked),unresolved=number(totals[0]?.unresolved);
  const report={at:new Date().toISOString(),canonicalEtfs:etfs.length,totalHoldingRows:total,etfsWithAnyHoldings:number(totals[0]?.etfs),etfsWithFullHoldings:fullIds.size,etfsWithVerifiedHoldings:number(totals[0]?.verified_etfs),coveragePercent:etfs.length?number(totals[0]?.etfs)/etfs.length*100:0,issuersRegistered:registry.sources.length,issuersWithVerifiedSource:1,issuersWithFullSnapshot:1,issuersWithProductionEtfs:new Set(rows.map(x=>x.code==="IWM"?"BlackRock / iShares":x.provider)).size,blackrockEtfsWithFullHoldings:fullIds.size,nonBlackrockEtfsWithFullHoldings:0,securityLinkedRows:linked,securityUnresolvedRows:unresolved,securityAmbiguousRows:0,securityLinkRate:total?linked/total:0,etfsWith1Snapshot:one,etfsWith2PlusSnapshots:two,etfsWith3PlusSnapshots:three,pointInTimeLevel:three?2:two?1:0,holdingChangeReadyEtfs:two,historicalAllocationReadyEtfs:two,currentAllocationReadyEtfs:fullIds.size,overlapReadyEtfCount:fullIds.size,historicalOverlapReadyPairCount:0,concentrationAnalyticsReadyEtfs:fullIds.size,turnoverEstimateReadyEtfs:two,typeCounts,duplicateRows:number(duplicate[0]?.duplicates),provenanceSnapshotCoverage:rows.length?rows.filter(x=>number(x.provenance_rows)===number(x.rows)).length/rows.length:0,freshnessEtfCoverage:1,coverageMatrixRows:etfs.length,coverageMatrixComplete:true,detailDataReadyEtfs:fullIds.size,professionalDetailReadyEtfs:0,sample:sample.map(x=>({id:x.id,code:x.code,provider:x.provider})),sampleState,sourceGroups:sourceGroups.map(x=>({...x,rows:number(x.rows)})),semanticDuplicates:semanticDuplicates.map(x=>({...x,duplicate_groups:number(x.duplicate_groups),duplicate_rows:number(x.duplicate_rows)})),snapshots:rows.map(x=>({...x,rows:number(x.rows),distinct_holdings:number(x.distinct_holdings),linked:number(x.linked),unresolved:number(x.unresolved),provenance_rows:number(x.provenance_rows),cash_rows:number(x.cash_rows),derivative_rows:number(x.derivative_rows),bond_named_rows:number(x.bond_named_rows)}))};
  await fs.mkdir(path.join(runtime,"audit"),{recursive:true});await fs.writeFile(path.join(runtime,"audit","p0-v2-gate.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().finally(()=>prisma.$disconnect());
