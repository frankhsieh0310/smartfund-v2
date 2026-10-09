import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { publishFixedIncomeRuntimeStatus } from "../runtime-status/publish-fixed-income-runtime-status.ts";

type GapState = "DELEGATED_EXISTING_WORKER"|"PENDING"|"RUNNING"|"COMPLETE"|"RETRY_WAIT"|"BLOCKED";
type Gap = { gap_id:string; priority:string; domain:string; subdomain:string; target_worker:string; work_type:string; state:GapState; attempts:number; checkpoint:string|null; started_at?:string|null; updated_at?:string|null; completed_at?:string|null; last_error?:string|null; next_eligible_at?:string|null };
type Queue = { asset:string; status:string; items:Gap[]; [key:string]:unknown };
type Json = Record<string,any>;

const root=process.cwd(),queuePath=path.join(root,"runtime","fixed-income","depth-gap-work-queue.json"),lockPath=path.join(root,"runtime","fixed-income","gap-consumer.lock");
const MAX_DB_CONCURRENCY=1,MAX_DB_RETRIES=3;
const now=()=>new Date().toISOString();
const json=async<T>(file:string,fallback:T)=>readFile(file,"utf8").then(v=>JSON.parse(v) as T).catch(()=>fallback);
async function atomic(file:string,value:unknown){await mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;await writeFile(temporary,`${JSON.stringify(value,null,2)}\n`);await rename(temporary,file)}
const isDbCapacity=(error:unknown)=>/EMAXCONNSESSION|max clients reached in session mode|too many clients|Disk IO Budget/i.test(error instanceof Error?error.message:String(error));
function alive(pid:unknown){if(!Number.isInteger(pid))return false;try{process.kill(pid as number,0);return true}catch{return false}}
async function acquireConsumerLock(){
  await mkdir(path.dirname(lockPath),{recursive:true});
  for(let attempt=0;attempt<2;attempt+=1){
    try{const handle=await open(lockPath,"wx");await handle.writeFile(JSON.stringify({pid:process.pid,at:now()}));return handle}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const prior=await json<Json>(lockPath,{});if(alive(prior.pid))return null;await unlink(lockPath).catch(()=>undefined)}
  }
  return null;
}

async function execute(gap:Gap):Promise<{complete:boolean;checkpoint:string;error?:string;blocked?:boolean}> {
  const [coverage,registry,incremental,yieldQuality,spreadAnalytics]=await Promise.all([
    json<Json>(path.join(root,"runtime","bond","professional-depth","coverage.json"),{}),json<Json>(path.join(root,"config","global-individual-bond-registry.json"),{}),json<Json>(path.join(root,"runtime","bond","incremental","checkpoint.json"),{}),json<Json>(path.join(root,"runtime","government-yield","products","quality.json"),{}),json<Json>(path.join(root,"runtime","credit-spread","analytics.json"),{}),
  ]);
  const cp=`${incremental.scope??"UNKNOWN"}:${incremental.updatedAt??now()}`;
  switch(gap.gap_id){
    case "FIXED-INCOME-GAP-001": return Number(coverage.verified_links)===Number(coverage.total_eligible)&&Number(coverage.unresolved_links)===0?{complete:true,checkpoint:`${cp}:verified_links=${coverage.verified_links}/${coverage.total_eligible}`}:{complete:false,checkpoint:cp,error:`UNRESOLVED_LINKS_${coverage.unresolved_links??"UNKNOWN"}`};
    case "FIXED-INCOME-GAP-002": return {complete:false,checkpoint:cp,error:"ISSUER_COVERAGE_NOT_MEASURABLE_FROM_EXISTING_METADATA",blocked:true};
    case "FIXED-INCOME-GAP-003": return Number(coverage.unresolved_links)===0?{complete:true,checkpoint:`${cp}:identifier_links=${coverage.verified_links}`}:{complete:false,checkpoint:cp,error:"IDENTIFIER_MAPPING_REMAINS"};
    case "FIXED-INCOME-GAP-004": {const total=(registry.governmentRegistry?.length??0)+(registry.corporateRegistry?.length??0)+(registry.specialRegistry?.length??0);return total>0?{complete:true,checkpoint:`${cp}:classified_registry_scopes=${total}`}:{complete:false,checkpoint:cp,error:"CLASSIFICATION_REGISTRY_EMPTY"};}
    case "FIXED-INCOME-GAP-005": return Number(coverage.maturity_covered)>0&&Number(coverage.coupon_covered)>0?{complete:true,checkpoint:`${cp}:maturity=${coverage.maturity_covered}:coupon=${coverage.coupon_covered}`}:{complete:false,checkpoint:cp,error:`TERMS_INPUT_CONSTRAINED:maturity=${coverage.maturity_covered??0}:coupon=${coverage.coupon_covered??0}`,blocked:true};
    case "FIXED-INCOME-GAP-009": return Number(coverage.observed_instruments)>0?{complete:true,checkpoint:`${cp}:explicit_yield_semantics_contract:observed=${coverage.observed_instruments}`}:{complete:false,checkpoint:cp,error:"NO_VERIFIED_YIELD_OBSERVATIONS"};
    case "FIXED-INCOME-GAP-025": {const series=Object.values(spreadAnalytics);const ready=Number(yieldQuality.series)>0&&series.length>0&&series.every((x:any)=>x.change1WBps!==undefined&&x.percentile1Y!==undefined);return ready?{complete:true,checkpoint:`yield_series=${yieldQuality.series}:spread_series=${series.length}:analytics_verified`}:{complete:false,checkpoint:`yield_series=${yieldQuality.series??0}:spread_series=${series.length}`,error:"DERIVED_ANALYTICS_INPUT_NOT_READY"};}
    case "FIXED-INCOME-GAP-029": return incremental.updatedAt?{complete:true,checkpoint:`${cp}:source_checkpoint_freshness_projection`}:{complete:false,checkpoint:cp,error:"PROVENANCE_CHECKPOINT_NOT_READY"};
    default:return {complete:false,checkpoint:cp,error:"UNSUPPORTED_GAP",blocked:true};
  }
}

export async function consumeOneFixedIncomeDepthGap():Promise<Gap|null>{
  const lock=await acquireConsumerLock();if(!lock)return null;
  try{
    const queue=await json<Queue>(queuePath,{asset:"FIXED_INCOME",status:"EMPTY",items:[]});
    for(const item of queue.items)if(item.state==="RUNNING"&&Date.parse(item.updated_at??item.started_at??"")<Date.now()-30*60_000){item.state="PENDING";item.last_error="ORPHANED_GAP_CLAIM_RECOVERED";item.updated_at=now()}
    const eligible=queue.items.find(item=>["DELEGATED_EXISTING_WORKER","PENDING"].includes(item.state)||(item.state==="RETRY_WAIT"&&Date.parse(item.next_eligible_at??"")<=Date.now()));
    if(!eligible){queue.status=queue.items.every(item=>["COMPLETE","BLOCKED"].includes(item.state))?"COMPLETE_OR_BLOCKED":"SCHEDULED_WAIT";await atomic(queuePath,queue);await publishFixedIncomeRuntimeStatus();return null}
    eligible.state="RUNNING";eligible.attempts=Number(eligible.attempts??0)+1;eligible.started_at=eligible.started_at??now();eligible.updated_at=now();eligible.completed_at=null;eligible.last_error=null;queue.status="RUNNING";await atomic(queuePath,queue);await publishFixedIncomeRuntimeStatus();
    try{
      const result=await execute(eligible);eligible.checkpoint=result.checkpoint;eligible.updated_at=now();
      if(result.complete){eligible.state="COMPLETE";eligible.completed_at=eligible.updated_at;eligible.last_error=null}
      else if(result.blocked){eligible.state="BLOCKED";eligible.last_error=result.error??"BLOCKED"}
      else{eligible.state="RETRY_WAIT";eligible.last_error=result.error??"RETRY_REQUIRED";eligible.next_eligible_at=new Date(Date.now()+15*60_000).toISOString()}
    }catch(error){eligible.updated_at=now();eligible.last_error=error instanceof Error?error.message:String(error);if(isDbCapacity(error)&&eligible.attempts<MAX_DB_RETRIES){eligible.state="RETRY_WAIT";eligible.next_eligible_at=new Date(Date.now()+15*60_000).toISOString()}else{eligible.state="BLOCKED"}}
    const completed=queue.items.filter(item=>item.state==="COMPLETE").length,pending=queue.items.some(item=>["DELEGATED_EXISTING_WORKER","PENDING","RUNNING","RETRY_WAIT"].includes(item.state));queue.status=pending?"ACTIVE":"COMPLETE_OR_BLOCKED";(queue as any).consumer={mode:"EXISTING_WORKER_HOOK",dbPoolMode:"SUPABASE_TRANSACTION_POOLING_PREFERRED",maxDbConcurrency:MAX_DB_CONCURRENCY,actualDbConcurrency:0,maxDbCapacityRetries:MAX_DB_RETRIES,completed,updatedAt:now()};await atomic(queuePath,queue);await publishFixedIncomeRuntimeStatus();return eligible;
  }finally{await lock?.close().catch(()=>undefined);await unlink(lockPath).catch(()=>undefined)}
}

if(process.argv[1]?.replaceAll("\\","/").endsWith("/consume-fixed-income-depth-gap.ts")){consumeOneFixedIncomeDepthGap().then(g=>console.log(JSON.stringify(g))).catch(e=>{console.error(e);process.exitCode=1})}
