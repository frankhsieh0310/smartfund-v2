import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

type LayerStatus = "AUTO_CONTINUING" | "INPUT_GATED_AUTO_CONTINUING" | "WAITING_DEPENDENCY" | "SOURCE_NOT_PUBLIC" | "EXTERNALLY_BLOCKED";
type Layer = { id: string; layer: string; status: LayerStatus; claimable: boolean; sourceRole: string; adapter: string; baseUrl?: string; dependency?: string; semantics: string; checkpoint?: string };
type Config = { version: number; logicalPriority: number; databasePriority: number; maxDbConcurrency: number; idleOnly: boolean; layers: Layer[]; sharedOwners: Record<string, string> };
export const loadPublicDepthExpansion = async () => JSON.parse(await readFile("config/crypto-public-depth-expansion.json", "utf8")) as Config;

const expansionPrefix = "CRYPTO_PUBLIC_EXPANSION:";
export async function existingCryptoIdle(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ busy: bigint }>>(
    `SELECT COUNT(*) busy FROM crypto_work_items
     WHERE dedupe_key NOT LIKE $1 AND (
       status IN ('RUNNING','RETRY') OR
       (status='PENDING' AND next_run_at<=NOW()) OR
       (status='DONE' AND kind IN ('CANDLES','DEEP_HISTORY','SNAPSHOT','FUNDING_RATE','OPEN_INTEREST','ONCHAIN_NETWORK') AND next_run_at<=NOW())
     )`, `${expansionPrefix}%`,
  );
  return Number(rows[0]?.busy ?? 1) === 0;
}

export async function registerPublicDepthExpansion(prisma: PrismaClient, config: Config) {
  let registered = 0;
  for (const layer of config.layers) registered += await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_work_items (dedupe_key,kind,payload,status,priority,next_run_at,last_error,checkpoint)
     VALUES ($1,'CRYPTO_PUBLIC_EXPANSION',$2::jsonb,'BLOCKED',$3,NOW(),$4,$5::jsonb)
     ON CONFLICT (dedupe_key) DO UPDATE SET payload=EXCLUDED.payload,priority=EXCLUDED.priority,
       status=CASE WHEN crypto_work_items.status='RUNNING' THEN 'RUNNING' ELSE 'BLOCKED' END,
       last_error=EXCLUDED.last_error,checkpoint=COALESCE(crypto_work_items.checkpoint,EXCLUDED.checkpoint),updated_at=NOW()`,
    `${expansionPrefix}${layer.id}`, JSON.stringify({ layerId: layer.id, logicalPriority: config.logicalPriority, adapter: layer.adapter, sourceRole: layer.sourceRole, idleOnly: true }),
    config.databasePriority, layer.claimable ? "WAIT_EXISTING_CRYPTO_IDLE" : `${layer.status}:${layer.dependency ?? layer.semantics}`,
    JSON.stringify({ isolated: true, layer: layer.layer, state: layer.claimable ? "WAIT_IDLE" : layer.status, cursor: null, semantics: layer.semantics }),
  );
  return registered;
}

export async function refreshPublicDepthExpansionGate(prisma: PrismaClient, config: Config) {
  const idle = await existingCryptoIdle(prisma).catch(() => false);
  if (!idle) return { idle: false, released: 0, state: "WAIT_BACKOFF" };
  const claimable = config.layers.filter(layer => layer.claimable).map(layer => `${expansionPrefix}${layer.id}`);
  if (!claimable.length) return { idle: true, released: 0, state: "NO_CLAIMABLE_LAYER" };
  const released = await prisma.$executeRawUnsafe(
    `UPDATE crypto_work_items SET status='PENDING',last_error=NULL,next_run_at=NOW(),updated_at=NOW()
     WHERE dedupe_key=(SELECT dedupe_key FROM crypto_work_items WHERE dedupe_key=ANY($1::text[]) AND status='BLOCKED' ORDER BY priority,dedupe_key LIMIT 1)`, claimable,
  );
  return { idle: true, released, state: released ? "ONE_PRIORITY_9_ITEM_RELEASED" : "NO_RELEASE" };
}

export async function runPublicDepthExpansion(prisma: PrismaClient, config: Config, layerId: string) {
  if (!await existingCryptoIdle(prisma)) return { rows: 0, continuation: true, state: "WAIT_EXISTING_CRYPTO_IDLE" };
  const layer = config.layers.find(item => item.id === layerId);
  if (!layer) throw new Error(`UNKNOWN_PUBLIC_EXPANSION_LAYER:${layerId}`);
  if (!layer.claimable) throw new Error(`${layer.status}:${layer.dependency ?? layer.semantics}`);
  if (layer.id !== "DEFILLAMA") throw new Error(`ADAPTER_NOT_ROUTED:${layer.id}`);
  const response = await fetch(`${layer.baseUrl}/v2/chains`, { headers: { accept: "application/json", "user-agent": "SmartFund/2 crypto-public-depth" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}:DEFILLAMA_CHAINS`);
  const chains = await response.json() as Array<{ name?: string; tokenSymbol?: string; tvl?: number }>;
  const first = chains.find(row => row.name && Number.isFinite(row.tvl));
  if (!first) throw new Error("DEFILLAMA_CHAIN_TVL_EMPTY");
  const observedAt = new Date();
  await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_metrics (asset_id,market_id,metric,observed_at,value,unit,payload,source,source_url)
     VALUES ('','',$1,$2,$3::decimal,'USD',$4::jsonb,'DEFILLAMA_PUBLIC_API',$5)
     ON CONFLICT (asset_id,market_id,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,payload=EXCLUDED.payload,ingested_at=NOW()`,
    `DEFI_CHAIN_TVL:${first.name}`, observedAt, String(first.tvl), JSON.stringify({ chain: first.name, tokenSymbol: first.tokenSymbol ?? null, sourceRole: layer.sourceRole, sourcePriority: "PUBLIC_AGGREGATOR", canonicalMetric: "CHAIN_DEFI_TVL", providerMetric: "tvl", reconciliationStatus: "NOT_RECONCILED_WITH_CHAIN_NATIVE", methodologyVersion: 1 }), `${layer.baseUrl}/v2/chains`,
  );
  const readback = await prisma.$queryRawUnsafe<Array<{ rows: bigint }>>(
    `SELECT COUNT(*) rows FROM crypto_metrics WHERE asset_id='' AND market_id='' AND metric=$1 AND observed_at=$2 AND source='DEFILLAMA_PUBLIC_API'`, `DEFI_CHAIN_TVL:${first.name}`, observedAt,
  );
  if (Number(readback[0]?.rows ?? 0) !== 1) throw new Error("DEFILLAMA_READBACK_FAILED");
  return { rows: 1, continuation: true, state: "AUTO_CONTINUING", checkpoint: { dataset: "CHAIN_TVL_CURRENT", chain: first.name, observedAt, readback: "PASS" } };
}

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const config = await loadPublicDepthExpansion();
    const output: Record<string, unknown> = { expansion: "GLOBAL_CRYPTO_PUBLIC_DEPTH", priority: config.logicalPriority };
    if (process.argv.includes("--register")) output.registered = await registerPublicDepthExpansion(prisma, config);
    if (process.argv.includes("--gate")) output.gate = await refreshPublicDepthExpansionGate(prisma, config);
    console.log(JSON.stringify(output, null, 2));
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("/run-crypto-public-depth-expansion.ts")) main().catch(error => { console.error(error); process.exitCode = 1; });
