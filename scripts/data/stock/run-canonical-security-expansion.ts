import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type State = "RUNNING" | "COMPLETE" | "BLOCKED";
type Checkpoint = {
  state: State;
  cursor: string | null;
  processed: number;
  securitiesCreated: number;
  linksCreated: number;
  insufficientIdentity: number;
  ambiguous: number;
  batches: number;
  lastError: string | null;
  processId: number;
  updatedAt: string;
};
type Row = {
  stock_id: string;
  ticker: string;
  yahoo_symbol: string;
  exchange: string;
  country: string;
  currency: string;
  company_name: string;
  company_name_zh: string | null;
  sector: string | null;
  industry: string | null;
  candidate_count: number;
  security_id: string | null;
};
type SecurityInput = {
  id: string; ticker: string; name: string; nameEn: string | null; exchange: string;
  country: string; sector: string | null; industry: string | null; currency: string;
};
type LinkInput = { id: string; stockId: string; securityId: string };

const batchSize = 1000;
const root = path.resolve("runtime/stock-canonical-security-expansion");
const checkpointPath = path.join(root, "checkpoint.json");
const databaseUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL_MISSING");
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

function deterministicUuid(value: string) {
  const bytes = Buffer.from(createHash("sha256").update(value).digest("hex").slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function valid(value: string | null | undefined) { return Boolean(value?.trim()); }
async function loadCheckpoint() {
  try { return JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
async function save(checkpoint: Checkpoint) {
  checkpoint.processId = process.pid; checkpoint.updatedAt = new Date().toISOString();
  await mkdir(root, { recursive: true });
  const temporary = `${checkpointPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  await rename(temporary, checkpointPath);
}

async function report(checkpoint: Checkpoint) {
  const [totals, markets, methods, samples, duplicatePairs] = await Promise.all([
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
      SELECT (SELECT count(*)::int FROM stocks) AS stocks,
             (SELECT count(*)::int FROM securities) AS securities,
             (SELECT count(*)::int FROM stock_security_links) AS links,
             count(DISTINCT l.stock_id)::int AS mapped,
             ((SELECT count(*) FROM stocks)-count(DISTINCT l.stock_id))::int AS unmapped
      FROM stock_security_links l
    `),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
      SELECT s.country, count(*)::int AS stocks,
             count(*) FILTER (WHERE l.stock_id IS NOT NULL)::int AS mapped,
             count(*) FILTER (WHERE l.stock_id IS NULL)::int AS unmapped
      FROM stocks s LEFT JOIN stock_security_links l ON l.stock_id=s.id
      GROUP BY s.country ORDER BY s.country
    `),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
      SELECT mapping_source, count(*)::int AS links
      FROM stock_security_links GROUP BY mapping_source ORDER BY mapping_source
    `),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
      SELECT s.ticker,s.exchange,s.country,l.security_id,x.ticker AS security_ticker,x.exchange AS security_exchange
      FROM stocks s LEFT JOIN stock_security_links l ON l.stock_id=s.id
      LEFT JOIN securities x ON x.id=l.security_id
      WHERE s.ticker IN ('2330','2303','2454','AAPL','MSFT','NVDA') ORDER BY s.ticker,s.exchange
    `),
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
      SELECT count(*)::int AS duplicate_pairs FROM (
        SELECT ticker,exchange FROM securities GROUP BY ticker,exchange HAVING count(*)>1
      ) d
    `),
  ]);
  console.log(JSON.stringify({ checkpoint, totals: totals[0], markets, methods, samples, duplicatePairs: duplicatePairs[0] }, null, 2));
}

async function main() {
  const checkpoint = await loadCheckpoint() ?? {
    state: "RUNNING", cursor: null, processed: 0, securitiesCreated: 0, linksCreated: 0,
    insufficientIdentity: 0, ambiguous: 0, batches: 0, lastError: null,
    processId: process.pid, updatedAt: new Date().toISOString(),
  } satisfies Checkpoint;
  if (checkpoint.state === "COMPLETE") return report(checkpoint);
  checkpoint.state = "RUNNING"; checkpoint.lastError = null; await save(checkpoint);

  while (true) {
    const rows = await prisma.$queryRawUnsafe<Row[]>(`
      WITH batch AS (
        SELECT id FROM stocks WHERE ($1::text IS NULL OR id > $1) ORDER BY id LIMIT $2
      )
      SELECT st.id AS stock_id, st.ticker, st.yahoo_symbol, st.exchange, st.country,
             st.currency, st.company_name, st.company_name_zh, st.sector, st.industry,
             count(sec.id)::int AS candidate_count, min(sec.id) AS security_id
      FROM batch b JOIN stocks st ON st.id=b.id
      LEFT JOIN securities sec ON sec.ticker=st.ticker AND sec.exchange=st.exchange
      GROUP BY st.id ORDER BY st.id
    `, checkpoint.cursor, batchSize);
    if (!rows.length) break;

    const eligible = rows.filter(row => [row.stock_id, row.ticker, row.yahoo_symbol, row.exchange, row.country, row.currency, row.company_name].every(valid));
    const missing = eligible.filter(row => row.candidate_count === 0);
    const unambiguous = eligible.filter(row => row.candidate_count <= 1);
    const securities: SecurityInput[] = missing.map(row => ({
      id: deterministicUuid(`SMARTFUND:STOCK_LISTING:${row.stock_id}`), ticker: row.ticker,
      name: row.company_name_zh || row.company_name, nameEn: row.company_name,
      exchange: row.exchange, country: row.country, sector: row.sector, industry: row.industry,
      currency: row.currency,
    }));
    const createdIds = new Map(missing.map((row, index) => [row.stock_id, securities[index].id]));
    const links: LinkInput[] = unambiguous.map(row => ({
      id: randomUUID(), stockId: row.stock_id,
      securityId: row.security_id ?? createdIds.get(row.stock_id)!,
    }));

    const result = await prisma.$transaction(async tx => {
      const securitiesCreated = securities.length ? await tx.$executeRawUnsafe(`
        INSERT INTO securities (id,ticker,name,name_en,exchange,country,sector,industry,currency,created_at,updated_at)
        SELECT x.id,x.ticker,x.name,x."nameEn",x.exchange,x.country,x.sector,x.industry,x.currency,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
        FROM jsonb_to_recordset($1::jsonb) AS x(id text,ticker text,name text,"nameEn" text,exchange text,country text,sector text,industry text,currency text)
        ON CONFLICT (id) DO NOTHING
      `, JSON.stringify(securities)) : 0;
      const linksCreated = links.length ? await tx.$executeRawUnsafe(`
        INSERT INTO stock_security_links (id,stock_id,security_id,mapping_source,verification_status,verified_at,created_at,updated_at)
        SELECT x.id::uuid,x."stockId",x."securityId",'VERIFIED_PROVIDER_SYMBOL_EXACT_EXCHANGE_TICKER','VERIFIED_EXACT',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
        FROM jsonb_to_recordset($1::jsonb) AS x(id text,"stockId" text,"securityId" text)
        ON CONFLICT (stock_id,security_id) DO NOTHING
      `, JSON.stringify(links)) : 0;
      return { securitiesCreated, linksCreated };
    });

    checkpoint.processed += rows.length;
    checkpoint.securitiesCreated += result.securitiesCreated;
    checkpoint.linksCreated += result.linksCreated;
    checkpoint.insufficientIdentity += rows.length - eligible.length;
    checkpoint.ambiguous += eligible.filter(row => row.candidate_count > 1).length;
    checkpoint.cursor = rows.at(-1)!.stock_id; checkpoint.batches += 1; await save(checkpoint);
  }
  checkpoint.state = "COMPLETE"; await save(checkpoint); await report(checkpoint);
}

main().catch(async error => {
  const checkpoint = await loadCheckpoint();
  if (checkpoint) { checkpoint.state = "BLOCKED"; checkpoint.lastError = error instanceof Error ? error.message : String(error); await save(checkpoint); }
  console.error(error instanceof Error ? error.stack : error); process.exitCode = 1;
}).finally(() => prisma.$disconnect());
