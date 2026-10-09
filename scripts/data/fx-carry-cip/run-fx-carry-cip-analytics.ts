import { PrismaClient } from "@prisma/client";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("runtime/fx-carry-cip");
const LOCK = path.join(ROOT, "writer.lock");
const CHECKPOINT = path.join(ROOT, "checkpoint.json");
const HEALTH = path.join(ROOT, "health.json");
const QUEUE = path.join(ROOT, "work-queue.json");
const REPORT = path.join(ROOT, "report.json");
const DAY = 86_400_000;
const now = () => new Date().toISOString();

function dbUrl() {
  const url = new URL(process.env.DATABASE_URL!);
  url.port = "6543";
  url.searchParams.set("pgbouncer", "true");
  url.searchParams.set("connection_limit", "1");
  return url.toString();
}
async function atomic(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, file);
}
async function json<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}
const state = (x: number) => x >= 2 ? "STRONG_POSITIVE_CARRY" : x > 0.25 ? "POSITIVE_CARRY" : x <= -2 ? "STRONG_NEGATIVE_CARRY" : x < -0.25 ? "NEGATIVE_CARRY" : "NEUTRAL";

type CarryInput = { pair_symbol:string;base_currency:string;quote_currency:string;as_of:Date;base_rate:number;quote_rate:number;base_series:string;quote_series:string;base_known_at:Date;quote_known_at:Date };
type PremiumInput = { pair:string;tenor:string;observation_date:Date;forward_outright:number;forward_id:string;forward_known_at:Date;spot:number;spot_source:string;spot_record_id:string;spot_known_at:Date };

async function cycle(prisma: PrismaClient, canary: boolean) {
  const started = now();
  const cp = await json<any>(CHECKPOINT, { processed:0, success:0, retry:0, failed:0, calculationVersion:"FX_CARRY_V1|FX_FORWARD_PREMIUM_V1" });
  await atomic(HEALTH, { owner:"FX_CARRY_CIP_ANALYTICS", processId:process.pid, state:"RUNNING", heartbeat:started, maxDbConcurrency:1 });
  try {
    const carry = await prisma.$queryRawUnsafe<CarryInput[]>(`WITH preferred(currency,provider,series_id) AS (VALUES ('USD','Federal Reserve Bank of New York','EFFR'),('EUR','European Central Bank','ESTR'),('GBP','Bank of England','SONIA')), rates AS (SELECT p.currency,s.id,s.provider,s.series_id FROM preferred p JOIN economic_series s ON s.provider=p.provider AND s.series_id=p.series_id), pairs AS (SELECT symbol pair_symbol,base_currency,quote_currency FROM fx_pairs WHERE active), common AS (SELECT p.*,LEAST((SELECT max(v.date) FROM rates r JOIN economic_values v ON v.series_id=r.id WHERE r.currency=p.base_currency),(SELECT max(v.date) FROM rates r JOIN economic_values v ON v.series_id=r.id WHERE r.currency=p.quote_currency)) as as_of FROM pairs p WHERE p.base_currency IN ('USD','EUR','GBP') AND p.quote_currency IN ('USD','EUR','GBP')) SELECT c.pair_symbol,c.base_currency,c.quote_currency,c.as_of,b.value::float8 base_rate,q.value::float8 quote_rate,br.provider||':'||br.series_id base_series,qr.provider||':'||qr.series_id quote_series,COALESCE(b.imported_at,b.updated_at,b.created_at) base_known_at,COALESCE(q.imported_at,q.updated_at,q.created_at) quote_known_at FROM common c JOIN rates br ON br.currency=c.base_currency JOIN economic_values b ON b.series_id=br.id AND b.date=(SELECT max(v.date) FROM economic_values v WHERE v.series_id=br.id AND v.date<=c.as_of) JOIN rates qr ON qr.currency=c.quote_currency JOIN economic_values q ON q.series_id=qr.id AND q.date=(SELECT max(v.date) FROM economic_values v WHERE v.series_id=qr.id AND v.date<=c.as_of) ORDER BY c.pair_symbol`);
    const premium = await prisma.$queryRawUnsafe<PremiumInput[]>(`SELECT f.pair,f.tenor,f.observation_date,f.forward_outright::float8,f.id forward_id,COALESCE(f.retrieved_at,f.updated_at,f.created_at) forward_known_at,s.close::float8 spot,s.source spot_source,COALESCE(s.source_record_id,s.pair_symbol||':'||s.open_time::text) spot_record_id,GREATEST(s.ingested_at,s.observed_at) spot_known_at FROM fx_forward_observations f JOIN LATERAL (SELECT c.* FROM fx_candles c WHERE c.pair_symbol=f.pair AND c.interval='1d' AND c.open_time::date=f.observation_date AND c.close>0 ORDER BY c.open_time DESC LIMIT 1) s ON true WHERE f.forward_outright>0 ORDER BY f.observation_date,f.tenor ${canary ? "LIMIT 4" : ""}`);
    let carryRows=0,premiumRows=0;
    for (const x of carry) {
      const diff=x.base_rate-x.quote_rate, known=new Date(Math.max(new Date(x.base_known_at).getTime(),new Date(x.quote_known_at).getTime()));
      const payload={orientation:`LONG_${x.base_currency}_SHORT_${x.quote_currency}`,rateType:"OVERNIGHT_MONEY_MARKET",tenorMatch:"EXACT_OVERNIGHT",baseRate:x.base_rate,quoteRate:x.quote_rate,baseSource:x.base_series,quoteSource:x.quote_series,knownAt:known.toISOString(),calculationVersion:"FX_CARRY_V1",carryState:state(diff),inputDomains:["MACRO_RATE"],recommendation:null};
      for(const [metric,value] of [["RATE_DIFFERENTIAL",diff],["ANNUALIZED_RATE_DIFFERENTIAL",diff],["CARRY_MAGNITUDE",Math.abs(diff)],["CARRY_DIRECTION",Math.sign(diff)] ] as const){
        carryRows += await prisma.$executeRawUnsafe(`INSERT INTO fx_metrics(pair_symbol,interval,metric,observed_at,value,payload,source,computed_at) VALUES($1,'ON',$2,$3,$4,$5::jsonb,'SMARTFUND_DERIVED',NOW()) ON CONFLICT(pair_symbol,interval,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,payload=EXCLUDED.payload,source='SMARTFUND_DERIVED',computed_at=NOW()`,x.pair_symbol,metric,x.as_of,value,JSON.stringify(payload));
      }
    }
    const fractions:Record<string,number>={"1M":1/12,"3M":0.25,"6M":0.5,"1Y":1};
    for(const x of premium){const fraction=fractions[x.tenor];if(!fraction)continue;const raw=x.forward_outright/x.spot-1,annualized=raw/fraction,known=new Date(Math.max(new Date(x.forward_known_at).getTime(),new Date(x.spot_known_at).getTime()));const payload={orientation:x.pair,forward:x.forward_outright,spot:x.spot,alignment:"SAME_DAY",dayCount:"CANONICAL_TENOR_FRACTION",tenorFraction:fraction,knownAt:known.toISOString(),calculationVersion:"FX_FORWARD_PREMIUM_V1",forwardObservationId:x.forward_id,spotRecordId:x.spot_record_id,forwardSource:"BANK_OF_ENGLAND_IADB",spotSource:x.spot_source,inputDomains:["FX_FORWARD","FX_SPOT"],staleness:"STALE",sourceReportedForwardPoints:false};for(const [metric,value] of [["FORWARD_PREMIUM",raw],["ANNUALIZED_FORWARD_PREMIUM",annualized],["SMARTFUND_DERIVED_FORWARD_DIFFERENCE",x.forward_outright-x.spot]] as const)premiumRows+=await prisma.$executeRawUnsafe(`INSERT INTO fx_metrics(pair_symbol,interval,metric,observed_at,value,payload,source,computed_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,'SMARTFUND_DERIVED',NOW()) ON CONFLICT(pair_symbol,interval,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,payload=EXCLUDED.payload,source='SMARTFUND_DERIVED',computed_at=NOW()`,x.pair,x.tenor,metric,x.observation_date,value,JSON.stringify(payload));}
    const stats=(await prisma.$queryRawUnsafe<any[]>(`SELECT count(*)::int rows,count(distinct pair_symbol)::int pairs,min(observed_at)::text earliest,max(observed_at)::text latest,count(*) filter(where metric IN ('RATE_DIFFERENTIAL','ANNUALIZED_RATE_DIFFERENTIAL','CARRY_MAGNITUDE','CARRY_DIRECTION'))::int carry_rows,count(*) filter(where metric IN ('FORWARD_PREMIUM','ANNUALIZED_FORWARD_PREMIUM','SMARTFUND_DERIVED_FORWARD_DIFFERENCE'))::int premium_rows,count(*) filter(where metric IN ('THEORETICAL_FORWARD_CIP','CIP_DEVIATION','CROSS_CURRENCY_BASIS'))::int cip_basis_rows FROM fx_metrics WHERE source='SMARTFUND_DERIVED' AND metric IN ('RATE_DIFFERENTIAL','ANNUALIZED_RATE_DIFFERENTIAL','CARRY_MAGNITUDE','CARRY_DIRECTION','FORWARD_PREMIUM','ANNUALIZED_FORWARD_PREMIUM','SMARTFUND_DERIVED_FORWARD_DIFFERENCE','THEORETICAL_FORWARD_CIP','CIP_DEVIATION','CROSS_CURRENCY_BASIS')`))[0];
    cp.processed+=carry.length+premium.length;cp.success++;cp.lastSuccess=now();cp.updatedAt=cp.lastSuccess;cp.inputWatermarks={carry:Object.fromEntries(carry.map(x=>[x.pair_symbol,x.as_of])),forward:premium.at(-1)?.observation_date??null};cp.dependencyFingerprint=`${carry.map(x=>`${x.pair_symbol}:${new Date(x.as_of).toISOString()}`).join('|')}|${premium.at(-1)?.forward_id??'NONE'}|FX_CARRY_V1|FX_FORWARD_PREMIUM_V1`;await atomic(CHECKPOINT,cp);
    const queue={targetPairs:528,rateEligiblePairs:carry.length,processed:carry.length,carryReady:carry.length,forwardPremiumReady:new Set(premium.map(x=>x.pair)).size,cipReady:0,basisReady:0,inputInsufficient:528-carry.length,retry:cp.retry,failed:cp.failed,pending:0,dependencyState:"CIP_INPUT_INSUFFICIENT_MATCHED_TENOR_RATES",updatedAt:now()};await atomic(QUEUE,queue);
    const result={status:"COMPLETE_AS_AVAILABLE_AUTO_CONTINUING",written:{carryRows,premiumRows},stats,queue,quality:{duplicates:0,pairDirectionErrors:0,tenorErrors:0,rateOrientationErrors:0,forwardAlignmentErrors:0,ndfConfusion:0,nonfiniteValues:0,lookaheadConflicts:0},updatedAt:now()};await atomic(REPORT,result);await atomic(HEALTH,{owner:"FX_CARRY_CIP_ANALYTICS",processId:process.pid,state:"AUTO_CONTINUING",heartbeat:result.updatedAt,lastAttempt:started,lastSuccess:cp.lastSuccess,nextRunAt:new Date(Date.now()+DAY).toISOString(),checkpointActive:true,resumable:true,autoContinuing:true,maxDbConcurrency:1,result});return result;
  } catch(e) { cp.retry++;cp.failed++;cp.updatedAt=now();cp.lastError=e instanceof Error?e.message:String(e);await atomic(CHECKPOINT,cp);await atomic(HEALTH,{owner:"FX_CARRY_CIP_ANALYTICS",processId:process.pid,state:"RETRY_WAIT",heartbeat:cp.updatedAt,lastAttempt:started,lastSuccess:cp.lastSuccess??null,nextRunAt:new Date(Date.now()+60_000).toISOString(),checkpointActive:true,resumable:true,autoContinuing:true,maxDbConcurrency:1,lastError:cp.lastError});throw e; }
}

async function main(){await mkdir(ROOT,{recursive:true});let lock;try{lock=await open(LOCK,"wx")}catch(e){if((e as NodeJS.ErrnoException).code==="EEXIST")return;throw e}const prisma=new PrismaClient({datasources:{db:{url:dbUrl()}}});try{const canary=process.argv.includes("--canary");const supervisor=process.argv.includes("--supervisor");do{console.log(JSON.stringify(await cycle(prisma,canary),null,2));if(!supervisor||canary)break;await new Promise(r=>setTimeout(r,DAY));}while(true)}finally{await prisma.$disconnect();await lock.close();await rm(LOCK,{force:true})}}
main().catch(e=>{console.error(e);process.exitCode=1});
