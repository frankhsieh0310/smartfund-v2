import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { PrismaClient } from "../../../prisma/generated/currency-index-client/index.js";

const prisma = new PrismaClient();

type Profile = { symbol: string; officialName: string; displayName: string; provider: string; providerExternalId: string | null; currency: string | null; jurisdiction: string | null; region: string | null; indexType: string; basketType: string; status: string; sourceSeries?: string; sourceAdapter: string; sourceType: string; licenseStatus: string; verificationStatus: string; officialSourceUrl: string | null; methodologyUrl: string | null };
type Contract = { profiles: Profile[]; canarySymbols: string[]; performanceMetrics: string[]; riskMetrics: string[]; productContract: unknown };
type Observation = { date: Date; value: number; open: number | null; high: number | null; low: number | null; volume: number | null; source: string; sourceType: string; sourceRecordId: string; sourceUrl: string; licenseStatus: string; verificationStatus: string; observationType: "OHLC" | "VALUE_ONLY" };

const root = resolve("runtime", "currency-index");
const lockPath = resolve(root, "standalone.lock");
const logPath = resolve(root, "p0-recovery.log");
const checkpointPath = resolve(root, "p0-checkpoint.json");
const queuePath = resolve(root, "p0-background-queue.json");
const manifestPath = resolve(root, "p0-completion-manifest.json");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function atomic(path: string, value: string | Uint8Array) { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${process.pid}.tmp`; await writeFile(temp, value); await rename(temp, path); }
async function log(event: Record<string, unknown>) { const handle = await open(logPath, "a"); try { await handle.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); } finally { await handle.close(); } }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function acquireLock() { await mkdir(root, { recursive: true }); try { const old = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number }; if (old.pid && alive(old.pid)) throw new Error(`CURRENCY_INDEX_SINGLE_WRITER_ACTIVE:${old.pid}`); await unlink(lockPath).catch(() => undefined); } catch (error) { if (error instanceof Error && error.message.startsWith("CURRENCY_INDEX_SINGLE_WRITER_ACTIVE")) throw error; } const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY); await handle.write(JSON.stringify({ pid: process.pid, role: "CURRENCY_INDEX_CANONICAL_OWNER", host: hostname(), startedAt: new Date().toISOString() })); await handle.close(); }
async function loadContract() { return JSON.parse(await readFile(resolve("config", "currency-index-p0-contract.json"), "utf8")) as Contract; }
const utcDate = (text: string) => new Date(`${text.slice(0, 10)}T00:00:00.000Z`);

function validateObservation(row: Observation, previous?: Observation) {
  if (!Number.isFinite(row.value) || row.value <= 0) return "REJECTED_INVALID_OBSERVATION:NON_POSITIVE_OR_NON_FINITE";
  if (Number.isNaN(row.date.getTime()) || row.date.getTime() > Date.now() + 86_400_000) return "REJECTED_INVALID_OBSERVATION:INVALID_DATE";
  if ([row.open, row.high, row.low].some((value) => value != null && (!Number.isFinite(value) || value <= 0))) return "REJECTED_INVALID_OBSERVATION:INVALID_OHLC";
  if (row.high != null && row.low != null && row.high < row.low) return "REJECTED_INVALID_OBSERVATION:INVALID_RANGE";
  if (previous && previous.value > 0 && Math.abs(row.value / previous.value - 1) > 0.2) return "REJECTED_INVALID_OBSERVATION:IMPOSSIBLE_JUMP";
  return "VALID";
}

async function fetchDxy(profile: Profile): Promise<Observation[]> {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(profile.sourceSeries!)}`);
  url.searchParams.set("interval", "1d"); url.searchParams.set("range", "1mo"); url.searchParams.set("events", "history");
  const response = await fetch(url, { headers: { "user-agent": "SmartFund-Currency-Index-P0/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`INVALID_SOURCE:HTTP_${response.status}`);
  const body = await response.json() as any; const result = body.chart?.result?.[0]; const quote = result?.indicators?.quote?.[0];
  return (result?.timestamp ?? []).flatMap((epoch: number, index: number): Observation[] => {
    const value = Number(quote?.close?.[index]);
    const numeric = (input: unknown) => input == null ? null : Number(input);
    return [{ date: utcDate(new Date(epoch * 1000).toISOString()), value, open: numeric(quote?.open?.[index]), high: numeric(quote?.high?.[index]), low: numeric(quote?.low?.[index]), volume: numeric(quote?.volume?.[index]), source: `Yahoo Chart:${profile.sourceSeries}`, sourceType: profile.sourceType, sourceRecordId: `${profile.sourceSeries}:${new Date(epoch * 1000).toISOString().slice(0, 10)}`, sourceUrl: url.toString(), licenseStatus: profile.licenseStatus, verificationStatus: profile.verificationStatus, observationType: "OHLC" }];
  }).sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function fetchFred(profile: Profile): Promise<Observation[]> {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${profile.sourceSeries}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`INVALID_SOURCE:FRED_HTTP_${response.status}`);
  return (await response.text()).trim().split(/\r?\n/).slice(1).flatMap((line): Observation[] => {
    const [date, raw] = line.split(","); const value = Number(raw);
    if (!date) return [];
    return [{ date: utcDate(date), value, open: null, high: null, low: null, volume: null, source: `FRED:${profile.sourceSeries}`, sourceType: profile.sourceType, sourceRecordId: `${profile.sourceSeries}:${date}`, sourceUrl: profile.officialSourceUrl!, licenseStatus: profile.licenseStatus, verificationStatus: profile.verificationStatus, observationType: "VALUE_ONLY" }];
  });
}

async function syncIdentity(profile: Profile) {
  await prisma.marketMaster.upsert({ where: { symbol: profile.symbol }, create: { symbol: profile.symbol, name: profile.officialName, assetType: "INDEX", region: profile.region, country: profile.jurisdiction, exchange: profile.provider, currency: profile.currency, category: "CURRENCY_INDEX", provider: profile.provider, isActive: !profile.status.includes("PENDING") }, update: { name: profile.officialName, assetType: "INDEX", region: profile.region, country: profile.jurisdiction, exchange: profile.provider, currency: profile.currency, category: "CURRENCY_INDEX", provider: profile.provider, isActive: !profile.status.includes("PENDING") } });
  await prisma.currencyIndexProfile.upsert({ where: { symbol: profile.symbol }, create: { symbol: profile.symbol, officialName: profile.officialName, displayName: profile.displayName, provider: profile.provider, providerExternalId: profile.providerExternalId, currency: profile.currency, jurisdiction: profile.jurisdiction, region: profile.region, indexType: profile.indexType, basketType: profile.basketType, status: profile.status, methodologyUrl: profile.methodologyUrl, officialSourceUrl: profile.officialSourceUrl, licenseStatus: profile.licenseStatus, verificationStatus: profile.verificationStatus }, update: { officialName: profile.officialName, displayName: profile.displayName, provider: profile.provider, providerExternalId: profile.providerExternalId, currency: profile.currency, jurisdiction: profile.jurisdiction, region: profile.region, indexType: profile.indexType, basketType: profile.basketType, status: profile.status, methodologyUrl: profile.methodologyUrl, officialSourceUrl: profile.officialSourceUrl, licenseStatus: profile.licenseStatus, verificationStatus: profile.verificationStatus } });
}

async function writeObservations(profile: Profile, fetched: Observation[]) {
  const accepted: Observation[] = []; const rejected: Array<{ row: Observation; reason: string }> = [];
  for (const row of fetched) { const reason = validateObservation(row, accepted.at(-1)); if (reason === "VALID") accepted.push(row); else rejected.push({ row, reason }); }
  for (const item of rejected) await log({ status: "REJECTED_INVALID_OBSERVATION", symbol: profile.symbol, date: item.row.date.toISOString(), value: item.row.value, reason: item.reason });
  if (!accepted.length) throw new Error("EMPTY_PAYLOAD:NO_VALID_ROWS");
  const state = await prisma.currencyIndexIncrementalState.findUnique({ where: { symbol: profile.symbol } });
  const hash = createHash("sha256").update(JSON.stringify(accepted.map((row) => [row.date.toISOString(), row.value]))).digest("hex");
  if (state?.lastSourceState === hash) return { accepted, changed: 0, rejected: rejected.length };
  let changed = 0;
  for (let index = 0; index < accepted.length; index += 1) {
    const row = accepted[index]; const previous = accepted[index - 1]; const changePts = previous ? row.value - previous.value : null; const changePct = previous ? changePts! / previous.value * 100 : null;
    await prisma.marketData.upsert({ where: { symbol_date: { symbol: profile.symbol, date: row.date } }, create: { symbol: profile.symbol, name: profile.officialName, type: "INDEX", date: row.date, close: row.value, open: row.open, high: row.high, low: row.low, volume: row.volume, changePts, changePct, region: profile.region, currency: profile.currency, source: row.source }, update: { close: row.value, open: row.open, high: row.high, low: row.low, volume: row.volume, changePts, changePct, source: row.source } });
    const checksum = createHash("sha256").update(JSON.stringify([profile.symbol, row.date.toISOString(), row.open, row.high, row.low, row.value, row.volume, row.source])).digest("hex");
    await prisma.currencyIndexObservationMeta.upsert({ where: { symbol_observationDate: { symbol: profile.symbol, observationDate: row.date } }, create: { symbol: profile.symbol, observationDate: row.date, observationType: row.observationType, source: row.source, sourceType: row.sourceType, sourceRecordId: row.sourceRecordId, sourceUrl: row.sourceUrl, asOfDate: row.date, retrievedAt: new Date(), parserVersion: "currency-index-p0-recovery-v3", checksum, checksumStatus: "COMPUTED_SHA256_CANONICAL_FIELDS", verificationStatus: row.verificationStatus, licenseStatus: row.licenseStatus, qualityStatus: "VALID" }, update: { observationType: row.observationType, source: row.source, sourceType: row.sourceType, sourceRecordId: row.sourceRecordId, sourceUrl: row.sourceUrl, asOfDate: row.date, retrievedAt: new Date(), parserVersion: "currency-index-p0-recovery-v3", checksum, checksumStatus: "COMPUTED_SHA256_CANONICAL_FIELDS", verificationStatus: row.verificationStatus, licenseStatus: row.licenseStatus, qualityStatus: "VALID", ingestedAt: new Date() } });
    changed += 1;
  }
  const latest = accepted.at(-1)!; const previous = accepted.at(-2); const change = previous ? latest.value - previous.value : null; const changePct = previous ? change! / previous.value * 100 : null;
  await prisma.marketMaster.update({ where: { symbol: profile.symbol }, data: { latestClose: latest.value, latestDate: latest.date, latestChange: change, latestChangePct: changePct, provider: latest.source } });
  await prisma.currencyIndexIncrementalState.upsert({ where: { symbol: profile.symbol }, create: { symbol: profile.symbol, lastSourceDate: latest.date, lastCanonicalDate: latest.date, lastSourceState: hash, lastProcessedRecord: latest.sourceRecordId, lastSuccessfulRun: new Date(), nextEligibleAt: new Date(Date.now() + 15 * 60_000) }, update: { lastSourceDate: latest.date, lastCanonicalDate: latest.date, lastSourceState: hash, lastProcessedRecord: latest.sourceRecordId, lastSuccessfulRun: new Date(), nextEligibleAt: new Date(Date.now() + 15 * 60_000) } });
  const archive = resolve(root, "archive", "incremental", "1D", `${profile.symbol}-${latest.date.toISOString().slice(0, 10)}-${hash.slice(0, 10)}.json.gz`);
  await atomic(archive, gzipSync(JSON.stringify({ symbol: profile.symbol, rows: accepted, qualityStatus: "VALID", hash })));
  return { accepted, changed, rejected: rejected.length };
}

async function syncMethodology(profile: Profile) {
  if (!profile.methodologyUrl || profile.verificationStatus !== "VERIFIED") return false;
  const bis = profile.provider.includes("BIS");
  await prisma.currencyIndexMethodology.upsert({ where: { symbol: profile.symbol }, create: { symbol: profile.symbol, provider: profile.provider, indexObjective: profile.indexType === "REAL_EFFECTIVE" ? "Measure inflation-adjusted effective currency value" : "Measure effective currency value against a trade-weighted basket", basketDefinition: "Official provider-defined currency basket", constituentCurrencies: [], weightingMethod: bis ? "GEOMETRIC_TRADE_WEIGHTED" : "TRADE_WEIGHTED", weightSource: profile.provider, rebalanceFrequency: "PROVIDER_DEFINED", calculationFrequency: "SOURCE_FREQUENCY", methodologyUrl: profile.methodologyUrl, source: profile.provider, licenseStatus: profile.licenseStatus, verificationStatus: "VERIFIED" }, update: { provider: profile.provider, indexObjective: profile.indexType === "REAL_EFFECTIVE" ? "Measure inflation-adjusted effective currency value" : "Measure effective currency value against a trade-weighted basket", basketDefinition: "Official provider-defined currency basket", constituentCurrencies: [], weightingMethod: bis ? "GEOMETRIC_TRADE_WEIGHTED" : "TRADE_WEIGHTED", weightSource: profile.provider, rebalanceFrequency: "PROVIDER_DEFINED", calculationFrequency: "SOURCE_FREQUENCY", methodologyUrl: profile.methodologyUrl, source: profile.provider, licenseStatus: profile.licenseStatus, verificationStatus: "VERIFIED" } });
  return true;
}

const periods: Record<string, number> = { CHANGE_1D: 1, CHANGE_1W: 7, CHANGE_1M: 30, CHANGE_3M: 91, CHANGE_6M: 182, CHANGE_1Y: 365, CHANGE_3Y: 1096, CHANGE_5Y: 1826, CHANGE_10Y: 3652 };
async function analytics(profile: Profile) {
  const rows = await prisma.marketData.findMany({ where: { symbol: profile.symbol, close: { gt: 0 } }, orderBy: { date: "asc" }, select: { date: true, close: true } });
  if (rows.length < 2) return 0; const latest = rows.at(-1)!; let count = 0;
  for (const [metric, days] of Object.entries(periods)) { const target = latest.date.getTime() - days * 86_400_000; const prior = [...rows].reverse().find((row) => row.date.getTime() <= target); if (!prior) continue; const value = (Number(latest.close) / Number(prior.close) - 1) * 100; await prisma.currencyIndexAnalytic.upsert({ where: { symbol_asOfDate_metric: { symbol: profile.symbol, asOfDate: latest.date, metric } }, create: { symbol: profile.symbol, asOfDate: latest.date, metric, value, semantic: "INDEX_LEVEL_CHANGE_PERCENT", source: "DERIVED_FROM_CANONICAL_HISTORY", qualityStatus: "VALID" }, update: { value, semantic: "INDEX_LEVEL_CHANGE_PERCENT", source: "DERIVED_FROM_CANONICAL_HISTORY", qualityStatus: "VALID" } }); count += 1; }
  const daily = rows.filter((row) => row.date >= new Date(latest.date.getTime() - 5 * 365.25 * 86_400_000)); const returns = daily.slice(1).map((row, i) => Math.log(Number(row.close) / Number(daily[i].close)));
  for (const [metric, window] of [["VOLATILITY_30D",30],["VOLATILITY_90D",90],["VOLATILITY_1Y",252]] as const) { if (returns.length < window) continue; const values = returns.slice(-window); const mean = values.reduce((a,b)=>a+b,0)/values.length; const variance = values.reduce((sum,value)=>sum+(value-mean)**2,0)/(values.length-1); const value = Math.sqrt(variance) * Math.sqrt(252) * 100; await prisma.currencyIndexAnalytic.upsert({ where:{symbol_asOfDate_metric:{symbol:profile.symbol,asOfDate:latest.date,metric}}, create:{symbol:profile.symbol,asOfDate:latest.date,metric,value,semantic:"ANNUALIZED_INDEX_LEVEL_VOLATILITY",source:"DERIVED_FROM_CANONICAL_HISTORY",qualityStatus:"VALID"}, update:{value,qualityStatus:"VALID"} }); count += 1; }
  for (const [metric, years] of [["MAX_DRAWDOWN_1Y",1],["MAX_DRAWDOWN_3Y",3],["MAX_DRAWDOWN_5Y",5]] as const) { const values=rows.filter(r=>r.date>=new Date(latest.date.getTime()-years*365.25*86_400_000)).map(r=>Number(r.close)); if(values.length<2)continue; let peak=values[0],dd=0; for(const value of values){peak=Math.max(peak,value);dd=Math.min(dd,(value/peak-1)*100);} await prisma.currencyIndexAnalytic.upsert({where:{symbol_asOfDate_metric:{symbol:profile.symbol,asOfDate:latest.date,metric}},create:{symbol:profile.symbol,asOfDate:latest.date,metric,value:dd,semantic:"INDEX_LEVEL_DRAWDOWN_PERCENT",source:"DERIVED_FROM_CANONICAL_HISTORY",qualityStatus:"VALID"},update:{value:dd,qualityStatus:"VALID"}}); count+=1; }
  const year=rows.filter(r=>r.date>=new Date(latest.date.getTime()-365.25*86_400_000)).map(r=>Number(r.close)); for(const [metric,value] of [["52_WEEK_HIGH",Math.max(...year)],["52_WEEK_LOW",Math.min(...year)]] as const){await prisma.currencyIndexAnalytic.upsert({where:{symbol_asOfDate_metric:{symbol:profile.symbol,asOfDate:latest.date,metric}},create:{symbol:profile.symbol,asOfDate:latest.date,metric,value,semantic:"INDEX_LEVEL",source:"DERIVED_FROM_CANONICAL_HISTORY",qualityStatus:"VALID"},update:{value,qualityStatus:"VALID"}});count+=1;} return count;
}

async function projectCoverage(profile: Profile) {
  const [master, history, methodology, basket, analytic, verified] = await Promise.all([prisma.marketMaster.findUnique({where:{symbol:profile.symbol}}), prisma.marketData.aggregate({where:{symbol:profile.symbol,close:{gt:0}},_count:true,_min:{date:true},_max:{date:true}}), prisma.currencyIndexMethodology.count({where:{symbol:profile.symbol,verificationStatus:"VERIFIED"}}), prisma.currencyIndexConstituent.count({where:{symbol:profile.symbol}}), prisma.currencyIndexAnalytic.count({where:{symbol:profile.symbol,qualityStatus:"VALID"}}), prisma.currencyIndexObservationMeta.count({where:{symbol:profile.symbol,qualityStatus:"VALID",verificationStatus:{in:["VERIFIED","SUPPLEMENTAL_VERIFIED"]}}})]);
  const current = Boolean(master?.latestClose && Number(master.latestClose) > 0 && master.latestDate); const identity = true; const historyAvailable = history._count > 0; const sourceVerified = verified > 0; const status = profile.licenseStatus === "LICENSE_REQUIRED" && !current ? "LICENSE_PENDING" : current && historyAvailable && methodology && sourceVerified ? "FULL" : current && historyAvailable ? "PARTIAL" : historyAvailable ? "HISTORY_ONLY" : profile.status.includes("PENDING") ? "SOURCE_PENDING" : "IDENTITY_ONLY";
  await prisma.currencyIndexCoverage.upsert({where:{symbol:profile.symbol},create:{symbol:profile.symbol,identityAvailable:identity,currentAvailable:current,historyAvailable,firstDate:history._min.date,lastDate:history._max.date,observationCount:history._count,methodologyAvailable:Boolean(methodology),basketAvailable:basket>0,weightsAvailable:false,performanceAvailable:analytic>0,sourceVerified,licenseStatus:profile.licenseStatus,coverageStatus:status,lastCheckedAt:new Date()},update:{identityAvailable:identity,currentAvailable:current,historyAvailable,firstDate:history._min.date,lastDate:history._max.date,observationCount:history._count,methodologyAvailable:Boolean(methodology),basketAvailable:basket>0,weightsAvailable:false,performanceAvailable:analytic>0,sourceVerified,licenseStatus:profile.licenseStatus,coverageStatus:status,lastCheckedAt:new Date()}});
}

async function cycle(contract: Contract) {
  for (const profile of contract.profiles) await syncIdentity(profile);
  let writeCanary = 0; let readBack = 0; let analyticsCount = 0; const results: Record<string, unknown> = {};
  for (const profile of contract.profiles.filter((item) => item.sourceAdapter !== "NONE" && item.licenseStatus !== "LICENSE_REQUIRED")) { try { const fetched = profile.sourceAdapter === "FRED_CSV" ? await fetchFred(profile) : await fetchDxy(profile); const result = await writeObservations(profile, fetched); results[profile.symbol] = { status:"PASS", changed:result.changed, accepted:result.accepted.length, rejected:result.rejected }; if (contract.canarySymbols.includes(profile.symbol)) { writeCanary += 1; const latest=result.accepted.at(-1)!; const check=await prisma.currencyIndexObservationMeta.findUnique({where:{symbol_observationDate:{symbol:profile.symbol,observationDate:latest.date}}}); if(check?.qualityStatus==="VALID")readBack+=1; } } catch(error) { results[profile.symbol]={status:"FAILED",error:error instanceof Error?error.message:String(error)}; await log({status:"SOURCE_FAILED",symbol:profile.symbol,error:error instanceof Error?error.message:String(error)}); } await syncMethodology(profile); analyticsCount += await analytics(profile); }
  for (const profile of contract.profiles) await projectCoverage(profile);
  const coverage=await prisma.currencyIndexCoverage.findMany({orderBy:{symbol:"asc"}}); const queue=contract.profiles.flatMap((profile)=>[{domain:"IDENTITY",symbol:profile.symbol,status:"COMPLETE"},{domain:"CURRENT_HISTORY",symbol:profile.symbol,status:profile.sourceAdapter==="NONE"?profile.licenseStatus==="LICENSE_REQUIRED"?"LICENSE_PENDING":"SOURCE_PENDING":"ACTIVE"},{domain:"METHODOLOGY",symbol:profile.symbol,status:profile.methodologyUrl?"ACTIVE":"SOURCE_PENDING"},{domain:"BASKET",symbol:profile.symbol,status:profile.licenseStatus==="LICENSE_REQUIRED"?"LICENSE_PENDING":"SOURCE_PENDING"},{domain:"EVENTS",symbol:profile.symbol,status:"SOURCE_PENDING"},{domain:"ANALYTICS",symbol:profile.symbol,status:"ACTIVE"},{domain:"PROVENANCE",symbol:profile.symbol,status:profile.sourceAdapter==="NONE"?"PENDING":"ACTIVE"},{domain:"COVERAGE",symbol:profile.symbol,status:"ACTIVE"}]);
  const now=new Date().toISOString(); const domains={CURRENT:{ready:coverage.filter(x=>x.currentAvailable).length},HISTORY:{ready:coverage.filter(x=>x.historyAvailable).length},METHODOLOGY:{ready:coverage.filter(x=>x.methodologyAvailable).length},BASKET:{ready:coverage.filter(x=>x.basketAvailable).length},WEIGHTS:{ready:coverage.filter(x=>x.weightsAvailable).length},EVENTS:{status:"SOURCE_OR_LICENSE_CONSTRAINED"},ANALYTICS:{ready:coverage.filter(x=>x.performanceAvailable).length}};
  await Promise.all(Object.entries(domains).map(([domain,state])=>atomic(resolve(root,"checkpoints",`${domain.toLowerCase()}.json`),`${JSON.stringify({version:4,pid:process.pid,domain,state,updatedAt:now},null,2)}\n`)));
  await atomic(queuePath, `${JSON.stringify({generatedAt:now,items:queue},null,2)}\n`); await atomic(checkpointPath, `${JSON.stringify({version:4,pid:process.pid,stage:"INCREMENTAL",lastSuccessfulRun:now,results,writeCanary,readBack,analyticsCount,queueSize:queue.filter(x=>x.status!=="COMPLETE").length},null,2)}\n`); await atomic(manifestPath, `${JSON.stringify({pid:process.pid,singleWriter:true,canonicalEntities:contract.profiles.length,validCurrent:coverage.filter(x=>x.currentAvailable).length,historyEntities:coverage.filter(x=>x.historyAvailable).length,methodologyEntities:coverage.filter(x=>x.methodologyAvailable).length,basketEntities:coverage.filter(x=>x.basketAvailable).length,performanceEntities:coverage.filter(x=>x.performanceAvailable).length,sourceVerifiedEntities:coverage.filter(x=>x.sourceVerified).length,writeCanary,readBack,backgroundMaxDepthContinuing:true,updatedAt:now},null,2)}\n`); await log({status:"P0_CYCLE_COMPLETE",writeCanary,readBack,analyticsCount});
}

async function main(){await acquireLock();const contract=await loadContract();if(process.argv.includes("--once")){await cycle(contract);return}for(;;){await cycle(contract);await sleep(15*60_000);}}
main().catch(async(error)=>{await log({status:"FATAL",error:error instanceof Error?error.message:String(error)}).catch(()=>undefined);process.exitCode=1;});
