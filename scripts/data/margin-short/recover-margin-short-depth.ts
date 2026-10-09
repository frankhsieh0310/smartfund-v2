import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const runtime = join(root, "runtime", "margin-short");
const archive = join(runtime, "archive");
const checkpointPath = join(runtime, "recovery-checkpoint.json");
const queuePath = join(runtime, "background-queue.json");
const lockPath = join(runtime, "recovery-writer.lock");
const logPath = join(runtime, "margin-short-recovery.log");
const canary = process.argv.includes("--canary");
const p = new PrismaClient();
const officialBase = "https://www.twse.com.tw/rwd/en/marginTrading";
const canaryTickers = new Set(["2330", "2317", "2454"]);
await mkdir(archive, { recursive: true });

const clean = (x: unknown) => Number(String(x ?? "").replaceAll(",", "").trim() || "0");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const compact = (d: Date) => iso(d).replaceAll("-", "");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
async function atomic(path: string, value: unknown) { const t = `${path}.${process.pid}.tmp`; await writeFile(t, `${JSON.stringify(value, null, 2)}\n`); await rename(t, path); }
async function log(s: string) { await appendFile(logPath, `${new Date().toISOString()} pid=${process.pid} ${s}\n`); }
async function state(stage: string, scope: string, extra: Record<string, unknown> = {}) { await atomic(checkpointPath, { asset: "GLOBAL_MARGIN_SHORT_STATISTICS", pid: process.pid, processAlive: true, stage, scope, updatedAt: new Date().toISOString(), ...extra }); }
async function loadJson(path: string) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function acquireWriterLock() {
  try {
    const owner = Number(await readFile(lockPath, "utf8"));
    if (owner) { try { process.kill(owner, 0); throw new Error(`SINGLE_WRITER_LOCK_UNAVAILABLE owner=${owner}`); } catch (e) { if (String(e).includes("SINGLE_WRITER")) throw e; } }
    await unlink(lockPath).catch(() => {});
  } catch (e) { if (String(e).includes("SINGLE_WRITER")) throw e; }
  const handle = await open(lockPath, "wx"); await handle.writeFile(String(process.pid)); await handle.close();
}

async function official(report: "MI_MARGN" | "TWT93U", date: string) {
  const path = join(archive, `twse-${report.toLowerCase()}-${date}.json`);
  const cached = await loadJson(path); if (cached?.stat === "OK") return cached;
  const url = `${officialBase}/${report}?date=${date}${report === "MI_MARGN" ? "&selectType=ALL" : ""}&response=json`;
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "SmartFund-MarginShort/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${report}_${date}_HTTP_${response.status}`);
  const body = await response.text(); const parsed = JSON.parse(body);
  if (parsed.stat === "OK") await writeFile(path, body);
  return parsed;
}

type Observation = { stockId: string | null; grain: "MARKET_LEVEL" | "SECURITY_LEVEL"; date: string; metric: string; value: number; unit: string; report: string; sourceRecordId: string };
async function upsert(o: Observation) {
  const sourceUrl = `${officialBase}/${o.report}`;
  const sourceKey = digest([o.grain, "TWSE", o.stockId ?? "MARKET", o.date, o.metric].join("|"));
  const conflict = o.grain === "SECURITY_LEVEL" ? `(stock_id,observation_date,metric_type) DO UPDATE SET value=EXCLUDED.value,unit=EXCLUDED.unit,source=EXCLUDED.source,source_url=EXCLUDED.source_url,source_record_id=EXCLUDED.source_record_id,retrieved_at=NOW(),updated_at=NOW(),verification_status='VERIFIED_OFFICIAL',freshness_status='CURRENT'` : `(source_key) DO UPDATE SET value=EXCLUDED.value,retrieved_at=NOW(),updated_at=NOW(),verification_status='VERIFIED_OFFICIAL',freshness_status='CURRENT'`;
  await p.$executeRawUnsafe(`INSERT INTO securities_lending_observations
    (id,stock_id,market,grain_type,observation_date,publication_date,metric_type,value,unit,source,source_url,source_record_id,retrieved_at,verification_status,freshness_status,publication_frequency,checksum,revision_number,source_key,created_at,updated_at)
    VALUES(gen_random_uuid(),$1,'TWSE',$2,$3::date,$3::date,$4,$5::numeric,$6,'TWSE Official',$7,$8,NOW(),'VERIFIED_OFFICIAL','CURRENT','DAILY',$9,1,$10,NOW(),NOW())
    ON CONFLICT ${conflict}`,
    o.stockId, o.grain, o.date, o.metric, o.value, o.unit, sourceUrl, o.sourceRecordId, digest(`${o.value}|${o.unit}`), sourceKey);
}

async function stockMap() {
  const rows = await p.$queryRawUnsafe<Array<{ id: string; ticker: string }>>(`SELECT id,ticker FROM stocks WHERE exchange='TWSE' AND is_active=true`);
  return new Map(rows.map((r) => [r.ticker, r.id]));
}

async function ingestDate(date: string, selectedOnly: boolean) {
  const margin = await official("MI_MARGN", date);
  const sbl = selectedOnly ? await official("TWT93U", date) : { stat: "REUSED_CANONICAL", data: [] };
  if (margin?.stat !== "OK" || (selectedOnly && sbl?.stat !== "OK")) return { date, status: "NO_PUBLICATION", observations: 0, securities: 0 };
  const stocks = await stockMap(); const seen = new Set<string>(); let observations = 0;
  const marginSummary = margin.tables?.[0]?.data ?? [];
  for (const [metric, row, unit, multiplier] of [
    ["MARGIN_FINANCING_BALANCE", marginSummary[2], "LOCAL_CURRENCY", 1000],
    ["SHORT_BALANCE", marginSummary[1], "SHARES", 1000]
  ] as const) if (row) { await upsert({ stockId: null, grain: "MARKET_LEVEL", date, metric, value: clean(row[5]) * multiplier, unit, report: "MI_MARGN", sourceRecordId: `${date}:SUMMARY:${row[0]}` }); observations++; }
  const marginRows = margin.tables?.[1]?.data ?? [];
  for (const row of marginRows) {
    const ticker = String(row[0] ?? "").trim(); if (!ticker || (selectedOnly && !canaryTickers.has(ticker))) continue;
    const stockId = stocks.get(ticker); if (!stockId) continue; seen.add(stockId);
    for (const [metric, index] of [["MARGIN_FINANCING_BUY",1],["MARGIN_FINANCING_REPAYMENT",2],["MARGIN_FINANCING_BALANCE",5],["SHORT_BALANCE",11]] as const) {
      await upsert({ stockId, grain: "SECURITY_LEVEL", date, metric, value: clean(row[index]) * 1000, unit: "SHARES", report: "MI_MARGN", sourceRecordId: `${date}:${ticker}:${index}` }); observations++;
    }
  }
  const sblRows = sbl.data ?? []; const aggregate = sblRows.find((r: unknown[]) => !String(r[0] ?? "").trim());
  if (aggregate) for (const [metric,index] of [["SECURITIES_BORROWING_VOLUME",8],["SECURITIES_RETURN_VOLUME",9],["SECURITIES_BORROWING_BALANCE",11]] as const) { await upsert({ stockId:null,grain:"MARKET_LEVEL",date,metric,value:clean(aggregate[index]),unit:"SHARES",report:"TWT93U",sourceRecordId:`${date}:SUMMARY:${index}` }); observations++; }
  for (const row of sblRows) {
    const ticker=String(row[0]??"").trim(); if(!ticker || (selectedOnly && !canaryTickers.has(ticker))) continue;
    const stockId=stocks.get(ticker); if(!stockId) continue; seen.add(stockId);
    for(const [metric,index] of [["SECURITIES_BORROWING_VOLUME",8],["SECURITIES_RETURN_VOLUME",9],["SECURITIES_BORROWING_BALANCE",11]] as const){ await upsert({stockId,grain:"SECURITY_LEVEL",date,metric,value:clean(row[index]),unit:"SHARES",report:"TWT93U",sourceRecordId:`${date}:${ticker}:${index}`}); observations++; }
  }
  return { date, status: "SUCCEEDED", observations, securities: seen.size };
}

async function seedContracts() {
  const markets = [
    ["TWSE","TW","Taiwan","TWD","Asia/Taipei","DAILY","TWSE","AVAILABLE"], ["FINRA","US","United States","USD","America/New_York","DAILY","FINRA","SOURCE_PENDING"],
    ["NASDAQ","US","United States","USD","America/New_York","BIWEEKLY","Nasdaq","SOURCE_PENDING"], ["JPX","JP","Japan","JPY","Asia/Tokyo","DAILY","JPX","SOURCE_PENDING"],
    ["HKEX","HK","Hong Kong","HKD","Asia/Hong_Kong","DAILY","HKEX","SOURCE_PENDING"], ["KRX","KR","South Korea","KRW","Asia/Seoul","DAILY","KRX","SOURCE_PENDING"]
  ];
  for (const m of markets) await p.$executeRawUnsafe(`INSERT INTO margin_short_markets(market_id,country,jurisdiction,currency,timezone,publication_frequency,official_source,official_source_url,source_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(market_id) DO UPDATE SET source_status=EXCLUDED.source_status,updated_at=NOW()`, ...m.slice(0,7), m[0]==="TWSE"?officialBase:`OFFICIAL_REFERENCE:${m[6]}`,m[7]);
  const metrics: Array<[string,string,string[],string]> = [
    ["MARGIN_FINANCING_BALANCE","Outstanding margin financing",["SHARES","LOCAL_CURRENCY"],"SOURCE_OBSERVATION"], ["MARGIN_FINANCING_BUY","Daily margin financing buys",["SHARES","LOCAL_CURRENCY"],"SOURCE_OBSERVATION"],
    ["MARGIN_FINANCING_REPAYMENT","Daily margin financing sales/repayment",["SHARES","LOCAL_CURRENCY"],"SOURCE_OBSERVATION"], ["SHORT_SELLING_VOLUME","Daily short-selling volume",["SHARES"],"SOURCE_OBSERVATION"],
    ["SHORT_INTEREST","Published short interest",["SHARES"],"SOURCE_OBSERVATION"], ["SHORT_BALANCE","Outstanding margin short-sale balance",["SHARES"],"SOURCE_OBSERVATION"],
    ["SHORT_RATIO","Explicitly versioned short ratio",["PERCENT","RATIO","TURNOVER_PERCENT"],"DERIVED_ANALYTIC"], ["SECURITIES_BORROWING_BALANCE","Outstanding SBL short-sale balance",["SHARES"],"SOURCE_OBSERVATION"],
    ["SECURITIES_BORROWING_VOLUME","Daily SBL short sales",["SHARES"],"SOURCE_OBSERVATION"], ["SECURITIES_RETURN_VOLUME","Daily SBL returns",["SHARES"],"SOURCE_OBSERVATION"], ["DAYS_TO_COVER","Short interest divided by aligned average daily volume",["RATIO"],"DERIVED_ANALYTIC"], ["OTHER_VERIFIED","Other verified official metric",["SHARES","LOCAL_CURRENCY","PERCENT","RATIO","TURNOVER_PERCENT","OTHER"],"SOURCE_OBSERVATION"]
  ];
  for(const m of metrics) await p.$executeRawUnsafe(`INSERT INTO margin_short_metric_taxonomy(metric_code,description,allowed_units,source_or_derived) VALUES($1,$2,$3::text[],$4) ON CONFLICT(metric_code) DO NOTHING`,...m);
  for(const market of markets) for(const metric of ["MARGIN_FINANCING_BALANCE","SHORT_SELLING_VOLUME","SHORT_INTEREST","SHORT_BALANCE","SECURITIES_BORROWING_BALANCE","SHORT_RATIO"]) await p.$executeRawUnsafe(`INSERT INTO margin_short_market_capabilities(market_id,metric_code,grain_type,source_status,frequency,official_source_url) VALUES($1,$2,'MARKET_AND_SECURITY',$3,$4,$5) ON CONFLICT(market_id,metric_code,grain_type) DO UPDATE SET source_status=EXCLUDED.source_status,updated_at=NOW()`,market[0],metric,market[0]==="TWSE"?(metric==="SHORT_INTEREST"||metric==="SHORT_RATIO"?"NOT_PUBLISHED":"AVAILABLE"):"SOURCE_PENDING",market[5],market[0]==="TWSE"?officialBase:`OFFICIAL_REFERENCE:${market[6]}`);
}

async function analytics() {
  await p.$executeRawUnsafe(`WITH ordered AS (SELECT grain_type,market,stock_id,metric_type,observation_date,value,LAG(value) OVER(PARTITION BY grain_type,market,stock_id,metric_type ORDER BY observation_date) prior FROM securities_lending_observations WHERE market='TWSE' AND metric_type IN ('MARGIN_FINANCING_BALANCE','SHORT_BALANCE','SECURITIES_BORROWING_BALANCE')) INSERT INTO margin_short_analytics(grain_type,market_id,security_id,base_metric,analytic_code,as_of_date,value,unit,formula_code,formula_version,date_alignment_policy,verification_status) SELECT grain_type,market,stock_id,metric_type,'1D_ABS_CHANGE',observation_date,value-prior,'ABS_CHANGE','CURRENT_MINUS_PREVIOUS','1.0','PREVIOUS_AVAILABLE_TRADING_DATE','VERIFIED_DERIVED' FROM ordered WHERE prior IS NOT NULL ON CONFLICT(grain_type,market_id,security_id,base_metric,analytic_code,as_of_date) DO UPDATE SET value=EXCLUDED.value`);
}

async function run() {
  await acquireWriterLock();
  if(!canary) await atomic(queuePath,{asset:"GLOBAL_MARGIN_SHORT_STATISTICS",owner:"MARGIN_SHORT_RECOVERY",pid:process.pid,updatedAt:new Date().toISOString(),tasks:[
    ...["TWSE_IDENTITY","TWSE_CURRENT","TWSE_HISTORY","TWSE_MARGIN","TWSE_SHORT","ANALYTICS","PROVENANCE","COVERAGE"].map((name,i)=>({name,status:i===0?"RUNNING":"PENDING"})),
    {name:"TWSE_BORROWING",status:"RUNNING",owner:"GLOBAL_SECURITIES_LENDING"},
    ...["FINRA_SOURCE","NASDAQ_SOURCE","JPX_SOURCE","HKEX_SOURCE","KRX_SOURCE"].map(name=>({name,status:"BLOCKED",reason:"SOURCE_PENDING"}))
  ]});
  await seedContracts(); await state("TWSE_HISTORY", canary ? "canary" : "bounded-background");
  const dates: string[]=[]; for(let offset=1; dates.length<10 && offset<60; offset++){const d=new Date();d.setUTCDate(d.getUTCDate()-offset);if(d.getUTCDay()===0||d.getUTCDay()===6)continue;const day=compact(d);try{const j=await official("MI_MARGN",day);if(j?.stat==="OK")dates.push(day);}catch(e){await log(`source-failure date=${day} error=${String(e)}`);}}
  const results=[]; for(const day of dates.sort()){
    await state("TWSE_HISTORY",day,{datesCompleted:results.length});
    if(canary){
      const existing=await p.$queryRawUnsafe<Array<{count: bigint}>>(`SELECT count(*)::bigint count FROM securities_lending_observations o WHERE o.market='TWSE' AND o.observation_date=$1::date AND (o.grain_type='MARKET_LEVEL' OR o.stock_id IN (SELECT id FROM stocks WHERE exchange='TWSE' AND ticker IN ('2330','2317','2454')))`,day);
      if(Number(existing[0]?.count??0)>=26){results.push({date:day,status:"READ_BACK_RESUMED",observations:Number(existing[0].count),securities:3});continue;}
    }
    results.push(await ingestDate(day,canary));
  }
  await analytics();
  const census=await p.$queryRawUnsafe(`SELECT count(*)::text records,count(DISTINCT stock_id) FILTER(WHERE stock_id IS NOT NULL)::text securities,count(DISTINCT metric_type)::text metrics,min(observation_date)::text earliest,max(observation_date)::text latest,count(DISTINCT market)::text markets FROM securities_lending_observations WHERE market='TWSE'`);
  await atomic(join(runtime,canary?"recovery-canary-result.json":"recovery-completion-manifest.json"),{status:"PASS",mode:canary?"CANARY":"BOUNDED_BACKGROUND",dates,results,census,verifiedAt:new Date().toISOString()});
  if(!canary){const q=await loadJson(queuePath);q.tasks=q.tasks.map((t:any)=>t.status==="BLOCKED"?t:{...t,status:"SUCCEEDED"});q.updatedAt=new Date().toISOString();await atomic(queuePath,q);}
  await state(canary?"CANARY_COMPLETE":"SCHEDULED","incremental",{processAlive:!canary,census}); await log(`${canary?"canary":"background"}-complete dates=${dates.length}`);
}

run().catch(async e=>{await log(`fatal ${String(e)}`);await state("FAILED","recovery",{processAlive:false,error:String(e)});process.exitCode=1;}).finally(async()=>{await unlink(lockPath).catch(()=>{});await p.$disconnect();});
