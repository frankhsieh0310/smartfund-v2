import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma=new PrismaClient();
const queuePath=resolve("runtime","index","history-route-queue.json");
const auditPath=resolve("runtime","index","history-density-audit.json");
const DAY=86400000;
function weekdays(a:Date,b:Date){let n=0;for(let t=Date.UTC(a.getUTCFullYear(),a.getUTCMonth(),a.getUTCDate());t<=b.getTime();t+=DAY){const d=new Date(t).getUTCDay();if(d!==0&&d!==6)n++}return n}
async function atomic(path:string,value:unknown){const tmp=`${path}.${process.pid}.tmp`;await writeFile(tmp,`${JSON.stringify(value,null,2)}\n`);await rename(tmp,path)}

async function main(){
  const queue=JSON.parse(await readFile(queuePath,"utf8"));
  const rows=await prisma.$queryRawUnsafe<Array<{id:string;name:string;provider:string;symbol:string|null;provider_external_id:string|null;currency:string|null;rows:bigint;earliest:Date|null;latest:Date|null}>>(`
    SELECT r.id,r.name,r.provider,r.symbol,r.provider_external_id,r.currency,
      count(c.timestamp)::bigint rows,min(c.timestamp) earliest,max(c.timestamp) latest
    FROM global_index_registry r LEFT JOIN global_index_candles c ON c.index_id=r.id AND c.interval='1d'
    GROUP BY r.id,r.name,r.provider,r.symbol,r.provider_external_id,r.currency ORDER BY r.id`);
  const now=new Date(),audit=rows.map(r=>{const actual=Number(r.rows),expected=r.earliest&&r.latest?weekdays(r.earliest,r.latest):0,coverage=expected?actual/expected:0;return{index:r.id,name:r.name,provider:r.provider,rows:actual,earliest:r.earliest?.toISOString()??null,latest:r.latest?.toISOString()??null,history_years:r.earliest&&r.latest?Number(((r.latest.getTime()-r.earliest.getTime())/(365.25*DAY)).toFixed(2)):0,expected_trading_days:expected,actual_rows:actual,coverage_ratio:Number(coverage.toFixed(4)),stale:r.latest?now.getTime()-r.latest.getTime()>14*DAY:true}});
  const priority=new Set(["sp-500","ftse-100","stoxx-europe-600","csi-300","psei","set-index","sti","klci","jakarta-composite","vn-index","hang-seng","taiwan-otc"]);
  for(const r of rows){if(!priority.has(r.id)||queue.items?.some((x:any)=>x.id===r.id))continue;queue.items.push({id:r.id,name:r.name,provider:r.provider,symbol:r.provider_external_id??r.symbol,provider_external_id:r.provider_external_id,currency:r.currency,status:"FULL_HISTORY_PENDING",reason:"MAJOR_MARKET_FULL_HISTORY_PRIORITY",owner:"GLOBAL_INDEX",ownerPid:queue.ownerPid,checkpoint:null,attempts:0})}
  let queued=0;
  for(const item of queue.items??[]){const d=audit.find(x=>x.index===item.id);if(!d)continue;item.rows=d.rows;item.latest=d.latest;item.coverageRatio=d.coverage_ratio;item.expectedTradingDays=d.expected_trading_days;
    const deterministic=typeof item.symbol==="string"&&item.symbol.length>0&&!String(item.reason??"").includes("LICENSE");
    const needs=priority.has(item.id)||d.rows===0||d.coverage_ratio<0.7||d.stale;
    if(deterministic&&needs&&!['LICENSE_CONSTRAINED','SOURCE_LIMITED','ACCESS_CONSTRAINED'].includes(item.status)){item.status="FULL_HISTORY_PENDING";item.reason="DENSITY_AUDIT_CHECKPOINTED_FULL_DAILY_BACKFILL";item.updatedAt=new Date().toISOString();queued++}
  }
  queue.ownerPid=Number(JSON.parse(await readFile(resolve("runtime","index","heartbeat.json"),"utf8")).pid??queue.ownerPid);queue.mode="OWNER_SCOPED_DENSITY_GAP_BACKFILL";queue.updatedAt=new Date().toISOString();
  await atomic(queuePath,queue);await atomic(auditPath,{asset:"GLOBAL_INDEX",generatedAt:new Date().toISOString(),totalIndexes:audit.length,queued,threshold:0.7,indexes:audit});
  console.log(JSON.stringify({totalIndexes:audit.length,queued,auditPath,queuePath}));
}
main().finally(()=>prisma.$disconnect());
