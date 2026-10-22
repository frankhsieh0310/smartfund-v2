import { PrismaClient } from '@prisma/client';
import { execFile } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';

const APPLY = process.argv.includes('--apply-safe-cleanup');
const ROOT = path.resolve('runtime/global-stock/maximum-professional-recovery-v2');
const TARGETS = ['stock-price-jpx-historical', 'official-financial-nyse-historical'];
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL } } });
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const execFileAsync = promisify(execFile);
const EXPECTED_PROCESS = new Map([
  ['stock-price-jpx-historical', /run-jpx-standalone|run-production-jpx-historical/i],
  ['official-financial-nyse-historical', /run-production-sec-financial|run-official-financial-supervisor/i],
]);

function ownerPids(owner: string) {
  return [...owner.matchAll(/(?::|^)(\d+)(?::|$)/g)].map(match => Number(match[1])).filter(Number.isSafeInteger);
}

async function processIdentity(pid: number, jobId: string) {
  const command = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if($p){[PSCustomObject]@{processId=$p.ProcessId;name=$p.Name;creationDate=$p.CreationDate.ToString('o');commandLine=$p.CommandLine}|ConvertTo-Json -Compress}`;
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', command], { windowsHide: true });
    const value = stdout.trim() ? JSON.parse(stdout.trim()) : null;
    return { pid, present: Boolean(value), matchesExpectedWriter: Boolean(value && EXPECTED_PROCESS.get(jobId)?.test(value.commandLine ?? '')), ...value };
  } catch (error) {
    return { pid, present: true, matchesExpectedWriter: true, verificationError: error instanceof Error ? error.message : String(error) };
  }
}

async function atomicJson(name: string, value: unknown) {
  await mkdir(ROOT, { recursive: true });
  const target = path.join(ROOT, name);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${json(value)}\n`, 'utf8');
  await rename(temp, target);
}

async function snapshot() {
  const locks = await prisma.$queryRawUnsafe<any[]>(
    `SELECT job_id, owner, expires_at, updated_at FROM production_scheduler_locks WHERE job_id = ANY($1::text[]) ORDER BY job_id`,
    TARGETS,
  );
  const runs = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT ON (job_id) id, job_id, status, started_at, completed_at, attempted, completed, failed, exit_code, error
       FROM production_scheduler_runs WHERE job_id = ANY($1::text[]) ORDER BY job_id, started_at DESC`,
    TARGETS,
  );
  const checkpoints = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT ON (c.job_id) c.checkpoint_key, c.job_id, c.run_id, c.last_symbol, c.processed, c.succeeded, c.failed, c.updated_at, r.status AS run_status
       FROM production_scheduler_checkpoints c
       JOIN production_scheduler_runs r ON r.id = c.run_id
      WHERE c.job_id = ANY($1::text[])
      ORDER BY c.job_id, c.updated_at DESC`,
    TARGETS,
  );
  const advisory = await prisma.$queryRawUnsafe<Array<{ pid: number; granted: boolean; classid: string; objid: string; objsubid: number; application_name: string | null; query: string | null; backend_start: Date | null; query_start: Date | null }>>(
    `SELECT l.pid, l.granted, l.classid::text, l.objid::text, l.objsubid, a.application_name, LEFT(a.query,300) AS query, a.backend_start, a.query_start
       FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE l.locktype='advisory' AND l.database = (SELECT oid FROM pg_database WHERE datname=current_database())
      ORDER BY l.pid`,
  );
  const auditAt = new Date();
  return {
    auditAt: auditAt.toISOString(),
    advisoryLockCount: advisory.length,
    advisoryLocks: advisory,
    jobs: await Promise.all(TARGETS.map(async jobId => {
      const lock = locks.find(item => item.job_id === jobId) ?? null;
      const run = runs.find(item => item.job_id === jobId) ?? null;
      const checkpoint = checkpoints.find(item => item.job_id === jobId) ?? null;
      const pids = lock ? ownerPids(lock.owner) : [];
      const processes = await Promise.all(pids.map(pid => processIdentity(pid, jobId)));
      const advisoryMatches = await prisma.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count FROM pg_locks
          WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
            AND (classid::int = hashtext($1) OR objid::int = hashtext($1))`,
        jobId,
      );
      const advisoryLockMatchCount = advisoryMatches[0]?.count ?? 0;
      const lockActive = Boolean(lock && new Date(lock.expires_at) > auditAt && new Date(lock.updated_at).getTime() > auditAt.getTime() - 600_000);
      const expectedWriterPresent = processes.some(item => item.matchesExpectedWriter);
      const safeToClean = Boolean(lock && !lockActive && !expectedWriterPresent && advisoryLockMatchCount === 0 && checkpoint);
      return { jobId, lock, run, checkpoint, processes, advisoryLockMatchCount, lockActive, activeWriter: lockActive && expectedWriterPresent, safeToClean };
    })),
  };
}

async function cleanup(before: Awaited<ReturnType<typeof snapshot>>) {
  const results: any[] = [];
  for (const job of before.jobs) {
    if (!job.safeToClean) {
      results.push({ jobId: job.jobId, action: 'NO_ACTION_FAIL_CLOSED', reason: job.lockActive ? 'ACTIVE_LOCK' : !job.checkpoint ? 'CHECKPOINT_NOT_VERIFIED' : 'PROCESS_OR_ADVISORY_LOCK_PRESENT' });
      continue;
    }
    const result = await prisma.$transaction(async tx => {
      const locks = await tx.$queryRawUnsafe<any[]>(
        `DELETE FROM production_scheduler_locks
          WHERE job_id=$1 AND owner=$2 AND expires_at<NOW() AND updated_at<NOW()-INTERVAL '10 minutes'
          RETURNING job_id, owner`,
        job.jobId,
        job.lock.owner,
      );
      const runs = await tx.$queryRawUnsafe<any[]>(
        `UPDATE production_scheduler_runs
            SET status='STALE', completed_at=COALESCE(completed_at,NOW()), exit_code=COALESCE(exit_code,1),
                error=COALESCE(error,'ORPHANED_LIFECYCLE_RECOVERY_V2')
          WHERE id=$1 AND status='IN_PROGRESS' AND started_at<NOW()-INTERVAL '10 minutes'
          RETURNING id, job_id, status`,
        job.run?.id ?? '',
      );
      return { locks, runs };
    });
    results.push({ jobId: job.jobId, action: 'STALE_LIFECYCLE_CLEANED', ...result });
  }
  return results;
}

async function main() {
  if (!process.env.DIRECT_URL && !process.env.DATABASE_URL) throw new Error('DATABASE_URL_NOT_CONFIGURED');
  await prisma.$queryRaw`SELECT 1`;
  const before = await snapshot();
  const actions = APPLY ? await cleanup(before) : [];
  const after = APPLY ? await snapshot() : before;
  const result = { task: 'GLOBAL_STOCK_MAXIMUM_PROFESSIONAL_DEPTH_BREADTH_AND_CANONICAL_RECOVERY_V2', mode: APPLY ? 'SAFE_CLEANUP' : 'READ_ONLY_AUDIT', before, actions, after, databaseDdl: false, migration: false, completedAt: now() };
  await atomicJson(APPLY ? 'lifecycle-cleanup.json' : 'lifecycle-audit.json', result);
  console.log(json(result));
}

main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
