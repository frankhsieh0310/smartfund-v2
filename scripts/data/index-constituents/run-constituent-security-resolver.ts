import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

type Candidate = {
  constituentId: string;
  queueId: string;
  securityId: string | null;
  stockId: string | null;
  matchMethod: string | null;
  classification: "MAPPED_STOCK" | "MAPPED_NON_STOCK_SECURITY" | "IDENTIFIER_NOT_FOUND" | "IDENTIFIER_MISSING" | "EXCHANGE_MISSING" | "AMBIGUOUS" | "SOURCE_RAW_ONLY";
};

const runtime = resolve("runtime", "index-constituent-security-resolver");
const checkpointPath = resolve(runtime, "checkpoint.json");
const lockPath = resolve(runtime, "single-writer.lock");
const databaseUrl = new URL(process.env.DATABASE_URL!);
databaseUrl.searchParams.set("connection_limit", "1");
databaseUrl.searchParams.set("options", "-c default_transaction_read_only=off");
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
const once = process.argv.includes("--once");
const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

async function alive(pid?: number) {
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
    if (await alive(owner.pid)) throw new Error(`CONSTITUENT_SECURITY_RESOLVER_ALREADY_RUNNING:${owner.pid}`);
    await unlink(lockPath).catch(() => undefined);
    await acquire();
  }
}

async function candidates(): Promise<Candidate[]> {
  return prisma.$queryRawUnsafe<Candidate[]>(`
    WITH pending AS (
      SELECT c.id, c.isin, c.cusip, c.sedol, c.figi, c.ticker, c.exchange, q.id queue_id
      FROM index_constituents c
      JOIN index_constituent_mapping_queue q ON q.constituent_id=c.id
      WHERE c.security_id IS NULL
      ORDER BY c.created_at,c.id
      LIMIT 50
    ), direct_candidates AS (
      SELECT p.id, s.id security_id, l.stock_id, 'EXACT_CANONICAL_IDENTIFIER' match_method
      FROM pending p
      JOIN securities s ON (p.isin IS NOT NULL AND s.isin=p.isin)
        OR (p.cusip IS NOT NULL AND s.cusip=p.cusip)
        OR (p.sedol IS NOT NULL AND s.sedol=p.sedol)
      LEFT JOIN stock_security_links l ON l.security_id=s.id AND l.verification_status='VERIFIED_EXACT'
    ), ticker_candidates AS (
      SELECT p.id, l.security_id, l.stock_id, 'EXACT_MIC_TICKER_VIA_VERIFIED_STOCK_SECURITY_LINK' match_method
      FROM pending p
      JOIN stocks st ON upper(st.exchange)=CASE upper(p.exchange) WHEN 'HKEX' THEN 'HKG' ELSE upper(p.exchange) END
        AND regexp_replace(upper(split_part(st.ticker,'.',1)),'^0+','','g')=regexp_replace(upper(p.ticker),'^0+','','g')
      JOIN stock_security_links l ON l.stock_id=st.id AND l.verification_status='VERIFIED_EXACT'
    ), ranked AS (
      SELECT p.id,p.queue_id,p.isin,p.cusip,p.sedol,p.figi,p.ticker,p.exchange,
        coalesce((SELECT count(DISTINCT security_id) FROM direct_candidates d WHERE d.id=p.id),0) direct_count,
        coalesce((SELECT count(DISTINCT security_id) FROM ticker_candidates t WHERE t.id=p.id),0) ticker_count,
        (SELECT min(security_id) FROM direct_candidates d WHERE d.id=p.id) direct_security_id,
        (SELECT min(stock_id) FROM direct_candidates d WHERE d.id=p.id) direct_stock_id,
        (SELECT min(security_id) FROM ticker_candidates t WHERE t.id=p.id) ticker_security_id,
        (SELECT min(stock_id) FROM ticker_candidates t WHERE t.id=p.id) ticker_stock_id
      FROM pending p
    )
    SELECT id AS "constituentId",queue_id AS "queueId",
      CASE WHEN direct_count=1 THEN direct_security_id WHEN direct_count=0 AND ticker_count=1 THEN ticker_security_id END AS "securityId",
      CASE WHEN direct_count=1 THEN direct_stock_id WHEN direct_count=0 AND ticker_count=1 THEN ticker_stock_id END AS "stockId",
      CASE WHEN direct_count=1 THEN 'EXACT_CANONICAL_IDENTIFIER' WHEN direct_count=0 AND ticker_count=1 THEN 'EXACT_MIC_TICKER_VIA_VERIFIED_STOCK_SECURITY_LINK' END AS "matchMethod",
      CASE
        WHEN direct_count=1 AND direct_stock_id IS NOT NULL THEN 'MAPPED_STOCK'
        WHEN direct_count=1 THEN 'MAPPED_NON_STOCK_SECURITY'
        WHEN direct_count=0 AND ticker_count=1 THEN 'MAPPED_STOCK'
        WHEN direct_count>1 OR (direct_count=0 AND ticker_count>1) THEN 'AMBIGUOUS'
        WHEN exchange IS NULL AND ticker IS NOT NULL THEN 'EXCHANGE_MISSING'
        WHEN isin IS NULL AND cusip IS NULL AND sedol IS NULL AND figi IS NULL AND ticker IS NULL THEN 'IDENTIFIER_MISSING'
        WHEN ticker IS NOT NULL AND exchange IS NOT NULL THEN 'IDENTIFIER_NOT_FOUND'
        ELSE 'SOURCE_RAW_ONLY'
      END AS classification
    FROM ranked`);
}

async function repairMappedClassifications() {
  await prisma.$executeRawUnsafe(`
    UPDATE index_constituent_mapping_queue q
    SET status='MAPPED_STOCK',match_method='EXACT_MIC_TICKER_VIA_VERIFIED_STOCK_SECURITY_LINK',
      canonical_identifier=c.security_id,verification_source='CANONICAL_SECURITIES_VIA_VERIFIED_STOCK_SECURITY_LINK',
      verified_at=now(),mapping_version='3.0.0',reason=NULL,updated_at=now()
    FROM index_constituents c
    JOIN stock_security_links l ON l.security_id=c.security_id AND l.verification_status='VERIFIED_EXACT'
    JOIN stocks st ON st.id=l.stock_id
    WHERE q.constituent_id=c.id AND c.security_id IS NOT NULL
      AND upper(st.exchange)=CASE upper(c.exchange) WHEN 'HKEX' THEN 'HKG' ELSE upper(c.exchange) END
      AND regexp_replace(upper(split_part(st.ticker,'.',1)),'^0+','','g')=regexp_replace(upper(c.ticker),'^0+','','g')`);
}

async function runBatch() {
  const rows = await candidates();
  if (!rows.length) return 0;
  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      if (row.securityId) {
        await tx.$executeRawUnsafe(
          `UPDATE index_constituents SET security_id=$2,verification_status='VERIFIED_CANONICAL_SECURITY',updated_at=now() WHERE id=$1 AND security_id IS NULL`,
          row.constituentId, row.securityId,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE index_constituent_mapping_queue SET status=$2,match_method=$3,canonical_identifier=$4,
         verification_source=$5,verified_at=CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,
         mapping_version='3.0.0',reason=$6,updated_at=now() WHERE id=$1`,
        row.queueId, row.classification, row.matchMethod, row.securityId,
        row.securityId ? "CANONICAL_SECURITIES_VIA_VERIFIED_STOCK_SECURITY_LINK" : null,
        row.securityId ? null : row.classification,
      );
    }
  }, { timeout: 90_000 });
  return rows.length;
}

async function summary(state: string) {
  const [counts] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT count(*)::int total,count(c.security_id)::int mapped,
      count(*) FILTER(WHERE q.status='MAPPED_STOCK')::int stock_mapped,
      count(*) FILTER(WHERE q.status='MAPPED_NON_STOCK_SECURITY')::int non_stock_mapped,
      count(*) FILTER(WHERE q.status='IDENTIFIER_NOT_FOUND')::int identifier_not_found,
      count(*) FILTER(WHERE q.status='IDENTIFIER_MISSING')::int identifier_missing,
      count(*) FILTER(WHERE q.status='EXCHANGE_MISSING')::int exchange_missing,
      count(*) FILTER(WHERE q.status='AMBIGUOUS')::int ambiguous,
      count(*) FILTER(WHERE q.status='SOURCE_RAW_ONLY')::int source_raw_only,
      count(DISTINCT c.index_id) FILTER(WHERE c.security_id IS NOT NULL)::int mapped_indexes
    FROM index_constituents c JOIN index_constituent_mapping_queue q ON q.constituent_id=c.id`);
  await atomic(checkpointPath, { asset: "GLOBAL_INDEX", worker: "CONSTITUENT_SECURITY_RESOLVER", pid: process.pid,
    state, resumable: true, autoContinuing: !once, maxDbConcurrency: 1, counts, updatedAt: new Date().toISOString() });
  return counts;
}

async function main() {
  await acquire();
  try {
    for (;;) {
      await repairMappedClassifications();
      let processed = 0;
      for (;;) { const count = await runBatch(); if (!count) break; processed += count; await summary("RUNNING"); }
      const counts = await summary("SCHEDULED_WAIT");
      if (once) { console.log(JSON.stringify({ processed, counts })); break; }
      await sleep(6 * 60 * 60 * 1000);
    }
  } finally {
    await prisma.$disconnect();
    await unlink(lockPath).catch(() => undefined);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
