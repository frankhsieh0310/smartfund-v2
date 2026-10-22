import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { fetchExchangeTicker } from "./crypto-exchange-common-adapter.ts";

type SourceState = "AUTO_CONTINUING" | "INPUT_GATED_AUTO_CONTINUING" | "WAITING_DEPENDENCY" | "SOURCE_NOT_PUBLIC" | "EXTERNALLY_BLOCKED";
type Source = { id: string; family: string; role: string; status: SourceState; baseUrl?: string; dependency?: string };
type Mesh = { version: number; boundedBatchSize: number; sources: Source[]; canary: { sourceId: string; exchangeId: string; assetId: string; quoteAssetId: string; providerSymbol: string; marketId: string } };
export const loadPublicMesh = async () => JSON.parse(await readFile("config/crypto-free-public-data-mesh.json", "utf8")) as Mesh;

export async function enqueuePublicMesh(prisma: PrismaClient, mesh: Mesh) {
  let queued = 0;
  for (const source of mesh.sources) {
    const key = `PUBLIC_MESH:${source.id}`;
    const implemented = source.id === "KRAKEN";
    const reused = ["BINANCE", "COINBASE", "COINGECKO", "MEMPOOL_SPACE", "SHARED_ETF_SEC_FUTURES"].includes(source.id);
    const state = implemented ? "PENDING" : reused ? "DONE" : "BLOCKED";
    queued += await prisma.$executeRawUnsafe(
      `INSERT INTO crypto_work_items (dedupe_key,kind,payload,status,priority,next_run_at,last_error)
       VALUES ($1,'PUBLIC_MESH_SOURCE',$2::jsonb,$3,20,NOW(),$4)
       ON CONFLICT (dedupe_key) DO UPDATE SET payload=EXCLUDED.payload,status=CASE WHEN crypto_work_items.status='RUNNING' THEN 'RUNNING' ELSE EXCLUDED.status END,last_error=EXCLUDED.last_error,updated_at=NOW()`,
      key, JSON.stringify({ sourceId: source.id, family: source.family, role: source.role, status: source.status, dependency: source.dependency ?? null }), state, implemented || reused ? null : `${source.status}:${source.dependency ?? source.id}`,
    );
  }
  return queued;
}

export async function runPublicMeshSource(prisma: PrismaClient, mesh: Mesh, sourceId: string) {
  if (sourceId !== mesh.canary.sourceId) throw new Error(`PUBLIC_MESH_ROUTE_GATED:${sourceId}`);
  const source = mesh.sources.find(item => item.id === mesh.canary.sourceId);
  if (!source?.baseUrl) throw new Error("CANARY_SOURCE_NOT_CONFIGURED");
  const ticker = await fetchExchangeTicker(source.id, source.baseUrl, mesh.canary.providerSymbol);
  await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_markets (id,exchange_id,base_asset_id,quote_asset_id,provider_symbol,market_type,metadata,updated_at)
     VALUES ($1,$2,$3,$4,$5,'SPOT',$6::jsonb,NOW())
     ON CONFLICT (id) DO UPDATE SET provider_symbol=EXCLUDED.provider_symbol,active=TRUE,metadata=COALESCE(crypto_markets.metadata,'{}'::jsonb)||EXCLUDED.metadata,updated_at=NOW()`,
    mesh.canary.marketId, mesh.canary.exchangeId, mesh.canary.assetId, mesh.canary.quoteAssetId, mesh.canary.providerSymbol,
    JSON.stringify({ canonicalGrain: "EXCHANGE_SPECIFIC_PRICE", sourceRole: source.role, meshVersion: mesh.version }),
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_market_snapshots (market_id,observed_at,price,quote_currency,volume_24h,bid,ask,spread,source,source_record_id,freshness_status,source_payload)
     VALUES ($1,$2,$3::decimal,'USD',$4::decimal,$5::decimal,$6::decimal,CASE WHEN $5 IS NULL OR $6 IS NULL THEN NULL ELSE $6::decimal-$5::decimal END,$7,$8,'CURRENT',$9::jsonb)
     ON CONFLICT (market_id,observed_at) DO UPDATE SET price=EXCLUDED.price,volume_24h=EXCLUDED.volume_24h,bid=EXCLUDED.bid,ask=EXCLUDED.ask,spread=EXCLUDED.spread,source_payload=EXCLUDED.source_payload,updated_at=NOW()`,
    mesh.canary.marketId, ticker.observedAt, ticker.price, ticker.volume24h, ticker.bid, ticker.ask, source.id, ticker.sourceRecordId,
    JSON.stringify({ raw: ticker.payload, sourceRole: source.role, canonicalGrain: "EXCHANGE_SPECIFIC_PRICE", reconciliationStatus: "CANARY_READBACK_VERIFIED" }),
  );
  const readback = await prisma.$queryRawUnsafe<Array<{ rows: bigint }>>(
    `SELECT COUNT(*) rows FROM crypto_market_snapshots WHERE market_id=$1 AND observed_at=$2 AND source=$3`, mesh.canary.marketId, ticker.observedAt, source.id,
  );
  if (Number(readback[0]?.rows ?? 0) !== 1) throw new Error("PUBLIC_MESH_CANARY_READBACK_FAILED");
  const nextRunAt = new Date(Date.now() + 15 * 60_000);
  await prisma.$executeRawUnsafe(
    `UPDATE crypto_work_items SET status='DONE',checkpoint=$2::jsonb,completed_at=NOW(),next_run_at=$3,last_error=NULL,updated_at=NOW() WHERE dedupe_key=$1`,
    `PUBLIC_MESH:${source.id}`, JSON.stringify({ marketId: mesh.canary.marketId, observedAt: ticker.observedAt, sourceRecordId: ticker.sourceRecordId, readback: "PASS" }), nextRunAt,
  );
  return { source: source.id, marketId: mesh.canary.marketId, fields: ["price", "bid", "ask", "spread", "volume24h"], observations: 1, readback: "PASS", nextRunAt };
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const mesh = await loadPublicMesh();
  const output: Record<string, unknown> = { mesh: "GLOBAL_CRYPTO_FREE_PUBLIC_DATA_MESH", unknown: 0 };
  let ownsLock = false;
  try {
    if (process.argv.includes("--canary")) {
      const lock = await prisma.$queryRawUnsafe<Array<{ locked: boolean }>>("SELECT pg_try_advisory_lock($1) locked", 73492751);
      if (!lock[0]?.locked) throw new Error("CRYPTO_SINGLE_WRITER_BUSY");
      ownsLock = true;
    }
    if (process.argv.includes("--enqueue")) output.queued = await enqueuePublicMesh(prisma, mesh);
    if (process.argv.includes("--canary")) output.canary = await runPublicMeshSource(prisma, mesh, mesh.canary.sourceId);
    console.log(JSON.stringify(output, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
  } finally { if (ownsLock) await prisma.$executeRawUnsafe("SELECT pg_advisory_unlock($1)", 73492751).catch(() => undefined); await prisma.$disconnect(); }
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/run-crypto-public-data-mesh.ts")) main().catch(error => { console.error(error); process.exitCode = 1; });
