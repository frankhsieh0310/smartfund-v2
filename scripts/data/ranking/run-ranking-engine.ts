import { appendFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { atomicJson } from './ranking-engine.ts'
import { disconnectRankingDb, loadCatalog, queueBackground, runCanary, seedContractsAndDefinitions } from './canonical-ranking-engine.ts'

const root=resolve(import.meta.dirname,'..','..','..'); const runtime=resolve(root,'runtime','ranking')
const checkpointFile=resolve(runtime,'checkpoint.json'); const logFile=resolve(runtime,'ranking-engine.log')
const runId=new Date().toISOString().replaceAll(':','-').replaceAll('.','-'); const startedAt=new Date().toISOString()
async function checkpoint(stage:string, extra:Record<string,unknown>={}) { await atomicJson(checkpointFile,{asset:'GLOBAL_RANKING_ENGINE',pid:process.pid,runId,stage,updatedAt:new Date().toISOString(),...extra}) }
async function log(message:string){ await mkdir(runtime,{recursive:true}); await appendFile(logFile,`${new Date().toISOString()} ${message}\n`,'utf8') }

try {
  await checkpoint('DEFINITION_VALIDATION')
  const {definitions}=await loadCatalog()
  if(definitions.length!==26 || definitions.some(d=>!d.status)) throw new Error('DEFINITION_GATE_FAILED')
  await seedContractsAndDefinitions(definitions)
  await checkpoint('CANARY_RANKING')
  const canaries=[]
  for(const definition of definitions.filter(d=>d.canary).slice(0,5)) canaries.push(await runCanary(definition))
  const queueSize=await queueBackground(definitions)
  const totals=canaries.reduce((a,x)=>({canonical:a.canonical+x.total,eligible:a.eligible+x.eligible,ranked:a.ranked+x.ranked,excluded:a.excluded+x.excluded}),{canonical:0,eligible:0,ranked:0,excluded:0})
  const rankingsWithData=canaries.filter(x=>x.ranked>0).length
  const completed=rankingsWithData>0 && totals.ranked>0
  const status=completed?'PARTIAL_COVERAGE':'BLOCKED_UPSTREAM'
  const output={version:2,runId,generatedAt:new Date().toISOString(),status,definitions:definitions.length,canaries,totals,queueSize,zeroSourceCompletionAllowed:false,zeroRecordCompletionAllowed:false}
  await atomicJson(resolve(runtime,'latest.json'),output)
  await atomicJson(resolve(runtime,'coverage-matrix.json'),{generatedAt:output.generatedAt,definitions:definitions.map(d=>({...d,canaryResult:canaries.find(c=>c.code===d.code)??null}))})
  await atomicJson(resolve(runtime,'asset-coverage-matrix.json'),{generatedAt:output.generatedAt,assets:[...new Set(definitions.map(d=>d.assetType))].map(assetType=>{const ds=definitions.filter(d=>d.assetType===assetType);return{assetType,canonicalEntityCount:canaries.filter(c=>definitions.find(d=>d.code===c.code)?.assetType===assetType).reduce((n,c)=>n+c.total,0),rankingEligibleCount:canaries.filter(c=>definitions.find(d=>d.code===c.code)?.assetType===assetType).reduce((n,c)=>n+c.eligible,0),activeRankingCount:ds.filter(d=>d.status==='READY_NOW').length,blockedRankingCount:ds.filter(d=>d.status.includes('BLOCKED')||d.status.includes('CONSTRAINED')).length}})})
  await atomicJson(resolve(runtime,'completion-manifest.json'),{asset:'GLOBAL_RANKING_ENGINE',status,runId,startedAt,completedAt:new Date().toISOString(),sourceAssetCount:5,rankedEntityCount:totals.ranked,nonEmptyRankings:rankingsWithData,completionGatePassed:completed,output:'runtime/ranking/latest.json'})
  await checkpoint(completed?'BACKGROUND_ACTIVE':'BLOCKED_UPSTREAM',{rankedEntityCount:totals.ranked,nonEmptyRankings:rankingsWithData,queueSize})
  await log(`${status} run=${runId} ranked=${totals.ranked} rankingsWithData=${rankingsWithData} queue=${queueSize}`)
} catch(error) {
  const message=error instanceof Error?error.stack??error.message:String(error)
  await checkpoint('FAILED',{error:message}); await atomicJson(resolve(runtime,'completion-manifest.json'),{asset:'GLOBAL_RANKING_ENGINE',status:'FAILED',runId,startedAt,failedAt:new Date().toISOString(),completionGatePassed:false,error:message}); await log(`FAILED run=${runId} error=${message}`); process.exitCode=1
} finally { await disconnectRankingDb() }
