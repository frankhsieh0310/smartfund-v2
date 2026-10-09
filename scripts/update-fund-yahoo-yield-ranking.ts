// Low-frequency materialization, not a request-per-page path. Run at most daily.
// Reuses the existing canonical universe, Yahoo parser/session, bounded concurrency (5).
// Only local cache files are written. Production DB is read in a READ ONLY transaction.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { prisma } from "../lib/prisma";
import { getYahooDirectYield } from "../lib/yahoo/distributionYield";
import { snapshotPath, rankFundYields, type FundYieldEntry, type FundYieldSnapshot } from "../lib/yahoo/fundYieldRanking";

async function main() {
  // Observe status only; all yield parsing remains in the unchanged shared layer.
  // 404 is source unavailable, not an inferred zero; 429/timeouts must remain failures.
  const originalFetch = globalThis.fetch;
  const statuses = new Map<string, number>();
  let cooldownUntil = 0;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname.endsWith('.finance.yahoo.com') && url.pathname.includes('/quoteSummary/')) statuses.set(decodeURIComponent(url.pathname.split('/').pop()!),response.status);
    if (response.status===429) {
      const retry=response.headers.get('retry-after');
      const seconds=retry && /^\d+$/.test(retry)?Number(retry):retry?Math.max(0,(Date.parse(retry)-Date.now())/1000):60;
      cooldownUntil=Math.max(cooldownUntil,Date.now()+Math.max(60,Number.isFinite(seconds)?seconds:60)*1000);
    }
    return response;
  };
  const universe = await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return tx.$queryRawUnsafe<Array<{id: string; code: string | null; name: string}>>(`
      SELECT s.id::text, y.provider_code AS code, COALESCE(NULLIF(s.share_class_name,''), f.name) AS name
      FROM fund_share_classes s JOIN funds f ON f.id=s.fund_id
      LEFT JOIN LATERAL (SELECT provider_code FROM fund_provider_mappings
        WHERE share_class_id=s.id AND provider='YAHOO' AND trim(provider_code)<>''
        ORDER BY provider_code LIMIT 1) y ON true
      WHERE s.status='ACTIVE' AND f.is_active=true ORDER BY s.id`);
  });
  const mapped = universe.filter((r): r is typeof r & {code:string} => r.code !== null);
  const checkpointPath = snapshotPath.replace(/\.json$/, ".pending.json");
  let checkpoint: Record<string, FundYieldEntry> = {};
  try { checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const liveIds=new Set(mapped.map(r=>r.id));
  checkpoint=Object.fromEntries(Object.entries(checkpoint).filter(([id])=>liveIds.has(id)));
  const failures: string[] = [];
  const entries: FundYieldEntry[] = [];
  const pending = mapped.filter(r => {
    const old = checkpoint[r.id];
    if (old?.code === r.code && Date.now() - Date.parse(old.checkedAt) < 86400000) { entries.push({...old,name:r.name}); return false; }
    return true;
  });
  console.log(JSON.stringify({universe:universe.length,mapped:mapped.length,cached:entries.length,toCheck:pending.length}));
  await mkdir(dirname(snapshotPath), {recursive:true});
  for (let i=0;i<pending.length;i+=5) {
    await Promise.all(pending.slice(i,i+5).map(async r => {
      try {
        const entry = {shareClassId:r.id,code:r.code,name:r.name,yahooYield:await getYahooDirectYield(r.code),checkedAt:new Date().toISOString()};
        checkpoint[r.id]=entry; entries.push(entry);
      } catch {
        if(statuses.get(r.code)===404){
          const entry={shareClassId:r.id,code:r.code,name:r.name,yahooYield:null,checkedAt:new Date().toISOString(),unavailable:true};
          checkpoint[r.id]=entry;entries.push(entry);
        } else {failures.push(r.code);if(failures.length<=3)console.log(JSON.stringify({fetchFailure:r.code,httpStatus:statuses.get(r.code)??null}));}
      }
    }));
    if (i%100===0 || i+5>=pending.length) {
      await writeFile(checkpointPath+".tmp",JSON.stringify(checkpoint));
      await rename(checkpointPath+".tmp",checkpointPath);
      console.log(JSON.stringify({checked:entries.length,total:mapped.length,failed:failures.length}));
    }
    if (failures.length>=25) {
      await writeFile(checkpointPath+".tmp",JSON.stringify(checkpoint));
      await rename(checkpointPath+".tmp",checkpointPath);
      throw new Error(`Yahoo failures reached safety bound; existing complete snapshot preserved. ${failures.join(',')}`);
    }
    if(cooldownUntil>Date.now()){
      console.log(JSON.stringify({rateLimitCooldownMs:cooldownUntil-Date.now(),checked:entries.length}));
      await new Promise(resolve=>setTimeout(resolve,cooldownUntil-Date.now()));
    }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if (failures.length) throw new Error(`Incomplete snapshot NOT published; retry failures using checkpoint: ${failures.join(',')}`);
  entries.sort((a,b)=>a.shareClassId.localeCompare(b.shareClassId));
  const rows=rankFundYields(entries);
  const version=createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  const snapshot: FundYieldSnapshot={version,source:'YAHOO_DIRECT',universeCount:universe.length,mappedCount:mapped.length,checkedCount:entries.length,missingCount:entries.length-rows.length,failedCount:0,rows};
  await writeFile(snapshotPath+'.tmp',JSON.stringify(snapshot));
  await rename(snapshotPath+'.tmp',snapshotPath);
  console.log(JSON.stringify({complete:true,universe:universe.length,mapped:mapped.length,eligible:rows.length,missing:snapshot.missingCount,version}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>prisma.$disconnect());
