import { PrismaClient } from "@prisma/client";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root=path.resolve("runtime/fx-options-public"),lockPath=path.join(root,"writer.lock"),now=()=>new Date().toISOString();
const sources=[
  {pair:"EURUSD",symbol:"EVZ",url:"https://cdn.cboe.com/api/global/us_indices/daily_prices/EVZ_History.csv"},
  {pair:"USDJPY",symbol:"JYVIX",url:"https://cdn.cboe.com/api/global/us_indices/daily_prices/JYVIX_History.csv"},
  {pair:"GBPUSD",symbol:"BPVIX",url:"https://cdn.cboe.com/api/global/us_indices/daily_prices/BPVIX_History.csv"},
] as const;
const requested=["EURUSD","USDJPY","GBPUSD","AUDUSD","USDCAD","USDCHF","NZDUSD","USDCNH","USDKRW","USDTWD"];
async function atomic(name:string,value:unknown){await mkdir(root,{recursive:true});const file=path.join(root,name),temp=`${file}.${process.pid}.tmp`;await writeFile(temp,JSON.stringify(value,null,2)+"\n");await rename(temp,file)}
function db(){const url=new URL(process.env.DATABASE_URL!);url.port="6543";url.searchParams.set("pgbouncer","true");url.searchParams.set("connection_limit","1");return url.toString()}
function parse(text:string){const lines=text.trim().split(/\r?\n/).slice(1);return lines.flatMap(line=>{const [rawDate,rawValue]=line.split(","),value=Number(rawValue);if(!rawDate||!Number.isFinite(value)||value<=0)return[];const [month,day,year]=rawDate.split("/");return[{date:`${year}-${month}-${day}`,value}]})}

// 2026-10-21 夜間（使用者核准）: 原本的鎖檔邏輯——鎖檔存在就直接return、exit 0——沒有分辨「別的
// instance真的還在跑」跟「殘留的舊鎖」。VERIFIED根因：2026-09-08 13:49的那次執行（PID 44600）
// 中途被中斷（很可能是電腦重開機/Windows更新，同一份CLAUDE.md已經記過同一種根因），finally區塊
// 從未執行、鎖檔從未被清掉，導致之後43天每天的排程都在這裡默默return、回報LastTaskResult=0
// （看起來成功），完全沒有真的去打CBOE或寫入fx_metrics。
//
// 修正：鎖檔內容改成JSON {pid, startedAt}（不再是空檔）。偵測到鎖檔時：
//   1. 用 process.kill(pid, 0) 判斷這個PID現在還在不在——不在就是殘留鎖。
//   2. PID還在，但startedAt距離現在超過MAX_LOCK_AGE_MS（15分鐘，遠超過單次執行的正常耗時
//      ——3個來源各自最多30秒fetch逾時，正常情況幾秒內跑完），也視為殘留鎖（例如卡死但行程
//      沒被系統清掉的極端情況）。
//   3. 判定為殘留鎖：清除鎖檔，記錄一行log，正常往下執行（不再默默return）。
//   4. 判定為正常的鎖（別的instance真的還在跑、而且在合理時間內）：不准再默默exit 0假裝成功
//      ——改成呼叫local-schedule-report回報SKIPPED（jobId=LOCAL_FX_OPTIONS_PUBLIC，需要先在
//      app/api/cron/local-schedule-report/route.ts的ALLOWED_JOB_IDS加上這個jobId，而且要在
//      checkLocalScheduleReporting的watched清單加上監看，這兩個改動在smartfund-v2的部署分支
//      做，不在這支本機腳本裡），再正常結束。
const MAX_LOCK_AGE_MS = 15 * 60 * 1000;
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } // EPERM = exists but no permission to signal, still alive
}
async function reportSchedule(status: "COMPLETED" | "FAILED" | "SKIPPED", detail: string | null) {
  try {
    const secret = (await readFile(path.resolve(".local-schedule-report-secret"), "utf8")).trim();
    const res = await fetch("https://smartfund-v2.vercel.app/api/cron/local-schedule-report", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ jobId: "LOCAL_FX_OPTIONS_PUBLIC", status, detail }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`REPORT LOCAL_FX_OPTIONS_PUBLIC ${status} -> HTTP ${res.status}`);
  } catch (e) {
    console.log(`REPORT_FAILED LOCAL_FX_OPTIONS_PUBLIC ${status}: ${e instanceof Error ? e.message : String(e)} (not fatal)`);
  }
}
async function acquireLock(): Promise<ReturnType<typeof open> extends Promise<infer T> ? T : never> {
  await mkdir(root, { recursive: true });
  while (true) {
    try {
      const lock = await open(lockPath, "wx");
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() }));
      return lock;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let staleReason: string | null = null;
      try {
        const existing = JSON.parse(await readFile(lockPath, "utf8")) as { pid?: number; startedAt?: string };
        if (!existing.pid || !pidAlive(existing.pid)) staleReason = `PID ${existing.pid} 已不存在`;
        else if (existing.startedAt && Date.now() - new Date(existing.startedAt).getTime() > MAX_LOCK_AGE_MS) staleReason = `鎖檔存在超過${MAX_LOCK_AGE_MS / 60000}分鐘（PID ${existing.pid}仍存在但執行時間不合理）`;
      } catch {
        staleReason = "鎖檔內容無法解析（舊版空鎖檔或損毀）";
      }
      if (staleReason) {
        console.log(`STALE_LOCK_CLEARED: ${staleReason}，清除殘留鎖後繼續執行`);
        await rm(lockPath, { force: true });
        continue; // retry acquiring with a fresh lock
      }
      console.log("LOCK_HELD_BY_LIVE_PROCESS: 另一個正常執行中的instance持有鎖，回報SKIPPED並結束");
      await reportSchedule("SKIPPED", "lock held by a live, recently-started process");
      process.exit(0);
    }
  }
}

async function main(){const lock=await acquireLock();const prisma=new PrismaClient({datasources:{db:{url:db()}}});const started=now();try{const previous=await readFile(path.join(root,"checkpoint.json"),"utf8").then(JSON.parse).catch(()=>({completed:{}}));await atomic("health.json",{owner:"GLOBAL_FX_ORCHESTRATOR",processId:process.pid,state:"RUNNING",heartbeat:started,maxDbConcurrency:1});const before=(await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(*)::int rows FROM fx_metrics WHERE metric='FX_OPTION_IMPLIED_VOL_INDEX_30D' AND source='CBOE_OFFICIAL'`))[0].rows;const completed={...previous.completed};for(const source of sources){const response=await fetch(source.url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error(`${source.symbol}:HTTP_${response.status}`);const rows=parse(await response.text());const payload=JSON.stringify(rows.map(row=>({pair:source.pair,date:row.date,value:row.value,symbol:source.symbol,url:source.url})));await prisma.$executeRawUnsafe(`INSERT INTO fx_metrics(pair_symbol,interval,metric,observed_at,value,payload,source,computed_at) SELECT x.pair,'30D','FX_OPTION_IMPLIED_VOL_INDEX_30D',x.date::date,x.value,jsonb_build_object('providerSymbol',x.symbol,'measure','30_DAY_EXPECTED_VOLATILITY_INDEX','sourceReported',true,'atmQuote',false,'riskReversal',false,'butterfly',false,'sourceUrl',x.url,'officialStatus','OFFICIAL_EXCHANGE_INDEX'),'CBOE_OFFICIAL',NOW() FROM jsonb_to_recordset($1::jsonb) AS x(pair text,date text,value numeric,symbol text,url text) ON CONFLICT(pair_symbol,interval,metric,observed_at) DO NOTHING`,payload);completed[source.pair]={symbol:source.symbol,rows:rows.length,earliest:rows.at(0)?.date,latest:rows.at(-1)?.date,status:"COMPLETE_CURRENT"};await atomic("checkpoint.json",{owner:"GLOBAL_FX_ORCHESTRATOR",currentPair:source.pair,completed,updatedAt:now(),resumable:true,maxDbConcurrency:1})}const stats=(await prisma.$queryRawUnsafe<any[]>(`SELECT COUNT(DISTINCT pair_symbol)::int pairs,COUNT(*)::int rows,MIN(observed_at)::text earliest,MAX(observed_at)::text latest FROM fx_metrics WHERE metric='FX_OPTION_IMPLIED_VOL_INDEX_30D' AND source='CBOE_OFFICIAL'`))[0];const sourceLimited=requested.filter(pair=>!sources.some(source=>source.pair===pair));const result={state:"AUTO_CONTINUING",fxOptionsPairs:stats.pairs,ivSeries:stats.pairs,ivRows:stats.rows,riskReversalSeries:0,riskReversalRows:0,butterflySeries:0,butterflyRows:0,termStructureRows:0,historyRowsAdded:stats.rows-before,earliest:stats.earliest,latest:stats.latest,sourceLimited,failed:0,databaseRowsAdded:stats.rows-before,databaseWritten:stats.rows>0,nextRunAt:new Date(Date.now()+86400000).toISOString(),maxDbConcurrency:1,updatedAt:now()};await atomic("report.json",result);await atomic("health.json",{owner:"GLOBAL_FX_ORCHESTRATOR",state:"SCHEDULED_WAIT",heartbeat:result.updatedAt,nextRunAt:result.nextRunAt,autoContinuing:true,maxDbConcurrency:1});console.log(JSON.stringify(result,null,2));await reportSchedule("COMPLETED",`rowsAdded=${stats.rows-before}`)}catch(error){await reportSchedule("FAILED",error instanceof Error?error.message:String(error));throw error}finally{await prisma.$disconnect();await lock.close();await rm(lockPath,{force:true})}}
main().catch(async error=>{await atomic("health.json",{owner:"GLOBAL_FX_ORCHESTRATOR",state:"BLOCKED",error:error instanceof Error?error.message:String(error),heartbeat:now(),maxDbConcurrency:1});console.error(error);process.exitCode=1});
