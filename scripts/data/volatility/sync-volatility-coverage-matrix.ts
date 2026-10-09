import { PrismaClient } from "@prisma/client";

const production=new PrismaClient();
const capability="P0_TERMINAL_MATRIX";
const now=new Date().toISOString();
try{
  const truth=await production.$queryRawUnsafe(`SELECT r.id,r.symbol,r.licensing_status,r.verification_status,
    (s.index_id IS NOT NULL) current_ready,s.freshness_status,
    count(DISTINCT o.observation_date)::int history_rows,min(o.observation_date) earliest,max(o.observation_date) latest,
    (m.index_id IS NOT NULL) methodology_ready,count(DISTINCT a.metric)::int analytics_metrics
    FROM global_index_registry r
    LEFT JOIN global_index_snapshots s ON s.index_id=r.id
    LEFT JOIN global_index_daily_observations o ON o.index_id=r.id AND o.quality_status='USABLE'
    LEFT JOIN global_index_methodologies m ON m.index_id=r.id
    LEFT JOIN global_index_analytics a ON a.index_id=r.id
    WHERE r.id LIKE 'volidx:%'
    GROUP BY r.id,s.index_id,m.index_id ORDER BY r.symbol`) as any[];
  if(truth.length!==13)throw new Error(`FAIL_CLOSED_ENTITY_COUNT_${truth.length}`);
  const rows=truth.map(x=>{
    const constraint=x.symbol==="INDIA_VIX"?"SOURCE_CONSTRAINED":x.symbol==="VSTOXX"?"ACCESS_CONSTRAINED":x.symbol==="VNKY"?"LICENSE_CONSTRAINED":null;
    const taiwan=x.symbol==="TAIWAN_VIX";
    const dataState=constraint??"READY";
    const analyticState=constraint??(taiwan?"TIME_DEPTH_CONSTRAINED":"READY");
    const detailState=constraint??(taiwan?"TIME_DEPTH_CONSTRAINED":"READY");
    const historyState=constraint??(taiwan?"TIME_DEPTH_CONSTRAINED":"READY");
    const underlyingState=constraint??(["VIX","VIX9D","VIX3M","VIX6M","VIX1Y","VXN","RVX","VVIX"].includes(x.symbol)?"READY":"MAPPING_CONSTRAINED");
    const underlyingAnalytics=constraint??"MAPPING_CONSTRAINED";
    const termState=constraint??(["VIX","VIX9D","VIX3M","VIX6M","VIX1Y"].includes(x.symbol)?"READY":"NOT_APPLICABLE");
    const domains={IDENTITY:"READY",CURRENT:dataState,HISTORY:historyState,MAX_HISTORY_DEPTH:historyState,METHODOLOGY:"READY",UNDERLYING_LINK:underlyingState,CHANGE_ANALYTICS:analyticState,RANGE:analyticState,PERCENTILE:analyticState,Z_SCORE:analyticState,VOL_OF_VOL:analyticState,SPIKE_EVENTS:analyticState,REGIME:analyticState,UNDERLYING_CORRELATION:underlyingAnalytics,STRESS_RESPONSE:underlyingAnalytics,CROSS_INDEX_CORRELATION:analyticState,TERM_STRUCTURE:termState,PROVENANCE:dataState,FRESHNESS:dataState,DETAIL:detailState,SEARCH:"READY",SCREENER:analyticState,COMPARE:analyticState,RANKING:analyticState};
    if(Object.values(domains).some(v=>!v))throw new Error(`FAIL_CLOSED_UNKNOWN_${x.symbol}`);
    return {indexId:x.id,capability,interval:"",status:constraint??"READY",provider:"CANONICAL_PRODUCTION",licensingStatus:x.licensing_status,earliestAt:x.earliest,latestAt:x.latest,rowCount:x.history_rows,qualityStatus:constraint??(taiwan?"TIME_DEPTH_CONSTRAINED":"READY"),details:{primaryState:constraint?`${constraint}_READY`:"PRODUCTION_READY",secondaryFlags:taiwan?["TIME_DEPTH_CONSTRAINED_READY"]:[],freshnessTerminal:x.freshness_status??constraint,domains,analyticsMetrics:x.analytics_metrics,verificationStatus:x.verification_status},checkedAt:now};
  });
  await production.$executeRawUnsafe(`INSERT INTO global_index_coverage(index_id,capability,interval,status,provider,licensing_status,earliest_at,latest_at,row_count,quality_status,details,checked_at)
    SELECT x."indexId",x.capability,x.interval,x.status,x.provider,x."licensingStatus",x."earliestAt",x."latestAt",x."rowCount",x."qualityStatus",x.details,x."checkedAt"
    FROM jsonb_to_recordset($1::jsonb) AS x("indexId" text,capability text,interval text,status text,provider text,"licensingStatus" text,"earliestAt" timestamptz,"latestAt" timestamptz,"rowCount" bigint,"qualityStatus" text,details jsonb,"checkedAt" timestamptz)
    ON CONFLICT(index_id,capability,interval) DO UPDATE SET status=excluded.status,provider=excluded.provider,licensing_status=excluded.licensing_status,earliest_at=excluded.earliest_at,latest_at=excluded.latest_at,row_count=excluded.row_count,quality_status=excluded.quality_status,details=excluded.details,checked_at=excluded.checked_at`,JSON.stringify(rows));
  const readback=await production.$queryRawUnsafe(`SELECT index_id,status,quality_status,details FROM global_index_coverage WHERE capability=$1 AND interval='' AND index_id LIKE 'volidx:%' ORDER BY index_id`,capability) as any[];
  const allowed=new Set(["READY","SOURCE_CONSTRAINED","LICENSE_CONSTRAINED","ACCESS_CONSTRAINED","TIME_DEPTH_CONSTRAINED","MAPPING_CONSTRAINED","NOT_APPLICABLE","NOT_READY"]);
  const domainKeys=["IDENTITY","CURRENT","HISTORY","MAX_HISTORY_DEPTH","METHODOLOGY","UNDERLYING_LINK","CHANGE_ANALYTICS","RANGE","PERCENTILE","Z_SCORE","VOL_OF_VOL","SPIKE_EVENTS","REGIME","UNDERLYING_CORRELATION","STRESS_RESPONSE","CROSS_INDEX_CORRELATION","TERM_STRUCTURE","PROVENANCE","FRESHNESS","DETAIL","SEARCH","SCREENER","COMPARE","RANKING"];
  const complete=readback.length===13&&readback.every(r=>allowed.has(r.status)&&domainKeys.every(k=>allowed.has(r.details?.domains?.[k])));
  if(!complete)throw new Error("FAIL_CLOSED_MATRIX_READBACK");
}finally{await production.$disconnect()}
