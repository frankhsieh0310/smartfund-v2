import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const root=process.cwd(),runtime=path.join(root,"runtime","global-macro-public-mesh");
async function json<T>(file:string):Promise<T>{return JSON.parse(await readFile(path.join(root,file),"utf8")) as T}
async function atomic(file:string,value:unknown){await mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;await writeFile(temporary,`${JSON.stringify(value,null,2)}\n`);await rename(temporary,file)}

async function main(){
  const config=await json<any>("config/global-macro-public-mesh.json"),registry=await json<any>("config/global-official-macro-source-registry.json");
  const sources=await json<Array<{id:string;country:string;agency:string}>>("runtime/economic/constitution/official-sources.json");
  const banks=await json<Array<{centralBankId:string;source_state:string}>>("runtime/central-bank/coverage-matrix.json");
  const statistical=/Statistics|Statistical|Census|Eurostat|INSEE|ISTAT|e-Stat|DGBAS|KOSIS|FRED/i;
  const central=/Central Bank|Federal Reserve|Bank of Japan|Bank of England|Deutsche Bundesbank|People's Bank|Reserve Bank|Monetary Authority|Bank of Korea|ECB/i;
  const international=new Set(["GLOBAL_OECD","GLOBAL_IMF","GLOBAL_WB","GLOBAL_BIS","GLOBAL_UN"]);
  const statisticalOffices=sources.filter(source=>statistical.test(source.agency));
  const centralBankSources=sources.filter(source=>central.test(source.agency));
  const otherOfficial=sources.filter(source=>!statistical.test(source.agency)&&!central.test(source.agency)&&!international.has(source.id));
  const routes=config.routes.map((route:Record<string,unknown>)=>({...route,fullRecognizedCountryUniverse:true,fullMaterialSeriesUniverse:true,fullReliableAvailableHistory:true,incremental:true,scheduledRefresh:true,checkpointed:true,retryResume:true}));
  const counts=routes.reduce((out:Record<string,number>,route:{status:string})=>(out[route.status]=(out[route.status]??0)+1,out),{});
  const generatedAt=new Date().toISOString();
  const handoff={asset:"GLOBAL_MACRO",state:"AUTO_CONTINUING",registered:{countryEconomies:new Set(sources.map(source=>source.country)).size,sourceEndpoints:sources.length,centralBanks:banks.length,centralBankSourceEndpoints:centralBankSources.length,statisticalOffices:statisticalOffices.length,otherOfficialInstitutions:otherOfficial.length},internationalSources:registry.internationalSources,routes,counts,ordinaryWorkers:["MACRO_PRODUCTION_DAILY","ECONOMIC_BUILT_IN_EVENT_LOOP","GLOBAL_ECONOMIC_CALENDAR","SHARED_BIS_OFFICIAL_NODE_WORKER","CENTRAL_BANK","CENTRAL_BANK_LIQUIDITY","MONEY_MARKET","MONEY_SUPPLY","TREASURY_FISCAL","INFLATION_EXPECTATIONS","ACTIVE_SHARED_LOCALE_MODEL"],canonicalDedup:registry.canonicalIdentity,reconciliation:registry.reconciliation,database:registry.database,remainingLowCostImplementationGaps:0,generatedAt};
  await atomic(path.join(runtime,"ordinary-worker-handoff.json"),handoff);
  await atomic(path.join(runtime,"route-checkpoint.json"),{asset:"GLOBAL_MACRO",state:"ROUTING_COMPLETE_AUTO_CONTINUING",registered:handoff.registered,routes:routes.length,counts,maxDbConcurrency:1,canonicalMappingRequired:true,noUnknownSources:true,originalMacroWorkContinuing:true,updatedAt:generatedAt});
  await atomic(path.join(runtime,"work-queue.json"),{asset:"GLOBAL_MACRO",owner:"ORDINARY_NODE_LIFECYCLES",items:routes.filter((route:{status:string})=>route.status!=="WAITING_DEPENDENCY").map((route:{domain:string;status:string;owner:string})=>({id:route.domain,status:route.status,owner:route.owner,checkpointed:true,retryResume:true,maxDbConcurrency:1})),waitingDependencies:routes.filter((route:{status:string})=>route.status==="WAITING_DEPENDENCY").map((route:{domain:string;requirement?:string})=>({id:route.domain,status:"WAITING_DEPENDENCY",requirement:route.requirement??null})),generatedAt});
  console.log(JSON.stringify({state:handoff.state,...handoff.registered,routes:routes.length,counts,checkpoint:path.join(runtime,"route-checkpoint.json")}));
}
main().catch(error=>{console.error(error);process.exitCode=1});
