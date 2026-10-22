import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type Checkpoint = {
  status: "RUNNING" | "COMPLETE" | "BLOCKED";
  cursor: string | null;
  processed: number;
  verified: number;
  unmapped: number;
  ambiguous: number;
  batches: number;
  lastError: string | null;
  processId: number;
  updatedAt: string;
};
type Candidate = { stock_id: string; candidate_count: number; security_id: string | null };

const root = path.resolve("runtime/stock-security-identity");
const checkpointPath = path.join(root, "checkpoint.json");
const batchSize = 1000;
const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_MISSING");
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

async function readCheckpoint() {
  try { return JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function save(checkpoint: Checkpoint) {
  checkpoint.updatedAt = new Date().toISOString(); checkpoint.processId = process.pid;
  await mkdir(root, { recursive: true }); const temporary = `${checkpointPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8"); await rename(temporary, checkpointPath);
}

async function main() {
  const checkpoint = await readCheckpoint() ?? { status: "RUNNING", cursor: null, processed: 0, verified: 0, unmapped: 0, ambiguous: 0, batches: 0, lastError: null, processId: process.pid, updatedAt: new Date().toISOString() } satisfies Checkpoint;
  if (checkpoint.status === "COMPLETE") return console.log(JSON.stringify(checkpoint));
  checkpoint.status = "RUNNING"; checkpoint.lastError = null; await save(checkpoint);
  while (true) {
    const rows = await prisma.$queryRawUnsafe<Candidate[]>(`
      WITH batch AS (
        SELECT id FROM stocks WHERE ($1::text IS NULL OR id > $1) ORDER BY id LIMIT $2
      )
      SELECT st.id AS stock_id, count(sec.id)::int AS candidate_count, min(sec.id) AS security_id
      FROM batch b JOIN stocks st ON st.id=b.id
      LEFT JOIN securities sec ON sec.ticker=st.ticker AND sec.exchange=st.exchange
      GROUP BY st.id ORDER BY st.id
    `, checkpoint.cursor, batchSize);
    if (!rows.length) break;
    const exact = rows.filter((row) => row.candidate_count === 1 && row.security_id);
    await prisma.$transaction(async (tx) => {
      for (const row of exact) await tx.$executeRawUnsafe(`
        INSERT INTO stock_security_links
          (id,stock_id,security_id,mapping_source,verification_status,verified_at,created_at,updated_at)
        VALUES ($1::uuid,$2,$3,'EXACT_EXCHANGE_TICKER','VERIFIED_EXACT',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        ON CONFLICT (stock_id,security_id) DO NOTHING
      `, randomUUID(), row.stock_id, row.security_id);
    });
    checkpoint.processed += rows.length; checkpoint.verified += exact.length;
    checkpoint.unmapped += rows.filter((row) => row.candidate_count === 0).length;
    checkpoint.ambiguous += rows.filter((row) => row.candidate_count > 1).length;
    checkpoint.cursor = rows.at(-1)!.stock_id; checkpoint.batches += 1; await save(checkpoint);
  }
  checkpoint.status = "COMPLETE"; await save(checkpoint); console.log(JSON.stringify(checkpoint, null, 2));
}

main().catch(async (error) => {
  const checkpoint = await readCheckpoint(); if (checkpoint) { checkpoint.status = "BLOCKED"; checkpoint.lastError = error instanceof Error ? error.message : String(error); await save(checkpoint); }
  console.error(error instanceof Error ? error.stack : error); process.exitCode = 1;
}).finally(() => prisma.$disconnect());
