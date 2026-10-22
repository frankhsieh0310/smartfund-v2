import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const root = process.cwd();
const runtime = path.join(root, 'runtime', 'insider-ownership');
const checkpointFile = path.join(runtime, 'checkpoint.json');
const logFile = path.join(runtime, 'runner.log');
const manifestFile = path.join(runtime, 'completion-manifest.json');
const retryFile = path.join(runtime, 'retry.jsonl');
const archiveDir = path.join(runtime, 'archive');
const rawDir = path.join(runtime, 'raw');
const canary = process.argv.includes('--canary');
const once = canary || process.argv.includes('--once');
const prisma = new PrismaClient();

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const now = () => new Date().toISOString();
const log = async (message) => appendFile(logFile, `${now()} ${message}\n`);
const atomicJson = async (file, value) => {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
};
const saveCheckpoint = async (stage, scope, extra = {}) => { let previous={};try{previous=await readJson(checkpointFile)}catch{}const value={
  ...previous, asset: 'GLOBAL_INSIDER_OWNERSHIP', stage, scope, updatedAt: now(), pid: process.pid, ...extra
};if(stage!=='FAILED')delete value.error;return atomicJson(checkpointFile,value)};
async function fetchBody(url, scheduler, accept='application/json,text/xml,*/*') { const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),scheduler.request.timeoutSeconds*1000);try{const response=await fetch(url,{headers:{'user-agent':scheduler.request.userAgent,accept},signal:controller.signal});if(!response.ok)throw new Error(`HTTP ${response.status}`);return Buffer.from(await response.arrayBuffer())}finally{clearTimeout(timer)}}
function xmlValue(block,name){return block.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>[\\s\\S]*?<(?:\\w+:)?value(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?value>[\\s\\S]*?<\\/(?:\\w+:)?${name}>`,'i'))?.[1]?.replace(/<[^>]+>/g,'').trim()??''}
function tag(block,name){return block.match(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`,'i'))?.[1]?.replace(/<[^>]+>/g,'').trim()??''}
function parseForm4(xml){const symbol=tag(xml,'issuerTradingSymbol');const issuer=tag(xml,'issuerName');const insider=tag(xml,'rptOwnerName');const role=xmlValue(xml,'officerTitle')||null;const blocks=xml.match(/<(?:\w+:)?nonDerivativeTransaction(?:\s[^>]*)?>[\s\S]*?<\/(?:\w+:)?nonDerivativeTransaction>/gi)??[];return {symbol,issuer,insider,role,transactions:blocks.map((block,index)=>({index,transactionDate:xmlValue(block,'transactionDate'),transactionType:tag(block,'transactionCode'),shares:Number(xmlValue(block,'transactionShares')),price:xmlValue(block,'transactionPricePerShare')?Number(xmlValue(block,'transactionPricePerShare')):null,ownershipAfter:xmlValue(block,'sharesOwnedFollowingTransaction')?Number(xmlValue(block,'sharesOwnedFollowingTransaction')):null})).filter(item=>item.transactionDate&&item.transactionType&&Number.isFinite(item.shares))}}
async function runSec(stage, source, scheduler){await saveCheckpoint(stage,`sec:${stage.toLowerCase()}`);const registry=JSON.parse((await fetchBody(source.discoveryUrl,scheduler)).toString('utf8'));const fields=registry.fields??[];const tickerIndex=fields.indexOf('ticker'),cikIndex=fields.indexOf('cik');const row=(registry.data??[]).find(item=>String(item[tickerIndex]).toUpperCase()==='AAPL');if(!row)throw new Error('SEC_AAPL_CIK_NOT_FOUND');const cik=String(row[cikIndex]).padStart(10,'0');const submissions=JSON.parse((await fetchBody(`https://data.sec.gov/submissions/CIK${cik}.json`,scheduler)).toString('utf8'));const recent=submissions?.filings?.recent??{};const index=(recent.form??[]).findIndex(form=>form==='4'||form==='4/A');if(index<0)throw new Error('SEC_FORM4_NOT_FOUND');const accession=recent.accessionNumber[index],accessionPath=accession.replaceAll('-',''),primaryDocument=String(recent.primaryDocument[index]).split('/').at(-1);const filingUrl=`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionPath}/${primaryDocument}`;const xml=(await fetchBody(filingUrl,scheduler,'application/xml,text/xml,*/*')).toString('utf8');await writeFile(path.join(rawDir,`SEC-${accession}.xml`),xml);const parsed=parseForm4(xml);if(!parsed.transactions.length)throw new Error(`FORM4_PARSE_EMPTY:${accession}`);const securities=await prisma.$queryRawUnsafe(`SELECT id,name,ticker FROM securities WHERE UPPER(ticker)=UPPER($1) LIMIT 1`,parsed.symbol);if(!securities[0])throw new Error(`EXISTING_SECURITY_NOT_FOUND:${parsed.symbol}`);const transaction=parsed.transactions[0],sourceKey=createHash('sha256').update(`${accession}|${transaction.index}|${transaction.transactionDate}|${transaction.transactionType}`).digest('hex');await prisma.$executeRawUnsafe(`INSERT INTO insider_ownership_transactions (id,security_id,insider,role,transaction_date,transaction_type,shares,price,ownership_after,source,filing_id,source_key,created_at,updated_at) VALUES ($1::uuid,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW()) ON CONFLICT (source_key) DO UPDATE SET shares=EXCLUDED.shares,price=EXCLUDED.price,ownership_after=EXCLUDED.ownership_after,updated_at=NOW()`,randomUUID(),securities[0].id,parsed.insider,parsed.role,transaction.transactionDate,transaction.transactionType,transaction.shares,transaction.price,transaction.ownershipAfter,'SEC EDGAR Form 4',accession,sourceKey);const readBack=await prisma.$queryRawUnsafe(`SELECT s.name AS issuer,i.insider,i.transaction_date,i.transaction_type,i.shares,i.source,i.filing_id FROM insider_ownership_transactions i JOIN securities s ON s.id=i.security_id WHERE i.source_key=$1 LIMIT 1`,sourceKey);if(!readBack[0])throw new Error(`CANONICAL_READ_BACK_FAILED:${accession}`);const result={source:'SEC_EDGAR',ok:true,fetch:'PASS',parse:'PASS',canonicalMapping:'PASS',canonicalWrite:'PASS',readBack:'PASS',filingUrl,filingId:accession,sourceLatest:recent.filingDate[index],canonical:readBack[0]};await saveCheckpoint(stage,'sec:complete',{lastProcessedFiling:accession,lastTransactionDate:transaction.transactionDate,autoContinuing:!once});await atomicJson(manifestFile,{asset:'GLOBAL_INSIDER_OWNERSHIP',stage,completedAt:now(),results:[result],autoContinuing:!once});await log(`stage=${stage} SEC filing=${accession} canonicalWrite=PASS readBack=PASS`);return result}

async function fetchWithRetry(source, scheduler, scope) {
  let lastError;
  for (let attempt = 1; attempt <= scheduler.retry.maxAttempts; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), scheduler.request.timeoutSeconds * 1000);
      const response = await fetch(source.discoveryUrl, {
        headers: { 'user-agent': scheduler.request.userAgent, accept: 'application/json,text/html,*/*' },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      const target = path.join(rawDir, `${source.id}-${scope}-${Date.now()}.bin`);
      await writeFile(target, body);
      return { source: source.id, ok: true, bytes: body.length, target };
    } catch (error) {
      lastError = error;
      await appendFile(retryFile, `${JSON.stringify({ at: now(), source: source.id, scope, attempt, error: String(error) })}\n`);
      if (attempt < scheduler.retry.maxAttempts) {
        const delay = Math.min(scheduler.retry.maxDelaySeconds, scheduler.retry.baseDelaySeconds * 2 ** (attempt - 1));
        await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      }
    }
  }
  return { source: source.id, ok: false, error: String(lastError) };
}

async function runStage(stage, sources, scheduler) {
  const scope = stage === 'HISTORICAL' ? 'official-registry-bootstrap' : stage.toLowerCase();
  await saveCheckpoint(stage, scope);
  await log(`stage=${stage} scope=${scope} started`);
  const results = [];
  for (const source of sources) {
    await saveCheckpoint(stage, `${scope}:${source.id}`);
    results.push(await fetchWithRetry(source, scheduler, stage.toLowerCase()));
  }
  const completedAt = now();
  await atomicJson(manifestFile, { asset: 'GLOBAL_INSIDER_OWNERSHIP', stage, completedAt, results });
  await writeFile(path.join(archiveDir, `${completedAt.replaceAll(':', '-')}-${stage}.json`), `${JSON.stringify(results, null, 2)}\n`);
  await log(`stage=${stage} completed ok=${results.filter((item) => item.ok).length}/${results.length}`);
}

async function runSecFresh(stage, source, scheduler) {
  const initial = await runSec(stage, source, scheduler);
  const xml = await readFile(path.join(rawDir, `SEC-${initial.filingId}.xml`), 'utf8');
  const parsed = parseForm4(xml);
  const securities = await prisma.$queryRawUnsafe(`SELECT id,name,ticker FROM securities WHERE UPPER(ticker)=UPPER($1) LIMIT 1`, parsed.symbol);
  if (!securities[0]) throw new Error(`EXISTING_SECURITY_NOT_FOUND:${parsed.symbol}`);
  let gapRecordsWritten = 0;
  for (const transaction of parsed.transactions) {
    const sourceKey = createHash('sha256').update(`${initial.filingId}|${transaction.index}|${transaction.transactionDate}|${transaction.transactionType}`).digest('hex');
    const existing = await prisma.$queryRawUnsafe(`SELECT 1 FROM insider_ownership_transactions WHERE source_key=$1 LIMIT 1`, sourceKey);
    await prisma.$executeRawUnsafe(`INSERT INTO insider_ownership_transactions (id,security_id,insider,role,transaction_date,transaction_type,shares,price,ownership_after,source,filing_id,source_key,created_at,updated_at) VALUES ($1::uuid,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW()) ON CONFLICT (source_key) DO UPDATE SET shares=EXCLUDED.shares,price=EXCLUDED.price,ownership_after=EXCLUDED.ownership_after,updated_at=NOW()`, randomUUID(), securities[0].id, parsed.insider, parsed.role, transaction.transactionDate, transaction.transactionType, transaction.shares, transaction.price, transaction.ownershipAfter, 'SEC EDGAR Form 4', initial.filingId, sourceKey);
    if (!existing[0]) gapRecordsWritten += 1;
  }
  const readBack = await prisma.$queryRawUnsafe(`SELECT s.name AS issuer,i.insider,i.transaction_date,i.transaction_type,i.shares,i.source,i.filing_id FROM insider_ownership_transactions i JOIN securities s ON s.id=i.security_id WHERE i.filing_id=$1 ORDER BY i.transaction_date DESC,i.created_at DESC LIMIT 1`, initial.filingId);
  if (!readBack[0]) throw new Error(`FRESHNESS_READ_BACK_FAILED:${initial.filingId}`);
  const sourceLatest = parsed.transactions.map(item => item.transactionDate).sort().at(-1);
  const result = { ...initial, sourceLatest, gapRecordsWritten, canonical: readBack[0] };
  await saveCheckpoint(stage, 'sec:complete', { lastProcessedFiling: initial.filingId, lastTransactionDate: readBack[0].transaction_date.toISOString().slice(0, 10), sourceLatestTransactionDate: sourceLatest, gapRecordsWritten, autoContinuing: !once });
  await atomicJson(manifestFile, { asset: 'GLOBAL_INSIDER_OWNERSHIP', stage, completedAt: now(), results: [result], autoContinuing: !once });
  return result;
}

async function main() {
  await Promise.all([mkdir(runtime, { recursive: true }), mkdir(archiveDir, { recursive: true }), mkdir(rawDir, { recursive: true })]);
  const registry = await readJson(path.join(root, 'config', 'global-insider-official-registry.json'));
  const scheduler = await readJson(path.join(root, 'config', 'global-insider-scheduler.json'));
  const sec=registry.sources.find(source=>source.id==='SEC_EDGAR');if(!sec)throw new Error('SEC_SOURCE_NOT_CONFIGURED');
  await atomicJson(path.join(runtime, 'runner.json'), { asset: 'GLOBAL_INSIDER_OWNERSHIP', pid: process.pid, startedAt: now() });
  await runSecFresh(canary?'CANARY':'LATEST',sec,scheduler);
  while (!once) {
    await runSecFresh('INCREMENTAL',sec,scheduler);
    await saveCheckpoint('SCHEDULER', `next-incremental-in-${scheduler.incrementalIntervalMinutes}m`, { autoContinuing: true });
    await new Promise((resolve) => setTimeout(resolve, scheduler.incrementalIntervalMinutes * 60_000));
  }
}

main().catch(async (error) => {
  await mkdir(runtime, { recursive: true });
  await log(`fatal=${String(error?.stack || error)}`);
  await saveCheckpoint('FAILED', 'runner', { error: String(error) });
  process.exitCode = 1;
}).finally(()=>prisma.$disconnect());
