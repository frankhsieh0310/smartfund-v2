import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const runtime = resolve("runtime", "index-constituent-derived-analytics");
const checkpointPath = resolve(runtime, "checkpoint.json");
const lockPath = resolve(runtime, "single-writer.lock");
const databaseUrl = new URL(process.env.DATABASE_URL!);
databaseUrl.searchParams.set("connection_limit", "1");
databaseUrl.searchParams.set("options", "-c default_transaction_read_only=off");
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
const once = process.argv.includes("--once");
const deferFirst = process.argv.includes("--defer-first");
const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function alive(pid?: number) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function acquire() {
  await mkdir(runtime, { recursive: true });
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
  } catch {
    const owner = await readFile(lockPath, "utf8").then((value) => JSON.parse(value)).catch(() => ({}));
    if (alive(owner.pid)) throw new Error(`CONSTITUENT_DERIVED_ANALYTICS_ALREADY_RUNNING:${owner.pid}`);
    await unlink(lockPath).catch(() => undefined);
    await acquire();
  }
}

async function materialize() {
  const countryRows = await prisma.$executeRawUnsafe(`
    WITH grouped AS (
      SELECT c.index_id,s.effective_date,coalesce(sec.country,'UNKNOWN') country,
        count(*)::numeric constituent_count,sum(c.source_weight)::numeric weight
      FROM index_constituents c
      JOIN index_constituent_snapshots s ON s.id=c.snapshot_id AND s.verification_status='VERIFIED_OFFICIAL'
      JOIN securities sec ON sec.id=c.security_id
      GROUP BY c.index_id,s.effective_date,coalesce(sec.country,'UNKNOWN')
    ), metrics AS (
      SELECT index_id,effective_date,'COUNTRY_WEIGHT_PCT:'||country metric,weight value FROM grouped
      UNION ALL
      SELECT index_id,effective_date,'COUNTRY_CONSTITUENT_COUNT:'||country,constituent_count FROM grouped
    )
    INSERT INTO global_index_analytics(index_id,metric,as_of_date,value,source,created_at,updated_at)
    SELECT index_id,metric,effective_date,value,'DERIVED_FROM_VERIFIED_PIT_CONSTITUENTS',now(),now() FROM metrics
    ON CONFLICT(index_id,metric,as_of_date) DO UPDATE SET value=EXCLUDED.value,source=EXCLUDED.source,updated_at=now()`);

  const concentrationRows = await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT c.index_id,s.effective_date,c.source_weight::numeric weight,
        row_number() OVER(PARTITION BY c.index_id,s.effective_date ORDER BY c.source_weight DESC NULLS LAST) rank
      FROM index_constituents c JOIN index_constituent_snapshots s ON s.id=c.snapshot_id
      WHERE s.verification_status='VERIFIED_OFFICIAL' AND c.source_weight IS NOT NULL
    ), grouped AS (
      SELECT index_id,effective_date,max(weight) top1,sum(weight)FILTER(WHERE rank<=5) top5,
        sum(weight)FILTER(WHERE rank<=10) top10,sum(weight)FILTER(WHERE rank<=20) top20,
        sum(power(weight/100.0,2)) hhi
      FROM ranked GROUP BY index_id,effective_date
    ), metrics AS (
      SELECT index_id,effective_date,m.metric,m.value FROM grouped
      CROSS JOIN LATERAL(VALUES('TOP_1_WEIGHT',top1),('TOP_5_CONCENTRATION',top5),
        ('TOP_10_CONCENTRATION',top10),('TOP_20_CONCENTRATION',top20),('HHI',hhi),
        ('EFFECTIVE_NUMBER_OF_CONSTITUENTS',1/nullif(hhi,0)))m(metric,value)
    )
    INSERT INTO global_index_analytics(index_id,metric,as_of_date,value,source,created_at,updated_at)
    SELECT index_id,metric,effective_date,value,'DERIVED_VERIFIED_PIT_WEIGHTS',now(),now() FROM metrics WHERE value IS NOT NULL
    ON CONFLICT(index_id,metric,as_of_date) DO UPDATE SET value=EXCLUDED.value,source=EXCLUDED.source,updated_at=now()`);

  const contributionRows = await prisma.$executeRawUnsafe(`
    WITH snapshots AS (
      SELECT id,index_id,effective_date,lag(id)OVER(PARTITION BY index_id ORDER BY effective_date) previous_id,
        lag(effective_date)OVER(PARTITION BY index_id ORDER BY effective_date) previous_date
      FROM index_constituent_snapshots WHERE verification_status='VERIFIED_OFFICIAL'
    ), aligned AS (
      SELECT cur.index_id,cur.effective_date,c.security_id,l.stock_id,c.source_weight,
        p0.close::numeric price0,p1.close::numeric price1
      FROM snapshots cur
      JOIN index_constituents c ON c.snapshot_id=cur.previous_id AND c.security_id IS NOT NULL AND c.source_weight IS NOT NULL
      JOIN stock_security_links l ON l.security_id=c.security_id AND l.verification_status='VERIFIED_EXACT'
      JOIN LATERAL(SELECT coalesce(h.adjusted_close,h.close) close FROM stock_history h WHERE h.stock_id=l.stock_id AND h.date<=cur.previous_date ORDER BY h.date DESC LIMIT 1)p0 ON true
      JOIN LATERAL(SELECT coalesce(h.adjusted_close,h.close) close FROM stock_history h WHERE h.stock_id=l.stock_id AND h.date<=cur.effective_date ORDER BY h.date DESC LIMIT 1)p1 ON true
      WHERE cur.previous_id IS NOT NULL AND p0.close<>0
    ), metrics AS (
      SELECT index_id,effective_date,'CONTRIBUTION_STOCK:'||stock_id metric,
        (source_weight/100.0)*(price1/price0-1)*100 value FROM aligned
    )
    INSERT INTO global_index_analytics(index_id,metric,as_of_date,value,source,created_at,updated_at)
    SELECT index_id,metric,effective_date,value,'DERIVED_PIT_WEIGHT_ALIGNED_STOCK_RETURN',now(),now() FROM metrics
    ON CONFLICT(index_id,metric,as_of_date) DO UPDATE SET value=EXCLUDED.value,source=EXCLUDED.source,updated_at=now()`);

  const turnoverRows = await prisma.$executeRawUnsafe(`
    WITH snapshots AS (
      SELECT id,index_id,effective_date,lag(id)OVER(PARTITION BY index_id ORDER BY effective_date) previous_id
      FROM index_constituent_snapshots WHERE verification_status='VERIFIED_OFFICIAL'
    ), changes AS (
      SELECT s.index_id,s.effective_date,coalesce(a.security_id,b.security_id) security_id,
        coalesce(a.source_weight,0)::numeric previous_weight,coalesce(b.source_weight,0)::numeric current_weight
      FROM snapshots s
      JOIN index_constituents a ON a.snapshot_id=s.previous_id
      FULL JOIN index_constituents b ON b.snapshot_id=s.id AND b.security_id=a.security_id
      WHERE s.previous_id IS NOT NULL
    ), metrics AS (
      SELECT index_id,effective_date,sum(abs(current_weight-previous_weight))/2 value
      FROM changes GROUP BY index_id,effective_date
    )
    INSERT INTO global_index_analytics(index_id,metric,as_of_date,value,source,created_at,updated_at)
    SELECT index_id,'CONSTITUENT_TURNOVER_PROXY',effective_date,value,'DERIVED_FROM_CONSECUTIVE_VERIFIED_PIT_WEIGHTS',now(),now() FROM metrics
    ON CONFLICT(index_id,metric,as_of_date) DO UPDATE SET value=EXCLUDED.value,source=EXCLUDED.source,updated_at=now()`);

  const overlapRows = await prisma.$executeRawUnsafe(`
    WITH snapshots AS (
      SELECT id,index_id,effective_date FROM index_constituent_snapshots
      WHERE verification_status='VERIFIED_OFFICIAL'
    ), pairs AS (
      SELECT a.index_id index_a,b.index_id index_b,a.effective_date as_of_date,
        a.id snapshot_a,b.id snapshot_b
      FROM snapshots a JOIN snapshots b
        ON a.index_id<b.index_id AND a.effective_date=b.effective_date
    ), members AS (
      SELECT p.index_a,p.index_b,p.as_of_date,u.security_id,
        ca.source_weight::numeric weight_a,cb.source_weight::numeric weight_b
      FROM pairs p
      CROSS JOIN LATERAL (
        SELECT security_id FROM index_constituents WHERE snapshot_id=p.snapshot_a AND security_id IS NOT NULL
        UNION
        SELECT security_id FROM index_constituents WHERE snapshot_id=p.snapshot_b AND security_id IS NOT NULL
      ) u
      LEFT JOIN index_constituents ca ON ca.snapshot_id=p.snapshot_a AND ca.security_id=u.security_id
      LEFT JOIN index_constituents cb ON cb.snapshot_id=p.snapshot_b AND cb.security_id=u.security_id
    ), stats AS (
      SELECT index_a,index_b,as_of_date,
        count(*)FILTER(WHERE weight_a IS NOT NULL AND weight_b IS NOT NULL)::numeric shared,
        count(*)::numeric union_count,
        sum(least(weight_a,weight_b))FILTER(WHERE weight_a IS NOT NULL AND weight_b IS NOT NULL)::numeric weighted_overlap
      FROM members GROUP BY index_a,index_b,as_of_date
    ), metrics AS (
      SELECT index_a,index_b,as_of_date,m.metric,m.value FROM stats
      CROSS JOIN LATERAL(VALUES('OVERLAP_SHARED_STOCKS',shared),('OVERLAP_UNION_STOCKS',union_count),
        ('OVERLAP_JACCARD',shared/nullif(union_count,0)),
        ('OVERLAP_WEIGHTED_PCT',weighted_overlap))m(metric,value)
    )
    INSERT INTO global_index_analytics(index_id,metric,as_of_date,value,source,created_at,updated_at)
    SELECT index_a,metric||':'||index_b,as_of_date,value,'DERIVED_CANONICAL_PIT_MEMBERSHIP',now(),now() FROM metrics WHERE value IS NOT NULL
    ON CONFLICT(index_id,metric,as_of_date) DO UPDATE SET value=EXCLUDED.value,source=EXCLUDED.source,updated_at=now()`);

  const fundamentalCoverageRows = await prisma.$executeRawUnsafe(`
    WITH membership AS (
      SELECT c.index_id,s.effective_date,l.stock_id,c.source_weight
      FROM index_constituents c JOIN index_constituent_snapshots s ON s.id=c.snapshot_id AND s.verification_status='VERIFIED_OFFICIAL'
      JOIN stock_security_links l ON l.security_id=c.security_id AND l.verification_status='VERIFIED_EXACT'
    ), coverage AS (
      SELECT m.index_id,m.effective_date,count(DISTINCT m.stock_id)::numeric eligible,
        count(DISTINCT m.stock_id)FILTER(WHERE EXISTS(SELECT 1 FROM stock_financial_facts f WHERE f.stock_id=m.stock_id AND coalesce(f.publication_date,f.filing_date,f.period_end)<=m.effective_date))::numeric covered,
        coalesce(sum(m.source_weight)FILTER(WHERE EXISTS(SELECT 1 FROM stock_financial_facts f WHERE f.stock_id=m.stock_id AND coalesce(f.publication_date,f.filing_date,f.period_end)<=m.effective_date)),0)::numeric covered_weight
      FROM membership m GROUP BY m.index_id,m.effective_date
    ), metrics AS (
      SELECT index_id,effective_date,m.metric,m.value FROM coverage
      CROSS JOIN LATERAL(VALUES('FUNDAMENTAL_ELIGIBLE_STOCKS',eligible),('FUNDAMENTAL_COVERED_STOCKS',covered),
        ('FUNDAMENTAL_COVERED_WEIGHT_PCT',covered_weight))m(metric,value)
    )
    INSERT INTO global_index_analytics(index_id,metric,as_of_date,value,source,created_at,updated_at)
    SELECT index_id,metric,effective_date,value,'DERIVED_PIT_FUNDAMENTAL_COVERAGE_GATE',now(),now() FROM metrics
    ON CONFLICT(index_id,metric,as_of_date) DO UPDATE SET value=EXCLUDED.value,source=EXCLUDED.source,updated_at=now()`);

  return { countryRows, concentrationRows, contributionRows, turnoverRows, overlapRows, fundamentalCoverageRows };
}

async function readback() {
  const [row] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT count(*)FILTER(WHERE metric LIKE 'COUNTRY_%')::int country_rows,
      count(*)FILTER(WHERE metric LIKE 'CONTRIBUTION_STOCK:%')::int contribution_rows,
      count(*)FILTER(WHERE metric='CONSTITUENT_TURNOVER_PROXY')::int turnover_rows,
      count(*)FILTER(WHERE metric LIKE 'OVERLAP_%')::int overlap_rows,
      count(*)FILTER(WHERE metric LIKE 'FUNDAMENTAL_%')::int fundamental_coverage_rows
    FROM global_index_analytics WHERE source LIKE 'DERIVED_%PIT%' OR source='DERIVED_FROM_VERIFIED_PIT_CONSTITUENTS'`);
  return row;
}

async function dependencySignature() {
  const [row] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT coalesce(string_agg(relname||':'||n_tup_ins||':'||n_tup_upd||':'||n_tup_del,'|' ORDER BY relname),'')||'|'||
      (SELECT count(*)||':'||coalesce(max(updated_at)::text,'') FROM index_constituent_snapshots
       WHERE verification_status='VERIFIED_OFFICIAL') signature
    FROM pg_stat_all_tables
    WHERE schemaname=current_schema() AND relname IN ('index_constituent_snapshots','index_constituents',
      'index_constituent_mapping_queue','stock_history','stock_financial_facts','securities')`);
  return String(row.signature);
}

async function previousDependencySignature() {
  const checkpoint = await readFile(checkpointPath, "utf8").then((value) => JSON.parse(value)).catch(() => null);
  return checkpoint?.result?.dependencySignature as string | undefined;
}

async function publish(state: string, result: unknown, error: string | null = null) {
  const now = new Date();
  await atomic(checkpointPath, { asset: "GLOBAL_INDEX", worker: "CONSTITUENT_DERIVED_ANALYTICS", pid: process.pid,
    state, resumable: true, autoContinuing: !once, triggerMode: "PIT_SNAPSHOT_MAPPING_TAXONOMY_FACT_PRICE_DEPENDENCY_SCAN_6H",
    maxDbConcurrency: 1, result, error, heartbeatAt: now.toISOString(),
    lastSuccessAt: state === "SCHEDULED_WAIT" ? now.toISOString() : null,
    nextRunAt: !once ? new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString() : null,
    updatedAt: now.toISOString() });
}

async function main() {
  await acquire();
  try {
    if (!once && deferFirst) {
      await publish("SCHEDULED_WAIT", { readback: await readback(), recovery: "23502_OVERLAP_GRAIN_FIXED",
        dependencySignature: await dependencySignature(), affectedIndexes: 2 });
      await sleep(6 * 60 * 60 * 1000);
    }
    for (;;) {
      try {
        const signature = await dependencySignature();
        if (!once && signature === await previousDependencySignature()) {
          await publish("SCHEDULED_WAIT", { readback: await readback(), dependencySignature: signature,
            affectedIndexes: 0, skipped: "DEPENDENCIES_UNCHANGED" });
        } else {
          const writes = await materialize();
          const result = { writes, readback: await readback(), dependencySignature: signature, affectedIndexes: 2 };
          await publish("SCHEDULED_WAIT", result);
          if (once) console.log(JSON.stringify(result));
        }
      }
      catch (error) { await publish("RETRY_WAIT", null, error instanceof Error ? error.message : String(error)); if (once) throw error; }
      if (once) break;
      await sleep(6 * 60 * 60 * 1000);
    }
  } finally { await prisma.$disconnect(); await unlink(lockPath).catch(() => undefined); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
