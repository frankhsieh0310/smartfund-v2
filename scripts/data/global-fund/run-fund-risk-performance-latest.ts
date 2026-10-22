import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const prisma = new PrismaClient();
const runtimeDir = resolve("runtime/global-fund/risk-performance");
const registry = JSON.parse(readFileSync(resolve("config/fund-risk-performance-canary.json"), "utf8"));
const DAY = 86_400_000;
type Point = { date: Date; nav: number };
type Metric = { code: string; period: string; value: number; count: number; start: Date; end: Date; method: string };

async function atomicJson(name: string, value: unknown) {
  await mkdir(runtimeDir, { recursive: true }); const path = resolve(runtimeDir, name);
  const temporary = `${path}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); await rename(temporary, path);
}
const days = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / DAY;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const stdev = (v: number[]) => { const m = mean(v); return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, v.length - 1)); };
function nearestPrior(points: Point[], target: Date, toleranceDays: number) { const p = [...points].reverse().find((x) => x.date <= target); return p && days(p.date, target) <= toleranceDays ? p : null; }
function window(points: Point[], years: number, medianGap: number) {
  const end = points.at(-1)!; const target = new Date(end.date); target.setUTCFullYear(target.getUTCFullYear() - years);
  const start = nearestPrior(points, target, Math.max(31, medianGap * 5)); if (!start) return null;
  const values = points.filter((x) => x.date >= start.date && x.date <= end.date);
  const expected = (medianGap <= 2 ? 252 : 365 / medianGap) * years; return values.length >= Math.max(12, Math.floor(expected * 0.65)) ? values : null;
}
function metrics(points: Point[]): Metric[] {
  if (points.length < 2) return [];
  const gaps = points.slice(1).map((p, i) => days(p.date, points[i].date)).sort((a, b) => a - b);
  const medianGap = Math.max(1, gaps[Math.floor(gaps.length / 2)]); const annualPeriods = medianGap <= 2 ? 252 : 365 / medianGap;
  const out: Metric[] = []; const end = points.at(-1)!;
  const addReturn = (code: string, period: string, target: Date, annualized = false) => {
    const start = nearestPrior(points, target, Math.max(31, medianGap * 5)); if (!start || start.nav <= 0) return;
    const years = days(end.date, start.date) / 365.2425; const raw = end.nav / start.nav - 1;
    const value = annualized ? (end.nav / start.nav) ** (1 / years) - 1 : raw;
    if (Number.isFinite(value)) out.push({ code, period, value, count: points.filter((x) => x.date >= start.date).length, start: start.date, end: end.date, method: annualized ? "PRICE_NAV_CAGR_NEAREST_PRIOR" : "PRICE_NAV_RETURN_NEAREST_PRIOR" });
  };
  for (const [code, months] of [["RETURN_1M",1],["RETURN_3M",3],["RETURN_6M",6]] as const) { const t=new Date(end.date);t.setUTCMonth(t.getUTCMonth()-months);addReturn(code,`${months}M`,t); }
  const ytd = new Date(Date.UTC(end.date.getUTCFullYear(), 0, 1)); addReturn("RETURN_YTD", "YTD", ytd);
  for (const y of [1,3,5] as const) { const w=window(points,y,medianGap); if(w){ const t=new Date(end.date);t.setUTCFullYear(t.getUTCFullYear()-y);addReturn(`RETURN_${y}Y${y>1?'_ANNUALIZED':''}`,`${y}Y`,t,y>1); } }
  const inceptionYears=days(end.date,points[0].date)/365.2425; if(inceptionYears>=1) addReturn("RETURN_SINCE_INCEPTION_ANNUALIZED","SINCE_INCEPTION",points[0].date,true);
  const risk = (period: 1|3|5) => { const w=window(points,period,medianGap); if(!w) return;
    const rs=w.slice(1).map((p,i)=>p.nav/w[i].nav-1).filter(Number.isFinite); if(rs.length<12)return;
    const vol=stdev(rs)*Math.sqrt(annualPeriods); let peak=w[0].nav, maxDd=0; for(const p of w){peak=Math.max(peak,p.nav);maxDd=Math.min(maxDd,p.nav/peak-1);}
    const annualMean=mean(rs)*annualPeriods; const downside=Math.sqrt(mean(rs.map((r)=>Math.min(0,r)**2)))*Math.sqrt(annualPeriods);
    const base={period:`${period}Y`,count:rs.length,start:w[0].date,end:w.at(-1)!.date};
    for(const m of [
      {code:`VOLATILITY_${period}Y`,value:vol,method:"OBSERVED_FREQUENCY_ANNUALIZED_VOLATILITY"},
      {code:`MAX_DRAWDOWN_${period}Y`,value:maxDd,method:"PRICE_NAV_PEAK_TO_TROUGH"},
      {code:`SHARPE_${period}Y`,value:annualMean/vol,method:"SHARPE_RF_ZERO"},
      {code:`SORTINO_${period}Y`,value:downside?annualMean/downside:NaN,method:"SORTINO_TARGET_ZERO"},
    ]) if(Number.isFinite(m.value)) out.push({...base,...m});
  }; for(const y of [1,3,5] as const) risk(y);
  let peak=points[0].nav,maxDd=0;for(const p of points){peak=Math.max(peak,p.nav);maxDd=Math.min(maxDd,p.nav/peak-1);}out.push({code:"MAX_DRAWDOWN_SINCE_INCEPTION",period:"SINCE_INCEPTION",value:maxDd,count:points.length,start:points[0].date,end:end.date,method:"PRICE_NAV_PEAK_TO_TROUGH"});
  return out;
}

async function main(){ const completed:any[]=[], unavailable:any[]=[], failed:any[]=[];
  const dynamic = process.env.FUND_RISK_PERFORMANCE_SCHEDULER === "1" ? await prisma.$queryRawUnsafe<any[]>(`SELECT f.id "fundId",'BACKGROUND_CANONICAL_HISTORY' profile FROM funds f WHERE NOT EXISTS(SELECT 1 FROM fund_risk_metrics m WHERE m.fund_id=f.id) AND (SELECT count(*) FROM fund_history h WHERE h.fund_id=f.id AND h.nav>0)>=180 ORDER BY f.id LIMIT 25`) : [];
  const work = [...registry.funds, ...dynamic.filter((d:any)=>!registry.funds.some((f:any)=>f.fundId===d.fundId))];
  for(const item of work){ try{ const fund=await prisma.$queryRawUnsafe<any[]>(`SELECT id,currency FROM funds WHERE id=$1`,item.fundId); const rows=await prisma.$queryRawUnsafe<any[]>(`SELECT date,nav::float8 nav FROM fund_history WHERE fund_id=$1 AND nav IS NOT NULL AND nav>0 ORDER BY date`,item.fundId); const points=rows.map((r)=>({date:new Date(r.date),nav:Number(r.nav)})); const calculated=metrics(points);
    if(!calculated.length){unavailable.push({fundId:item.fundId,profile:item.profile,reason:"INSUFFICIENT_OBSERVATIONS",historyRows:points.length});continue;}
    await prisma.$transaction(async(tx)=>{const lock=await tx.$queryRawUnsafe<any[]>(`SELECT pg_try_advisory_xact_lock(hashtext('smartfund:fund-risk-performance:latest:v1')) locked`);if(!lock[0]?.locked)throw new Error("FUND_RISK_PERFORMANCE_SINGLE_WRITER_LOCKED");for(const m of calculated){const existing=await tx.$queryRawUnsafe<any[]>(`SELECT id FROM fund_risk_metrics WHERE fund_id=$1 AND share_class_id IS NULL AND metric_code=$2 AND as_of_date=$3::date AND source='DERIVED_FROM_FUND_HISTORY' AND calculation_method=$4`,item.fundId,m.code,m.end.toISOString().slice(0,10),m.method);if(existing[0])continue;await tx.$executeRawUnsafe(`INSERT INTO fund_risk_metrics(id,fund_id,share_class_id,metric_code,period,value,as_of_date,currency,calculation_method,observation_count,source,return_semantics,start_date,end_date,created_at,updated_at)VALUES($1,$2,NULL,$3,$4,$5,$6::date,$7,$8,$9,'DERIVED_FROM_FUND_HISTORY','PRICE_NAV_RETURN',$10::date,$6::date,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,randomUUID(),item.fundId,m.code,m.period,m.value,m.end.toISOString().slice(0,10),fund[0]?.currency??null,m.method,m.count,m.start.toISOString().slice(0,10));}},{maxWait:10000,timeout:60000});
    completed.push({fundId:item.fundId,profile:item.profile,historyRows:points.length,historyStart:points[0].date.toISOString().slice(0,10),historyEnd:points.at(-1)!.date.toISOString().slice(0,10),metrics:calculated.length});
  }catch(e){failed.push({fundId:item.fundId,error:e instanceof Error?e.message:String(e)});} }
  const now=new Date(),nextEligibleAt=new Date(now.getTime()+DAY).toISOString(); const eligible=completed.map((x)=>({fundId:x.fundId,lastHistoryDate:x.historyEnd,nextEligibleAt,status:"HEALTHY_WAITING"}));
  await atomicJson("queue.json",{version:1,updatedAt:now.toISOString(),boundedConcurrency:1,items:eligible,metricNotAvailable:unavailable}); const last=completed.at(-1);
  await atomicJson("checkpoint.json",{lastFundId:last?.fundId??null,lastHistoryDate:last?.historyEnd??null,lastMetricDate:last?.historyEnd??null,processedFunds:completed.length,failedFunds:failed.length,lastSuccessfulRun:completed.length?now.toISOString():null,nextEligibleAt,status:failed.length?"PARTIAL_CURRENT":"HEALTHY_WAITING"});
  await atomicJson("health.json",{owner:"fund-risk-performance",runnerPid:process.pid,lastHeartbeat:now.toISOString(),latestPath:true,incremental:true,scheduler:process.env.FUND_RISK_PERFORMANCE_SCHEDULER==="1",autoContinuing:process.env.FUND_RISK_PERFORMANCE_SCHEDULER==="1",singleWriter:true,completed:completed.length,metricNotAvailable:unavailable.length,failed:failed.length,status:failed.length?"PARTIAL_CURRENT":"HEALTHY_WAITING"}); console.log(JSON.stringify({completed,unavailable,failed}));if(failed.length)process.exitCode=1; }
main().finally(()=>prisma.$disconnect());
