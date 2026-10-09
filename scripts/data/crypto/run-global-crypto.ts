import { readFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { writeAssetRuntimeStatus } from "../../../lib/data-platform/runtime/writeAssetRuntimeStatus.ts";
import { enqueuePublicMesh, loadPublicMesh, runPublicMeshSource } from "./run-crypto-public-data-mesh.ts";
import { loadPublicDepthExpansion, refreshPublicDepthExpansionGate, registerPublicDepthExpansion, runPublicDepthExpansion } from "./run-crypto-public-depth-expansion.ts";
import { runDerivativeVenueMarketData } from "./run-crypto-derivative-venue-market-data.ts";
import { runTraderIntelligence } from "./run-crypto-derivative-trader-intelligence.ts";

type Config = {
  writer: { maxBatchRows: number; maxWorkItemsPerRun: number; retryBaseSeconds: number; singleWriterLock: number };
  requiredIntervals: string[]; capabilities: string[];
  networks: Array<[string, string, string, string | null, string, string, string]>;
  assets: Array<[string, string, string, string, number, boolean?, string?]>;
  exchanges: Array<[string, string, string, string, boolean, boolean]>;
  productionMarkets: Array<[string, string, string, string, string, string]>;
  marketDataIds: Record<string, string>;
  onchain: { boundedBatchSize: number; canary: { networkId: string; assetId: string; source: string; apiUrl: string }; ethereum: { assetId: string; source: string; executionRpcEnv: string; consensusApiEnv: string; initialBackfillBlocks: number; finalityTag: string }; supportedNetworks: string[]; blockedSourceNetworks: string[] };
};

type Work = { id: string; dedupe_key: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number };
// Session advisory locks are unsafe through a transaction pooler: the pooled
// backend can retain the lock after Prisma disconnects. Crypto's single writer
// therefore uses the existing direct connection when it is configured.
// Production's session-mode direct pool is deliberately small. The standalone
// runner is already process-singleton, so prefer the approved transaction pool
// and reserve DIRECT_URL for an explicit operator override.
const prisma = new PrismaClient({ datasources: { db: { url: process.env.CRYPTO_USE_DIRECT_URL === "1" ? process.env.DIRECT_URL : process.env.DATABASE_URL } } });
const usesSessionConnection = process.env.CRYPTO_USE_DIRECT_URL === "1";
async function acquireWriterLock(lockId: number): Promise<boolean> {
  if (!usesSessionConnection) return true;
  const lock = await prisma.$queryRawUnsafe<Array<{ locked: boolean }>>("SELECT pg_try_advisory_lock($1) locked", lockId);
  return Boolean(lock[0]?.locked);
}
async function releaseWriterLock(lockId: number): Promise<void> {
  if (usesSessionConnection) await prisma.$executeRawUnsafe("SELECT pg_advisory_unlock($1)", lockId);
}
const source = "BINANCE_PUBLIC_API";

const taskName = (kind: string) => kind === "CANDLES" || kind === "DEEP_HISTORY" ? "Historical OHLCV" : kind === "SNAPSHOT" ? "Spot Price" : kind === "CAP_SUPPLY" ? "Market Cap / Supply" : kind === "FUNDING_RATE" ? "Funding" : kind === "OPEN_INTEREST" ? "Open Interest" : kind === "DERIVATIVE_IDENTITY" ? "Derivative Identity" : kind === "ONCHAIN_NETWORK" ? "On-chain" : kind === "ANALYTICS" ? "Technical / Quant" : "Maintenance";
const layerName = (kind: string) => kind === "CANDLES" || kind === "DEEP_HISTORY" ? "Price History" : kind === "FUNDING_RATE" || kind === "OPEN_INTEREST" || kind === "DERIVATIVE_IDENTITY" ? "Derivatives" : kind === "ONCHAIN_NETWORK" ? "On-chain / Network Activity" : kind === "CAP_SUPPLY" ? "Market Cap / Supply" : kind === "ANALYTICS" ? "Analytics" : "Current Market Data";
async function publishWorkStatus(c: Config, item: Work, runState: "RUNNING" | "BLOCKED", processed: number, total: number, progress?: string, blocker?: string) {
  const marketId = typeof item.payload.marketId === "string" ? item.payload.marketId : null;
  const market = marketId ? c.productionMarkets.find(candidate => candidate[0] === marketId) : undefined;
  const assetId = String(item.payload.assetId ?? market?.[2] ?? "") || null;
  const asset = assetId ? c.assets.find(candidate => candidate[0] === assetId) : undefined;
  const exchangeId = String(item.payload.exchangeId ?? market?.[1] ?? "") || null;
  const currentSource = item.kind === "CAP_SUPPLY" ? "COINGECKO_PUBLIC_API" : exchangeId === "coinbase" ? "COINBASE_EXCHANGE_PUBLIC_API" : item.kind === "ANALYTICS" ? "DERIVED_FROM_CANONICAL_CRYPTO_HISTORY" : source;
  await writeAssetRuntimeStatus({
    ASSET: "CRYPTO", CURRENT_PHASE: "CONTINUOUS_COMPLETION", CURRENT_LAYER: layerName(item.kind), CURRENT_TASK: taskName(item.kind), CURRENT_MARKET: marketId,
    CURRENT_ASSET: assetId, CURRENT_PAIR: market?.[4] ?? null, CURRENT_EXCHANGE: exchangeId, CURRENT_CHAIN: asset?.[3] ?? null, CURRENT_SOURCE: currentSource,
    PROCESSED: processed, TOTAL: total, COVERAGE: total ? `${((processed / total) * 100).toFixed(1)}%` : null, RUN_STATE: runState, PROCESS_ID: process.pid,
    CHECKPOINT: item.dedupe_key, BLOCKER: blocker ?? null, NEXT: runState === "BLOCKED" ? "Resume this checkpoint after existing retry policy" : "Complete current bounded work item, checkpoint, then continue queue",
    NEXT_RUN_AT: null, PRICE_STATUS: "PRODUCTION", DERIVATIVES_STATUS: "BUILDING", ONCHAIN_STATUS: item.kind === "ONCHAIN_NETWORK" ? "BUILDING" : "AUTO_CONTINUING", QUOTE_STATUS: "NOT_READY", CONTINUING: "YES",
    LAST_PROGRESS: progress, progressChanged: Boolean(progress),
  });
}

async function config(): Promise<Config> {
  return JSON.parse(await readFile("config/crypto-platform.json", "utf8")) as Config;
}

async function publishSchedulerStatus(runState: "RUNNING" | "SCHEDULED_WAIT", nextRunAt: string | null = null, blocker: string | null = null) {
  const supervisorPid = Number((await readFile("runtime/crypto/standalone.pid", "utf8").catch(() => "0")).trim()) || process.pid;
  await writeAssetRuntimeStatus({ ASSET: "CRYPTO", CURRENT_PHASE: "CONTINUOUS_COMPLETION", CURRENT_LAYER: runState === "RUNNING" ? "Scheduler" : "Scheduler Wait", CURRENT_TASK: "Scheduler",
    CURRENT_MARKET: null, CURRENT_ASSET: null, CURRENT_PAIR: null, CURRENT_EXCHANGE: null, CURRENT_CHAIN: null, CURRENT_SOURCE: "EXISTING_CRYPTO_PIPELINE",
    PROCESSED: 0, TOTAL: null, COVERAGE: null, RUN_STATE: runState, PROCESS_ID: supervisorPid, CHECKPOINT: "CRYPTO_WORK_QUEUE", BLOCKER: blocker,
    NEXT: "Resume existing checkpointed Crypto completion queue", NEXT_RUN_AT: nextRunAt, PRICE_STATUS: "PRODUCTION", DERIVATIVES_STATUS: "BUILDING", ONCHAIN_STATUS: "AUTO_CONTINUING",
    QUOTE_STATUS: "NOT_READY", CONTINUING: "YES", progressChanged: false });
}

async function bootstrap(c: Config): Promise<void> {
  for (const [id, name, nativeAssetId, chainId, genesis, officialUrl, explorerUrl] of c.networks) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO crypto_networks (id,name,native_asset_id,chain_id,genesis_at,official_url,explorer_url,source_url,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$6,NOW()) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, native_asset_id=EXCLUDED.native_asset_id,
       chain_id=EXCLUDED.chain_id, official_url=EXCLUDED.official_url, explorer_url=EXCLUDED.explorer_url, source_url=EXCLUDED.source_url, updated_at=NOW()`,
      id, name, nativeAssetId, chainId, new Date(`${genesis}T00:00:00Z`), officialUrl, explorerUrl,
    );
  }
  for (const [id, name, symbol, networkId, decimals, stablecoin = false, contractAddress = null] of c.assets) {
    const network = c.networks.find((item) => item[0] === networkId);
    if (!network) throw new Error(`UNKNOWN_NETWORK:${networkId}`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO crypto_assets (id,name,symbol,network_id,contract_address,decimals,genesis_at,stablecoin,official_url,source_url,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,NOW()) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,symbol=EXCLUDED.symbol,
       network_id=EXCLUDED.network_id,contract_address=EXCLUDED.contract_address,decimals=EXCLUDED.decimals,stablecoin=EXCLUDED.stablecoin,updated_at=NOW()`,
      id, name, symbol, networkId, contractAddress, decimals, new Date(`${network[4]}T00:00:00Z`), stablecoin, network[5],
    );
    const taxonomy = stablecoin ? "STABLECOIN" : contractAddress ? "TOKEN" : "NATIVE_COIN";
    const primaryMarket = c.productionMarkets.find((market) => market[2] === id && market[1] === "binance") ?? c.productionMarkets.find((market) => market[2] === id);
    await prisma.$executeRawUnsafe(
      `UPDATE crypto_assets SET provider_external_id=$2,asset_type='CRYPTO',taxonomy=$3,primary_quote_asset_id=$4,
       primary_market_id=$5,token_standard=$6,identity_source='OFFICIAL_REGISTRY+COINGECKO_ID_MAP',
       metadata=COALESCE(metadata,'{}'::jsonb)||$7::jsonb,updated_at=NOW() WHERE id=$1`,
      id, c.marketDataIds[id] ?? null, taxonomy, primaryMarket?.[3] ?? null, primaryMarket?.[0] ?? null,
      contractAddress && networkId === "ethereum" ? "ERC-20" : null, JSON.stringify({verificationStatus:"VERIFIED",pegCurrency:stablecoin?"USD":null}),
    );
  }
  for (const [id, name, officialUrl, apiUrl, spot, derivatives] of c.exchanges) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO crypto_exchanges (id,name,official_url,api_url,spot,derivatives,source_url,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$3,NOW())
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,official_url=EXCLUDED.official_url,api_url=EXCLUDED.api_url,spot=EXCLUDED.spot,derivatives=EXCLUDED.derivatives,updated_at=NOW()`,
      id, name, officialUrl, apiUrl, spot, derivatives,
    );
  }
  for (const [id, exchangeId, baseAssetId, quoteAssetId, providerSymbol, marketType] of c.productionMarkets) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO crypto_markets (id,exchange_id,base_asset_id,quote_asset_id,provider_symbol,market_type,updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (id) DO UPDATE SET provider_symbol=EXCLUDED.provider_symbol,active=TRUE,updated_at=NOW()`,
      id, exchangeId, baseAssetId, quoteAssetId, providerSymbol, marketType,
    );
  }
}

async function enqueue(c: Config): Promise<number> {
  let count = 0;
  for (const [marketId, exchangeId, , , symbol] of c.productionMarkets) {
    const intervals = exchangeId === "coinbase" ? ["1h", "1d"] : c.requiredIntervals;
    for (const interval of intervals) {
      const providerInterval = interval === "1h" ? "1h" : interval === "1d" ? "1d" : interval;
      const key = `CANDLES:${marketId}:${interval}`;
      count += await prisma.$executeRawUnsafe(
        `INSERT INTO crypto_work_items (dedupe_key,kind,payload,priority) VALUES ($1,'CANDLES',$2::jsonb,$3)
         ON CONFLICT (dedupe_key) DO UPDATE SET status=CASE WHEN crypto_work_items.status='DEAD' THEN 'DEAD' ELSE 'PENDING' END,
         next_run_at=LEAST(crypto_work_items.next_run_at,NOW()),updated_at=NOW()`,
        key, JSON.stringify({ marketId, symbol, interval, providerInterval, exchangeId }), interval === "1d" ? 0 : interval === "1h" ? 1 : interval === "4h" ? 2 : interval === "15m" ? 3 : 20,
      );
      if (exchangeId === "binance" && (interval === "1d" || interval === "1h")) {
        const deepKey = `DEEP_HISTORY:${marketId}:${interval}`;
        count += await prisma.$executeRawUnsafe(
          `INSERT INTO crypto_work_items (dedupe_key,kind,payload,priority) VALUES ($1,'DEEP_HISTORY',$2::jsonb,7)
           ON CONFLICT (dedupe_key) DO UPDATE SET status=CASE WHEN crypto_work_items.status IN ('RUNNING','DONE') THEN crypto_work_items.status ELSE 'PENDING' END,
           next_run_at=CASE WHEN crypto_work_items.status='DONE' THEN crypto_work_items.next_run_at ELSE NOW() END,updated_at=NOW()`,
          deepKey, JSON.stringify({ marketId, symbol, interval, providerInterval, exchangeId }),
        );
      }
    }
    const kinds = exchangeId === "binance" ? ["SNAPSHOT", "FUNDING_RATE", "OPEN_INTEREST"] : ["SNAPSHOT"];
    for (const kind of kinds) {
      const key = `${kind}:${marketId}`;
      count += await prisma.$executeRawUnsafe(
        `INSERT INTO crypto_work_items (dedupe_key,kind,payload,priority) VALUES ($1,$2,$3::jsonb,5)
         ON CONFLICT (dedupe_key) DO UPDATE SET status=CASE WHEN crypto_work_items.status='RUNNING' THEN 'RUNNING' ELSE 'PENDING' END,next_run_at=NOW(),updated_at=NOW()`,
        key, kind, JSON.stringify({ marketId, symbol }),
      );
    }
  }
  count += await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_work_items (dedupe_key,kind,payload,priority) VALUES ('CAP_SUPPLY:ALL','CAP_SUPPLY','{}'::jsonb,4)
     ON CONFLICT (dedupe_key) DO UPDATE SET status=CASE WHEN crypto_work_items.status='RUNNING' THEN 'RUNNING' ELSE 'PENDING' END,next_run_at=NOW(),updated_at=NOW()`,
  );
  for(const venue of ["okx","bybit"]) count+=await prisma.$executeRawUnsafe(`INSERT INTO crypto_work_items(dedupe_key,kind,payload,status,priority,next_run_at) VALUES($1,'DERIVATIVE_VENUE_MARKET_DATA',$2::jsonb,'PENDING',2,NOW()) ON CONFLICT(dedupe_key) DO UPDATE SET status=CASE WHEN crypto_work_items.status='RUNNING' THEN 'RUNNING' WHEN crypto_work_items.next_run_at<=NOW() THEN 'PENDING' ELSE crypto_work_items.status END,next_run_at=CASE WHEN crypto_work_items.next_run_at<=NOW() THEN NOW() ELSE crypto_work_items.next_run_at END,updated_at=NOW()`,`DERIVATIVE_VENUE_MARKET_DATA:${venue}`,JSON.stringify({venue}));
  count+=await prisma.$executeRawUnsafe(`INSERT INTO crypto_work_items(dedupe_key,kind,payload,status,priority,next_run_at) VALUES('DERIVATIVE_TRADER_INTELLIGENCE:CORE','DERIVATIVE_TRADER_INTELLIGENCE','{}','PENDING',3,NOW()) ON CONFLICT(dedupe_key) DO UPDATE SET status=CASE WHEN crypto_work_items.status='RUNNING' THEN 'RUNNING' WHEN crypto_work_items.next_run_at<=NOW() THEN 'PENDING' ELSE crypto_work_items.status END,next_run_at=CASE WHEN crypto_work_items.next_run_at<=NOW() THEN NOW() ELSE crypto_work_items.next_run_at END,updated_at=NOW()`);
  for (const [assetId] of c.assets) count += await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_work_items (dedupe_key,kind,payload,priority) VALUES ($1,'ANALYTICS',$2::jsonb,6)
     ON CONFLICT (dedupe_key) DO UPDATE SET status=CASE WHEN crypto_work_items.updated_at<NOW()-INTERVAL '1 hour' THEN 'PENDING' ELSE crypto_work_items.status END,
     next_run_at=CASE WHEN crypto_work_items.updated_at<NOW()-INTERVAL '1 hour' THEN NOW() ELSE crypto_work_items.next_run_at END,updated_at=NOW()`,
    `ANALYTICS:${assetId}`,JSON.stringify({assetId}),
  );
  for (const networkId of c.onchain.supportedNetworks) count += await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_work_items (dedupe_key,kind,payload,priority) VALUES ($1,'ONCHAIN_NETWORK',$2::jsonb,8)
     ON CONFLICT (dedupe_key) DO UPDATE SET
       status=CASE WHEN crypto_work_items.status='RUNNING' THEN 'RUNNING' WHEN crypto_work_items.next_run_at<=NOW() THEN 'PENDING' ELSE crypto_work_items.status END,
       next_run_at=CASE WHEN crypto_work_items.next_run_at<=NOW() THEN NOW() ELSE crypto_work_items.next_run_at END,updated_at=NOW()`,
    `ONCHAIN_NETWORK:${networkId}`, JSON.stringify({ networkId }),
  );
  count += await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_work_items (dedupe_key,kind,payload,status,priority,next_run_at)
     VALUES ('DERIVATIVE_IDENTITY:BINANCE','DERIVATIVE_IDENTITY','{"exchangeId":"binance","source":"BINANCE_PUBLIC_API"}'::jsonb,'PENDING',0,NOW())
     ON CONFLICT (dedupe_key) DO UPDATE SET
       status=CASE WHEN crypto_work_items.status='RUNNING' THEN 'RUNNING' WHEN crypto_work_items.next_run_at<=NOW() THEN 'PENDING' ELSE crypto_work_items.status END,
       next_run_at=CASE WHEN crypto_work_items.next_run_at<=NOW() THEN NOW() ELSE crypto_work_items.next_run_at END,updated_at=NOW()`,
  );
  count += await enqueuePublicMesh(prisma, await loadPublicMesh());
  const expansion = await loadPublicDepthExpansion();
  count += await registerPublicDepthExpansion(prisma, expansion);
  await refreshPublicDepthExpansionGate(prisma, expansion);
  return count;
}

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "SmartFund/2 crypto-data-platform" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}:${url}`);
  return response.json();
}

async function candle(work: Work, c: Config): Promise<Record<string, unknown>> {
  const { marketId, symbol, interval, providerInterval, exchangeId = "binance" } = work.payload as Record<string, string>;
  const checkpoint = await prisma.$queryRawUnsafe<Array<{ last_open_time: Date | null; next_open_time: Date | null }>>(
    "SELECT MAX(open_time) AS last_open_time, MAX(open_time) + CASE $2 WHEN '1m' THEN INTERVAL '1 minute' WHEN '5m' THEN INTERVAL '5 minutes' WHEN '15m' THEN INTERVAL '15 minutes' WHEN '30m' THEN INTERVAL '30 minutes' WHEN '1h' THEN INTERVAL '1 hour' WHEN '2h' THEN INTERVAL '2 hours' WHEN '4h' THEN INTERVAL '4 hours' WHEN '6h' THEN INTERVAL '6 hours' WHEN '12h' THEN INTERVAL '12 hours' WHEN '1w' THEN INTERVAL '7 days' WHEN '1M' THEN INTERVAL '1 month' ELSE INTERVAL '1 day' END AS next_open_time FROM crypto_candles WHERE market_id=$1 AND interval=$2",
    marketId, interval,
  );
  const genesis = c.assets.find((asset) => asset[0] === c.productionMarkets.find((m) => m[0] === marketId)?.[2]);
  const network = c.networks.find((n) => n[0] === genesis?.[3]);
  const start = checkpoint[0]?.next_open_time?.getTime() ?? new Date(`${network?.[4] ?? "2017-01-01"}T00:00:00Z`).getTime();
  const validEnd = Date.now();
  if (start > validEnd) {
    return { rows: 0, latest: checkpoint[0]?.last_open_time ?? null, noOp: "NO_NEW_INTERVAL_AVAILABLE", nextEligibleAt: new Date(start) };
  }
  let rows: unknown;
  if (exchangeId === "coinbase") {
    const seconds: Record<string, number> = { "1h": 3600, "1d": 86400 };
    const end = new Date(Math.min(Date.now(), start + seconds[interval] * 300_000));
    rows = await json(`https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/candles?granularity=${seconds[interval]}&start=${new Date(start).toISOString()}&end=${end.toISOString()}`);
    if (Array.isArray(rows)) rows = rows.map((r: unknown) => { const x=r as unknown[]; return [Number(x[0])*1000,x[3],x[2],x[1],x[4],x[5],(Number(x[0])+seconds[interval])*1000-1,null,null]; }).sort((a,b)=>Number(a[0])-Number(b[0]));
  } else {
    rows = await json(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${providerInterval}&startTime=${start}&limit=500`);
  }
  if (!Array.isArray(rows)) throw new Error("INVALID_KLINES_PAYLOAD");
  for (let offset = 0; offset < rows.length; offset += c.writer.maxBatchRows) {
    const batch=(rows.slice(offset,offset+c.writer.maxBatchRows) as unknown[][]).map(raw=>({open_time:new Date(Number(raw[0])).toISOString(),close_time:new Date(Number(raw[6])).toISOString(),open:String(raw[1]),high:String(raw[2]),low:String(raw[3]),close:String(raw[4]),volume:String(raw[5]),quote_volume:raw[7]==null?null:String(raw[7]),trades:raw[8]==null?null:Number(raw[8]),payload:raw}));
    await prisma.$executeRawUnsafe(`INSERT INTO crypto_candles (market_id,interval,open_time,close_time,open,high,low,close,volume,quote_volume,trades,source,source_payload,source_record_id,freshness_status)
      SELECT $1,$2,x.open_time::timestamptz,x.close_time::timestamptz,x.open::decimal,x.high::decimal,x.low::decimal,x.close::decimal,x.volume::decimal,x.quote_volume::decimal,x.trades,$4,x.payload,x.open_time,'CURRENT'
      FROM jsonb_to_recordset($3::jsonb) AS x(open_time text,close_time text,open text,high text,low text,close text,volume text,quote_volume text,trades bigint,payload jsonb)
      ON CONFLICT (market_id,interval,open_time) DO UPDATE SET close_time=EXCLUDED.close_time,open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,quote_volume=EXCLUDED.quote_volume,trades=EXCLUDED.trades,source_payload=EXCLUDED.source_payload,freshness_status=EXCLUDED.freshness_status,observed_at=NOW(),updated_at=NOW()`,
      marketId,interval,JSON.stringify(batch),exchangeId==="coinbase"?"COINBASE_EXCHANGE_PUBLIC_API":source);
  }
  const latest = rows.length ? new Date(Number((rows.at(-1) as unknown[])[0])) : checkpoint[0]?.last_open_time ?? null;
  await updateCoverage(marketId, interval === "1d" ? "HISTORICAL_1D" : `HISTORICAL_${interval.toUpperCase()}`, latest, rows.length, rows.length ? "AVAILABLE" : "NO_UPDATE");
  if(rows.length>0){const market=c.productionMarkets.find(m=>m[0]===marketId);if(market)await prisma.$executeRawUnsafe(`INSERT INTO crypto_work_items (dedupe_key,kind,payload,priority) VALUES ($1,'ANALYTICS',$2::jsonb,6)
    ON CONFLICT (dedupe_key) DO UPDATE SET status=CASE WHEN crypto_work_items.status='RUNNING' THEN 'RUNNING' ELSE 'PENDING' END,next_run_at=NOW(),updated_at=NOW()`,`ANALYTICS:${market[2]}`,JSON.stringify({assetId:market[2],trigger:"HISTORY_READY"}));}
  return { rows: rows.length, latest };
}

async function deepHistory(work: Work, c: Config): Promise<Record<string, unknown>> {
  const { marketId, symbol, interval, providerInterval } = work.payload as Record<string, string>;
  const boundary = await prisma.$queryRawUnsafe<Array<{ earliest: Date | null }>>(
    "SELECT MIN(open_time) earliest FROM crypto_candles WHERE market_id=$1 AND interval=$2", marketId, interval,
  );
  if (!boundary[0]?.earliest) return { rows: 0, continuation: true, state: "WAITING_FOR_FORWARD_SEED" };
  const endTime = boundary[0].earliest.getTime() - 1;
  const rows = await json(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${providerInterval}&endTime=${endTime}&limit=500`);
  if (!Array.isArray(rows)) throw new Error("INVALID_KLINES_PAYLOAD");
  if (!rows.length) return { rows: 0, earliest: boundary[0].earliest, state: "MAX_DEPTH_REACHED" };
  const batch=(rows as unknown[][]).map(raw=>({open_time:new Date(Number(raw[0])).toISOString(),close_time:new Date(Number(raw[6])).toISOString(),open:String(raw[1]),high:String(raw[2]),low:String(raw[3]),close:String(raw[4]),volume:String(raw[5]),quote_volume:raw[7]==null?null:String(raw[7]),trades:raw[8]==null?null:Number(raw[8]),payload:raw}));
  await prisma.$executeRawUnsafe(`INSERT INTO crypto_candles (market_id,interval,open_time,close_time,open,high,low,close,volume,quote_volume,trades,source,source_payload,source_record_id,freshness_status)
    SELECT $1,$2,x.open_time::timestamptz,x.close_time::timestamptz,x.open::decimal,x.high::decimal,x.low::decimal,x.close::decimal,x.volume::decimal,x.quote_volume::decimal,x.trades,$4,x.payload,x.open_time,'HISTORICAL'
    FROM jsonb_to_recordset($3::jsonb) AS x(open_time text,close_time text,open text,high text,low text,close text,volume text,quote_volume text,trades bigint,payload jsonb)
    ON CONFLICT (market_id,interval,open_time) DO NOTHING`, marketId,interval,JSON.stringify(batch),source);
  return { rows: rows.length, earliest: new Date(Number((rows[0] as unknown[])[0])), continuation: rows.length === 500, state: "OLDER_TO_OLDEST_CONTINUATION" };
}

type DerivativeSeries = { source: string; exchange_id: string; base_asset_id: string; quote_asset_id: string; provider_symbol: string; payload_symbol: string; metric: string; rows: bigint; earliest: Date; latest: Date };
async function resolveDerivativeIdentities(): Promise<Record<string, unknown>> {
  const series = await prisma.$queryRawUnsafe<DerivativeSeries[]>(
    `SELECT m.source,s.exchange_id,s.base_asset_id,s.quote_asset_id,s.provider_symbol,m.payload->>'symbol' payload_symbol,m.metric,
       COUNT(*) rows,MIN(m.observed_at) earliest,MAX(m.observed_at) latest
     FROM crypto_metrics m JOIN crypto_markets s ON s.id=m.market_id
     WHERE m.metric IN ('FUNDING_RATE','OPEN_INTEREST') AND m.source='BINANCE_PUBLIC_API' AND s.exchange_id='binance'
     GROUP BY m.source,s.exchange_id,s.base_asset_id,s.quote_asset_id,s.provider_symbol,m.payload->>'symbol',m.metric
     ORDER BY s.exchange_id,s.provider_symbol,m.metric`,
  );
  const eligible = series.filter(row => row.payload_symbol === row.provider_symbol && row.quote_asset_id === "usdt");
  const products = new Map<string, { exchangeId: string; baseAssetId: string; quoteAssetId: string; symbol: string; earliest: Date; latest: Date; metrics: Set<string>; rows: number }>();
  for (const row of eligible) {
    const id = `${row.exchange_id}-${row.base_asset_id}-${row.quote_asset_id}-perpetual`;
    const current = products.get(id) ?? { exchangeId: row.exchange_id, baseAssetId: row.base_asset_id, quoteAssetId: row.quote_asset_id, symbol: row.provider_symbol, earliest: row.earliest, latest: row.latest, metrics: new Set<string>(), rows: 0 };
    current.earliest = current.earliest < row.earliest ? current.earliest : row.earliest;
    current.latest = current.latest > row.latest ? current.latest : row.latest;
    current.metrics.add(row.metric); current.rows += Number(row.rows); products.set(id, current);
  }
  for (const [id, product] of products) {
    const metadata = { canonicalGrain: "EXCHANGE_CONTRACT_LEVEL", identityStatus: "EXACT_MAPPED", officialSymbol: product.symbol, providerSymbol: product.symbol, underlyingAssetId: product.baseAssetId, quoteAssetId: product.quoteAssetId, settlementAssetId: product.quoteAssetId, contractType: "PERPETUAL", expirySemantics: "NO_EXPIRY", marginType: "STABLECOIN_MARGIN", linearInverse: "LINEAR", source: "BINANCE_PUBLIC_API", sourceRoute: "BINANCE_USDS_M_FUTURES_FAPI", sourceGrain: "EXCHANGE_CONTRACT_LEVEL", evidenceMetrics: [...product.metrics].sort(), evidenceEarliest: product.earliest, evidenceLatest: product.latest, multiplier: null, tickSize: null, tradingStatus: "ACTIVE", relationshipMethod: "EXACT_EXCHANGE_PLUS_OFFICIAL_SYMBOL" };
    await prisma.$executeRawUnsafe(
      `INSERT INTO crypto_markets (id,exchange_id,base_asset_id,quote_asset_id,provider_symbol,market_type,active,metadata,updated_at)
       VALUES ($1,$2,$3,$4,$5,'PERPETUAL',TRUE,$6::jsonb,NOW())
       ON CONFLICT (id) DO UPDATE SET exchange_id=EXCLUDED.exchange_id,base_asset_id=EXCLUDED.base_asset_id,quote_asset_id=EXCLUDED.quote_asset_id,
         provider_symbol=EXCLUDED.provider_symbol,market_type='PERPETUAL',active=TRUE,metadata=COALESCE(crypto_markets.metadata,'{}'::jsonb)||EXCLUDED.metadata,updated_at=NOW()`,
      id, product.exchangeId, product.baseAssetId, product.quoteAssetId, product.symbol, JSON.stringify(metadata),
    );
  }
  const pending = series.filter(row => !eligible.includes(row));
  const checkpoint = { provider: "BINANCE_PUBLIC_API", exchange: "binance", productSymbols: [...new Set(eligible.map(row => row.provider_symbol))].sort(), series: eligible.map(row => `${row.metric}:${row.provider_symbol}`), resolutionState: pending.length ? "PARTIAL" : "COMPLETE_AS_AVAILABLE", lastEvidenceWatermark: eligible.length ? new Date(Math.max(...eligible.map(row => row.latest.getTime()))) : null, exactMappedSeries: eligible.length, products: products.size, aggregateOnly: 0, identityPending: pending.length, identityConflict: 0, readback: "PASS" };
  const readback = await prisma.$queryRawUnsafe<Array<{ products: bigint }>>(`SELECT COUNT(*) products FROM crypto_markets WHERE market_type='PERPETUAL' AND exchange_id='binance' AND metadata->>'identityStatus'='EXACT_MAPPED'`);
  if (Number(readback[0]?.products ?? 0) < products.size) throw new Error("DERIVATIVE_IDENTITY_READBACK_FAILED");
  await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_work_items (dedupe_key,kind,payload,status,priority,checkpoint,next_run_at,completed_at)
     VALUES ('DERIVATIVE_IDENTITY:BINANCE','DERIVATIVE_IDENTITY','{"exchangeId":"binance","source":"BINANCE_PUBLIC_API"}'::jsonb,'DONE',0,$1::jsonb,NOW()+INTERVAL '15 minutes',NOW())
     ON CONFLICT (dedupe_key) DO UPDATE SET status='DONE',attempts=0,checkpoint=EXCLUDED.checkpoint,next_run_at=EXCLUDED.next_run_at,last_error=NULL,completed_at=NOW(),updated_at=NOW()`, JSON.stringify(checkpoint),
  );
  return { rows: products.size, checkpoint, products: [...products.keys()].sort(), exactMappedSeries: eligible.length, pending: pending.map(row => `${row.metric}:${row.provider_symbol}:${row.payload_symbol || "MISSING_SYMBOL"}`), readback: "PASS" };
}

async function metric(work: Work): Promise<Record<string, unknown>> {
  const { marketId, symbol } = work.payload as Record<string, string>;
  const market = await prisma.$queryRawUnsafe<Array<{ base_asset_id: string }>>("SELECT base_asset_id FROM crypto_markets WHERE id=$1", marketId);
  if (!market[0]) throw new Error(`UNKNOWN_MARKET:${marketId}`);
  let metricName: string; let value: string; let payload: unknown; let url: string;
  if (work.kind === "SNAPSHOT") {
    const exchangeId = String(work.payload.exchangeId ?? (marketId.startsWith("coinbase-") ? "coinbase" : "binance"));
    if (exchangeId === "coinbase") {
      url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/ticker`;
      payload = await json(url); const x=payload as Record<string,string>; metricName="LATEST_PRICE"; value=String(x.price);
      const observedAt=new Date(x.time ?? Date.now()); const bid=x.bid == null ? null : String(x.bid); const ask=x.ask == null ? null : String(x.ask);
      await prisma.$executeRawUnsafe(`INSERT INTO crypto_market_snapshots (market_id,observed_at,price,quote_currency,volume_24h,bid,ask,spread,source,source_record_id,freshness_status,source_payload)
        VALUES ($1,$2,$3::decimal,'USD',$4::decimal,$5::decimal,$6::decimal,CASE WHEN $5 IS NULL OR $6 IS NULL THEN NULL ELSE $6::decimal-$5::decimal END,'COINBASE_EXCHANGE_PUBLIC_API',$7,'CURRENT',$8::jsonb)
        ON CONFLICT (market_id,observed_at) DO UPDATE SET price=EXCLUDED.price,volume_24h=EXCLUDED.volume_24h,bid=EXCLUDED.bid,ask=EXCLUDED.ask,spread=EXCLUDED.spread,updated_at=NOW()`,
        marketId,observedAt,value,x.volume ?? null,bid,ask,x.trade_id == null ? null : String(x.trade_id),JSON.stringify(payload));
    } else {
      url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
      payload = await json(url); const x=payload as Record<string,string>; metricName="LATEST_PRICE"; value=String(x.lastPrice); const observedAt=new Date(Number(x.closeTime ?? Date.now()));
      await prisma.$executeRawUnsafe(`INSERT INTO crypto_market_snapshots (market_id,observed_at,price,quote_currency,volume_24h,change_24h,change_percent_24h,bid,ask,spread,source,source_record_id,freshness_status,source_payload)
        VALUES ($1,$2,$3::decimal,'USDT',$4::decimal,$5::decimal,$6::decimal,$7::decimal,$8::decimal,$8::decimal-$7::decimal,$9,NULL,'CURRENT',$10::jsonb)
        ON CONFLICT (market_id,observed_at) DO UPDATE SET price=EXCLUDED.price,volume_24h=EXCLUDED.volume_24h,change_24h=EXCLUDED.change_24h,change_percent_24h=EXCLUDED.change_percent_24h,bid=EXCLUDED.bid,ask=EXCLUDED.ask,spread=EXCLUDED.spread,updated_at=NOW()`,
        marketId,observedAt,value,x.volume ?? null,x.priceChange ?? null,x.priceChangePercent ?? null,x.bidPrice ?? null,x.askPrice ?? null,source,JSON.stringify(payload));
    }
  } else if (work.kind === "FUNDING_RATE") {
    url = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`;
    payload = await json(url); metricName = "FUNDING_RATE"; value = String((payload as { lastFundingRate: string }).lastFundingRate);
  } else {
    url = `https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`;
    payload = await json(url); metricName = "OPEN_INTEREST"; value = String((payload as { openInterest: string }).openInterest);
  }
  const observedAt = new Date();
  let canonicalMarketId = marketId;
  if (work.kind === "FUNDING_RATE" || work.kind === "OPEN_INTEREST") {
    const derivative = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT d.id FROM crypto_markets s JOIN crypto_markets d ON d.exchange_id=s.exchange_id AND d.provider_symbol=s.provider_symbol AND d.market_type='PERPETUAL'
       WHERE s.id=$1 AND d.base_asset_id=s.base_asset_id AND d.quote_asset_id=s.quote_asset_id AND d.metadata->>'identityStatus'='EXACT_MAPPED' LIMIT 1`, marketId,
    );
    if (!derivative[0]) throw new Error(`DERIVATIVE_IDENTITY_PENDING:${marketId}:${symbol}`);
    canonicalMarketId = derivative[0].id;
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_metrics (asset_id,market_id,metric,observed_at,value,unit,payload,source,source_url) VALUES ($1,$2,$3,$4,$5::decimal,$6,$7::jsonb,$8,$9)
     ON CONFLICT (asset_id,market_id,metric,observed_at) DO NOTHING`, market[0].base_asset_id, canonicalMarketId, metricName, observedAt, value,
    metricName === "FUNDING_RATE" ? "RATIO" : metricName === "LATEST_PRICE" ? "USDT" : "BASE_ASSET", JSON.stringify(payload), source, url,
  );
  await updateCoverage(canonicalMarketId, metricName, observedAt, 1, "AVAILABLE");
  return { metric: metricName, value, marketId: canonicalMarketId };
}

async function capSupply(c: Config): Promise<Record<string, unknown>> {
  const entries=Object.entries(c.marketDataIds); const url=`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(entries.map(([,v])=>v).join(","))}&per_page=250&page=1&sparkline=false`;
  const payload=await json(url); if(!Array.isArray(payload)) throw new Error("INVALID_COINGECKO_MARKETS_PAYLOAD");
  const reverse=new Map(entries.map(([asset,id])=>[id,asset])); let inserted=0;
  const decimalParam=(value:unknown):string|null=>value==null?null:String(value);
  for(const raw of payload as Array<Record<string,unknown>>){const assetId=reverse.get(String(raw.id)); if(!assetId) continue; const observedAt=new Date(String(raw.last_updated));
    await prisma.$executeRawUnsafe(`INSERT INTO crypto_market_cap_supply (asset_id,observed_at,market_cap,fully_diluted_valuation,circulating_supply,total_supply,max_supply,market_cap_rank,source,source_record_id,freshness_status,source_payload)
      VALUES ($1,$2,$3::decimal,$4::decimal,$5::decimal,$6::decimal,$7::decimal,$8,'COINGECKO_PUBLIC_API',$9,'CURRENT',$10::jsonb)
      ON CONFLICT (asset_id,observed_at) DO UPDATE SET market_cap=EXCLUDED.market_cap,fully_diluted_valuation=EXCLUDED.fully_diluted_valuation,circulating_supply=EXCLUDED.circulating_supply,total_supply=EXCLUDED.total_supply,max_supply=EXCLUDED.max_supply,market_cap_rank=EXCLUDED.market_cap_rank,updated_at=NOW()`,
      assetId,observedAt,decimalParam(raw.market_cap),decimalParam(raw.fully_diluted_valuation),decimalParam(raw.circulating_supply),decimalParam(raw.total_supply),decimalParam(raw.max_supply),raw.market_cap_rank == null ? null : Number(raw.market_cap_rank),String(raw.id),JSON.stringify(raw));
    for(const [metric,value,unit] of [["LATEST_PRICE",raw.current_price,"USD"],["VOLUME_24H",raw.total_volume,"USD"],["CHANGE_24H",raw.price_change_24h,"USD"],["CHANGE_PERCENT_24H",raw.price_change_percentage_24h,"PERCENT"]] as const){if(value==null)continue;await prisma.$executeRawUnsafe(`INSERT INTO crypto_metrics (asset_id,market_id,metric,observed_at,value,unit,payload,source,source_url)
      VALUES ($1,'',$2,$3,$4::decimal,$5,$6::jsonb,'COINGECKO_PUBLIC_API',$7) ON CONFLICT (asset_id,market_id,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,payload=EXCLUDED.payload,ingested_at=NOW()`,assetId,metric,observedAt,decimalParam(value),unit,JSON.stringify({sourceType:"PUBLIC_AGGREGATED_MARKET_DATA",freshnessStatus:"CURRENT",sourceRecordId:String(raw.id)}),url);}
    inserted++;}
  const stablecoinDerived = await deriveStablecoinMetrics();
  return {inserted,stablecoinDerived,source:"COINGECKO_PUBLIC_API"};
}

async function deriveStablecoinMetrics(): Promise<Record<string, unknown>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ asset_id: string; observed_at: Date; circulating_supply: string; market_cap: string; previous_supply: string | null }>>(
    `WITH ranked AS (
       SELECT asset_id,observed_at,circulating_supply,market_cap,
         LAG(circulating_supply) OVER (PARTITION BY asset_id ORDER BY observed_at) previous_supply,
         ROW_NUMBER() OVER (PARTITION BY asset_id ORDER BY observed_at DESC) rn
       FROM crypto_market_cap_supply WHERE asset_id IN ('usdt','usdc')
     ) SELECT asset_id,observed_at,circulating_supply::text,market_cap::text,previous_supply::text
       FROM ranked WHERE rn=1 ORDER BY asset_id`,
  );
  const caps = await prisma.$queryRawUnsafe<Array<{ tracked_stablecoin_cap: string; tracked_crypto_cap: string }>>(
    `WITH latest AS (SELECT DISTINCT ON (asset_id) asset_id,market_cap FROM crypto_market_cap_supply WHERE market_cap IS NOT NULL ORDER BY asset_id,observed_at DESC)
     SELECT COALESCE(SUM(market_cap) FILTER (WHERE asset_id IN ('usdt','usdc')),0)::text tracked_stablecoin_cap,
       COALESCE(SUM(market_cap),0)::text tracked_crypto_cap FROM latest`,
  );
  const trackedStablecoinCap = Number(caps[0]?.tracked_stablecoin_cap ?? 0);
  const trackedCryptoCap = Number(caps[0]?.tracked_crypto_cap ?? 0);
  let inserted = 0;
  const fields = new Set<string>();
  for (const row of rows) {
    const supply = Number(row.circulating_supply), previousSupply = row.previous_supply == null ? null : Number(row.previous_supply), marketCap = Number(row.market_cap);
    const metrics: Array<[string, number | null, string, string]> = [
      ["STABLECOIN_NET_ISSUANCE_OBSERVATION_DELTA", previousSupply == null ? null : supply - previousSupply, "TOKEN", "LATEST_CIRCULATING_SUPPLY_MINUS_PREVIOUS_PROVIDER_OBSERVATION"],
      ["STABLECOIN_SUPPLY_GROWTH", previousSupply && previousSupply !== 0 ? supply / previousSupply - 1 : null, "RATIO", "OBSERVATION_OVER_OBSERVATION_CIRCULATING_SUPPLY_GROWTH"],
      ["STABLECOIN_MARKET_SHARE_TRACKED", trackedStablecoinCap > 0 ? marketCap / trackedStablecoinCap : null, "RATIO", "ASSET_MARKET_CAP_OVER_USDT_PLUS_USDC_MARKET_CAP"],
      ["STABLECOIN_DOMINANCE_TRACKED_CRYPTO", trackedCryptoCap > 0 ? marketCap / trackedCryptoCap : null, "RATIO", "ASSET_MARKET_CAP_OVER_TRACKED_CRYPTO_UNIVERSE_MARKET_CAP"],
    ];
    for (const [metric, value, unit, methodology] of metrics) {
      if (value == null || !Number.isFinite(value)) continue;
      await prisma.$executeRawUnsafe(
        `INSERT INTO crypto_metrics (asset_id,market_id,metric,observed_at,value,unit,payload,source,source_url)
         VALUES ($1,'',$2,$3,$4::decimal,$5,$6::jsonb,'DERIVED_FROM_COINGECKO_CAP_SUPPLY',NULL)
         ON CONFLICT (asset_id,market_id,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,unit=EXCLUDED.unit,payload=EXCLUDED.payload,ingested_at=NOW()`,
        row.asset_id, metric, row.observed_at, String(value), unit,
        JSON.stringify({ sourceType: "DERIVED", raw: false, methodology, methodologyVersion: 1, underlyingSource: "COINGECKO_PUBLIC_API", trackedUniverse: metric.includes("DOMINANCE") ? "19_CRYPTO_ASSETS" : metric.includes("MARKET_SHARE") ? "USDT_USDC" : undefined }),
      );
      fields.add(metric); inserted++;
    }
  }
  return { inserted, assets: rows.map(row => row.asset_id), fields: [...fields], methodologyVersion: 1 };
}

const hexNumber = (value: unknown): number => typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? Number.parseInt(value.slice(2), 16) : Number.NaN;
async function ethereumRpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
  const payload = await response.json() as { result?: unknown; error?: { code?: number; message?: string } };
  if (!response.ok || payload.error) throw new Error(`ETHEREUM_RPC_${method}:${response.status}:${payload.error?.code ?? "HTTP"}`);
  return payload.result;
}

async function ethereumNetwork(c: Config): Promise<Record<string, unknown>> {
  const cfg = c.onchain.ethereum, rpcUrl = process.env[cfg.executionRpcEnv];
  if (!rpcUrl) throw new Error(`BLOCKED_SOURCE:${cfg.executionRpcEnv}`);
  const chainId = String(await ethereumRpc(rpcUrl, "eth_chainId"));
  if (chainId !== "0x1") throw new Error(`ETHEREUM_CHAIN_ID_MISMATCH:${chainId}`);
  const safeBlock = await ethereumRpc(rpcUrl, "eth_getBlockByNumber", [cfg.finalityTag, false]) as Record<string, unknown> | null;
  if (!safeBlock) throw new Error("ETHEREUM_SAFE_BLOCK_UNAVAILABLE");
  const safeHeight = hexNumber(safeBlock.number);
  if (!Number.isSafeInteger(safeHeight) || safeHeight <= 0) throw new Error("INVALID_ETHEREUM_SAFE_HEIGHT");
  const checkpointRows = await prisma.$queryRawUnsafe<Array<{ checkpoint: Record<string, unknown> | null }>>(
    `SELECT checkpoint FROM crypto_work_items WHERE dedupe_key='ONCHAIN_NETWORK:ethereum' LIMIT 1`,
  );
  const checkpoint = checkpointRows[0]?.checkpoint ?? {};
  const priorHeight = Number(checkpoint.latestBlock ?? 0);
  const backfillStart = Number(checkpoint.backfillStart ?? Math.max(1, safeHeight - cfg.initialBackfillBlocks + 1));
  const startHeight = priorHeight >= backfillStart && priorHeight < safeHeight ? priorHeight + 1 : priorHeight >= safeHeight ? Math.max(1, safeHeight - c.onchain.boundedBatchSize + 1) : backfillStart;
  const heights = Array.from({ length: Math.min(c.onchain.boundedBatchSize, safeHeight - startHeight + 1) }, (_, index) => startHeight + index);
  if (!heights.length) throw new Error("EMPTY_ETHEREUM_BLOCK_BATCH");
  const blocks: Array<Record<string, unknown>> = [];
  for (const height of heights) {
    const block = await ethereumRpc(rpcUrl, "eth_getBlockByNumber", [`0x${height.toString(16)}`, false]) as Record<string, unknown> | null;
    if (!block || hexNumber(block.number) !== height) throw new Error(`ETHEREUM_BLOCK_READBACK_MISMATCH:${height}`);
    blocks.push(block);
  }
  const firstParent = await ethereumRpc(rpcUrl, "eth_getBlockByHash", [String(blocks[0].parentHash), false]) as Record<string, unknown> | null;
  if (!firstParent) throw new Error("ETHEREUM_PARENT_BLOCK_UNAVAILABLE");
  let previousTimestamp = hexNumber(firstParent.timestamp), inserted = 0;
  const observedTimes: Date[] = [], fields = new Set<string>();
  for (const block of blocks) {
    const height = hexNumber(block.number), timestamp = hexNumber(block.timestamp), gasUsed = hexNumber(block.gasUsed), gasLimit = hexNumber(block.gasLimit), baseFee = hexNumber(block.baseFeePerGas);
    const observedAt = new Date(timestamp * 1000), transactionCount = Array.isArray(block.transactions) ? block.transactions.length : 0;
    const metrics: Array<[string, number, string, boolean, string]> = [
      ["BLOCK_HEIGHT", height, "BLOCK", false, "RPC_BLOCK_NUMBER"], ["BLOCK_TIMESTAMP", timestamp, "UNIX_SECOND", false, "RPC_BLOCK_TIMESTAMP"],
      ["BLOCK_TRANSACTION_COUNT", transactionCount, "TRANSACTION", false, "RPC_TRANSACTION_HASH_COUNT"], ["BLOCK_GAS_USED", gasUsed, "GAS", false, "RPC_BLOCK_GAS_USED"],
      ["BLOCK_GAS_LIMIT", gasLimit, "GAS", false, "RPC_BLOCK_GAS_LIMIT"], ["BLOCK_BASE_FEE", baseFee, "WEI_PER_GAS", false, "RPC_BASE_FEE_PER_GAS"],
      ["BLOCK_UTILIZATION", gasLimit > 0 ? gasUsed / gasLimit : Number.NaN, "RATIO", true, "GAS_USED_DIVIDED_BY_GAS_LIMIT"],
      ["BLOCK_INTERVAL", timestamp - previousTimestamp, "SECOND", true, "CURRENT_BLOCK_TIMESTAMP_MINUS_PARENT_TIMESTAMP"],
      ["BASE_FEE_BURN", baseFee * gasUsed / 1e18, "ETH", true, "BASE_FEE_PER_GAS_MULTIPLIED_BY_GAS_USED_DIVIDED_BY_1E18"],
    ];
    const blockSize = hexNumber(block.size); if (Number.isFinite(blockSize)) metrics.push(["BLOCK_SIZE", blockSize, "BYTE", false, "RPC_BLOCK_SIZE"]);
    if (metrics.some(([, value]) => !Number.isFinite(value) || value < 0)) throw new Error(`INVALID_ETHEREUM_BLOCK_METRIC:${height}`);
    for (const [metric, value, unit, derived, methodology] of metrics) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO crypto_metrics (asset_id,market_id,metric,observed_at,value,unit,payload,source,source_url)
         VALUES ($1,'',$2,$3,$4::decimal,$5,$6::jsonb,$7,NULL)
         ON CONFLICT (asset_id,market_id,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,unit=EXCLUDED.unit,payload=EXCLUDED.payload,source=EXCLUDED.source,ingested_at=NOW()`,
        cfg.assetId, metric, observedAt, String(value), unit,
        JSON.stringify({ networkId: "ethereum", blockHeight: height, blockHash: block.hash, parentHash: block.parentHash, sourceType: "CHAIN_NATIVE_RPC", rpcMethod: "eth_getBlockByNumber", retrievedAt: new Date().toISOString(), raw: !derived, derived, methodology, methodologyVersion: 1, finalityPolicy: cfg.finalityTag }), cfg.source,
      );
      fields.add(metric); inserted++;
    }
    observedTimes.push(observedAt); previousTimestamp = timestamp;
  }
  const latest = blocks.at(-1)!, latestHeight = hexNumber(latest.number), latestObservedAt = observedTimes.at(-1)!;
  const resultCheckpoint = { networkId: "ethereum", assetId: cfg.assetId, backfillStart, latestBlock: latestHeight, safeHeight, blockHash: latest.hash, parentHash: latest.parentHash, historicalBackfillComplete: latestHeight >= safeHeight, finalityPolicy: cfg.finalityTag, readback: "PASS" };
  await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_coverage (asset_id,exchange_id,capability,status,provider,latest_at,row_count,quality_status,details,checked_at)
     VALUES ($1,'','ON_CHAIN','AVAILABLE',$2,$3,$4,'PASS',$5::jsonb,NOW())
     ON CONFLICT (asset_id,exchange_id,capability) DO UPDATE SET status='AVAILABLE',provider=EXCLUDED.provider,earliest_at=COALESCE(crypto_coverage.earliest_at,EXCLUDED.latest_at),latest_at=GREATEST(crypto_coverage.latest_at,EXCLUDED.latest_at),row_count=crypto_coverage.row_count+EXCLUDED.row_count,quality_status='PASS',details=EXCLUDED.details,checked_at=NOW()`,
    cfg.assetId, cfg.source, latestObservedAt, inserted, JSON.stringify(resultCheckpoint),
  );
  const readback = await prisma.$queryRawUnsafe<Array<{ rows: bigint }>>(
    `SELECT COUNT(*) rows FROM crypto_metrics WHERE asset_id=$1 AND market_id='' AND source=$2 AND observed_at=ANY($3::timestamptz[]) AND metric=ANY($4::text[])`, cfg.assetId, cfg.source, observedTimes, [...fields],
  );
  if (Number(readback[0]?.rows ?? 0) < inserted) throw new Error("ETHEREUM_ONCHAIN_READBACK_FAILED");
  return { rows: inserted, blocksProcessed: blocks.length, networkId: "ethereum", assetId: cfg.assetId, earliestBlock: heights[0], latestBlock: latestHeight, safeHeight, observedAt: latestObservedAt, checkpoint: resultCheckpoint, readback: "PASS", fields: [...fields] };
}

async function onchainNetwork(c: Config, workItem: Work): Promise<Record<string, unknown>> {
  const networkId = String(workItem.payload.networkId ?? c.onchain.canary.networkId);
  if (!c.onchain.supportedNetworks.includes(networkId)) throw new Error(`BLOCKED_SOURCE:${networkId}`);
  if (networkId === "ethereum") return ethereumNetwork(c);
  const network = c.networks.find(item => item[0] === networkId);
  if (!network) throw new Error(`UNKNOWN_NETWORK:${networkId}`);
  const assetId = network[2];
  const sourceConfig = c.onchain.canary;
  const tipHeight = Number(await (await fetch(`${sourceConfig.apiUrl}/blocks/tip/height`, { signal: AbortSignal.timeout(15_000) })).text());
  if (!Number.isSafeInteger(tipHeight) || tipHeight <= 0) throw new Error("INVALID_BITCOIN_TIP_HEIGHT");
  const checkpointRows = await prisma.$queryRawUnsafe<Array<{ checkpoint: Record<string, unknown> | null }>>(
    `SELECT checkpoint FROM crypto_work_items WHERE dedupe_key=$1 LIMIT 1`, `ONCHAIN_NETWORK:${networkId}`,
  );
  const checkpointHeight = Number(checkpointRows[0]?.checkpoint?.latestBlock ?? 0);
  const startHeight = checkpointHeight > 0 && checkpointHeight < tipHeight ? checkpointHeight + 1 : Math.max(1, tipHeight - c.onchain.boundedBatchSize + 1);
  const heights = Array.from({ length: Math.min(c.onchain.boundedBatchSize, tipHeight - startHeight + 1) }, (_, index) => startHeight + index);
  const blocks: Array<Record<string, unknown>> = [];
  for (const height of heights) {
    const hashResponse = await fetch(`${sourceConfig.apiUrl}/block-height/${height}`, { signal: AbortSignal.timeout(15_000) });
    if (!hashResponse.ok) throw new Error(`HTTP_${hashResponse.status}:BITCOIN_BLOCK_HASH:${height}`);
    const hash = String(await hashResponse.text()).trim();
    const blockResponse = await fetch(`${sourceConfig.apiUrl}/v1/block/${hash}`, { signal: AbortSignal.timeout(15_000) });
    if (!blockResponse.ok) throw new Error(`HTTP_${blockResponse.status}:BITCOIN_BLOCK:${height}`);
    blocks.push(await blockResponse.json() as Record<string, unknown>);
  }
  if (!blocks.length) throw new Error("EMPTY_BITCOIN_BLOCK_BATCH");
  const firstPreviousHash = String(blocks[0].previousblockhash ?? "");
  const previousResponse = await fetch(`${sourceConfig.apiUrl}/block/${firstPreviousHash}`, { signal: AbortSignal.timeout(15_000) });
  if (!previousResponse.ok) throw new Error(`HTTP_${previousResponse.status}:BITCOIN_PREVIOUS_BLOCK`);
  let previousTimestamp = Number((await previousResponse.json() as Record<string, unknown>).timestamp);
  let inserted = 0;
  const fields = new Set<string>();
  const observedTimes: Date[] = [];
  for (const block of blocks) {
    const hash = String(block.id ?? ""), observedAt = new Date(Number(block.timestamp) * 1000), extras = (block.extras ?? {}) as Record<string, unknown>;
    const metrics: Array<[string, number, string]> = [
      ["BLOCK_HEIGHT", Number(block.height), "BLOCK"], ["BLOCK_TRANSACTION_COUNT", Number(block.tx_count), "TRANSACTION"],
      ["BLOCK_SIZE", Number(block.size), "BYTE"], ["BLOCK_WEIGHT", Number(block.weight), "WEIGHT_UNIT"],
      ["NETWORK_DIFFICULTY", Number(block.difficulty), "DIFFICULTY"], ["BLOCK_INTERVAL", Number(block.timestamp) - previousTimestamp, "SECOND"],
      ["BLOCK_TOTAL_FEES", Number(extras.totalFees), "SATOSHI"], ["BLOCK_AVERAGE_FEE", Number(extras.avgFee), "SATOSHI_PER_TRANSACTION"],
      ["BLOCK_TOTAL_OUTPUT_AMOUNT", Number(extras.totalOutputAmt), "SATOSHI"],
    ].filter(([, value]) => Number.isFinite(value));
    if (metrics.length < 6) throw new Error(`INVALID_BITCOIN_BLOCK_METRIC:${block.height}`);
    for (const [metricName, value, unit] of metrics) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO crypto_metrics (asset_id,market_id,metric,observed_at,value,unit,payload,source,source_url)
         VALUES ($1,'',$2,$3,$4::decimal,$5,$6::jsonb,$7,$8)
         ON CONFLICT (asset_id,market_id,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,unit=EXCLUDED.unit,payload=EXCLUDED.payload,source=EXCLUDED.source,source_url=EXCLUDED.source_url,ingested_at=NOW()`,
        assetId, metricName, observedAt, String(value), unit,
        JSON.stringify({ networkId, blockHeight: block.height, blockHash: hash, previousBlockHash: block.previousblockhash, sourceType: "CHAIN_NATIVE", raw: true, methodologyVersion: 1, verificationStatus: "CHAIN_NATIVE_READBACK", transactionVolumeSemantics: metricName === "BLOCK_TOTAL_OUTPUT_AMOUNT" ? "TOTAL_OUTPUT_AMOUNT_INCLUDES_CHANGE_NOT_ECONOMIC_TRANSFER_VOLUME" : undefined }),
        sourceConfig.source, `${sourceConfig.apiUrl}/v1/block/${hash}`,
      );
      fields.add(metricName); inserted++;
    }
    observedTimes.push(observedAt); previousTimestamp = Number(block.timestamp);
  }
  const hashRateResponse = await fetch(`${sourceConfig.apiUrl}/v1/mining/hashrate/3d`, { signal: AbortSignal.timeout(15_000) });
  if (hashRateResponse.ok) {
    const hashRatePayload = await hashRateResponse.json() as { hashrates?: Array<{ timestamp?: number; avgHashrate?: number }> };
    const hashRate = hashRatePayload.hashrates?.at(-1);
    if (hashRate && Number.isFinite(hashRate.timestamp) && Number.isFinite(hashRate.avgHashrate)) {
      const hashRateAt = new Date(Number(hashRate.timestamp) * 1000);
      await prisma.$executeRawUnsafe(
        `INSERT INTO crypto_metrics (asset_id,market_id,metric,observed_at,value,unit,payload,source,source_url)
         VALUES ($1,'','NETWORK_HASH_RATE',$2,$3::decimal,'EXAHASH_PER_SECOND',$4::jsonb,$5,$6)
         ON CONFLICT (asset_id,market_id,metric,observed_at) DO UPDATE SET value=EXCLUDED.value,payload=EXCLUDED.payload,ingested_at=NOW()`,
        assetId, hashRateAt, String(hashRate.avgHashrate / 1e18), JSON.stringify({ networkId, sourceType: "CHAIN_NATIVE", raw: true, sourceUnit: "HASH_PER_SECOND", storedUnit: "EXAHASH_PER_SECOND", conversionDivisor: 1e18, aggregation: "PROVIDER_DAILY_AVERAGE", methodologyVersion: 1 }), sourceConfig.source, `${sourceConfig.apiUrl}/v1/mining/hashrate/3d`,
      );
      fields.add("NETWORK_HASH_RATE"); inserted++; observedTimes.push(hashRateAt);
    }
  }
  const latestBlock = Number(blocks.at(-1)?.height), latestHash = String(blocks.at(-1)?.id ?? ""), latestObservedAt = new Date(Math.max(...observedTimes.map(value => value.getTime())));
  await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_coverage (asset_id,exchange_id,capability,status,provider,latest_at,row_count,quality_status,details,checked_at)
     VALUES ($1,'','ON_CHAIN','AVAILABLE',$2,$3,$4,'PASS',$5::jsonb,NOW())
     ON CONFLICT (asset_id,exchange_id,capability) DO UPDATE SET status=EXCLUDED.status,provider=EXCLUDED.provider,latest_at=EXCLUDED.latest_at,row_count=crypto_coverage.row_count+EXCLUDED.row_count,quality_status='PASS',details=EXCLUDED.details,checked_at=NOW()`,
    assetId, sourceConfig.source, latestObservedAt, inserted, JSON.stringify({ networkId, latestBlock, tipHeight, checkpoint: latestHash, boundedBatchSize: heights.length, historicalBackfillComplete: latestBlock >= tipHeight }),
  );
  const readback = await prisma.$queryRawUnsafe<Array<{ rows: bigint }>>(
    `SELECT COUNT(*) rows FROM crypto_metrics WHERE asset_id=$1 AND market_id='' AND observed_at=ANY($2::timestamptz[]) AND source=$3 AND metric=ANY($4::text[])`,
    assetId, observedTimes, sourceConfig.source, [...fields],
  );
  if (Number(readback[0]?.rows ?? 0) < inserted) throw new Error("ONCHAIN_READBACK_FAILED");
  return { rows: inserted, networkId, assetId, latestBlock, tipHeight, observedAt: latestObservedAt, checkpoint: { latestBlock, blockHash: latestHash, historicalBackfillComplete: latestBlock >= tipHeight }, readback: "PASS", fields: [...fields] };
}

async function onchainCanary(c: Config): Promise<Record<string, unknown>> {
  if (!await acquireWriterLock(c.writer.singleWriterLock)) throw new Error("CRYPTO_SINGLE_WRITER_BUSY");
  try {
    return await onchainNetwork(c, { id: "CANARY", dedupe_key: "ONCHAIN_NETWORK:bitcoin", kind: "ONCHAIN_NETWORK", payload: { networkId: "bitcoin" }, attempts: 0, max_attempts: 1 });
  } finally {
    await releaseWriterLock(c.writer.singleWriterLock);
  }
}

async function ethereumCanary(c: Config): Promise<Record<string, unknown>> {
  if (!await acquireWriterLock(c.writer.singleWriterLock)) throw new Error("CRYPTO_SINGLE_WRITER_BUSY");
  try {
    const result = await ethereumNetwork(c);
    const nextRunAt = new Date(Date.now() + 15 * 60_000);
    await prisma.$executeRawUnsafe(
      `INSERT INTO crypto_work_items (dedupe_key,kind,payload,status,priority,checkpoint,next_run_at,completed_at)
       VALUES ('ONCHAIN_NETWORK:ethereum','ONCHAIN_NETWORK','{"networkId":"ethereum"}'::jsonb,'DONE',8,$1::jsonb,$2,NOW())
       ON CONFLICT (dedupe_key) DO UPDATE SET kind='ONCHAIN_NETWORK',payload=EXCLUDED.payload,status='DONE',priority=8,checkpoint=EXCLUDED.checkpoint,next_run_at=EXCLUDED.next_run_at,last_error=NULL,completed_at=NOW(),updated_at=NOW()`,
      JSON.stringify(result.checkpoint), nextRunAt,
    );
    return { ...result, nextRunAt, ordinaryWorker: "crypto_work_items" };
  } finally { await releaseWriterLock(c.writer.singleWriterLock); }
}

async function activateOnchainQueue(c: Config): Promise<Record<string, unknown>> {
  const sourceConfig = c.onchain.canary;
  const latest = await prisma.$queryRawUnsafe<Array<{ observed_at: Date; value: string; payload: Record<string, unknown> }>>(
    `SELECT observed_at,value::text,payload FROM crypto_metrics WHERE asset_id=$1 AND market_id='' AND metric='BLOCK_HEIGHT' AND source=$2 ORDER BY observed_at DESC LIMIT 1`,
    sourceConfig.assetId, sourceConfig.source,
  );
  if (!latest[0]) throw new Error("ONCHAIN_CANARY_CHECKPOINT_MISSING");
  const checkpoint = { networkId: sourceConfig.networkId, assetId: sourceConfig.assetId, latestBlock: Number(latest[0].value), observedAt: latest[0].observed_at, blockHash: latest[0].payload.blockHash, readback: "PASS" };
  const nextRunAt = new Date(Date.now() + 15 * 60_000);
  await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_work_items (dedupe_key,kind,payload,status,priority,checkpoint,next_run_at,completed_at)
     VALUES ($1,'ONCHAIN_NETWORK',$2::jsonb,'DONE',8,$3::jsonb,$4,NOW())
     ON CONFLICT (dedupe_key) DO UPDATE SET kind='ONCHAIN_NETWORK',payload=EXCLUDED.payload,status='DONE',priority=8,checkpoint=EXCLUDED.checkpoint,next_run_at=EXCLUDED.next_run_at,last_error=NULL,completed_at=NOW(),updated_at=NOW()`,
    `ONCHAIN_NETWORK:${sourceConfig.networkId}`, JSON.stringify({ networkId: sourceConfig.networkId }), JSON.stringify(checkpoint), nextRunAt,
  );
  return { checkpoint, nextRunAt, ordinaryWorker: "crypto_work_items" };
}

async function deriveAnalytics(assetId: string): Promise<number> {
  const rows=await prisma.$queryRawUnsafe<Array<{date:Date;close:string}>>(`SELECT c.open_time date,c.close::text close FROM crypto_candles c JOIN crypto_markets m ON m.id=c.market_id
    WHERE m.base_asset_id=$1 AND c.interval='1d' ORDER BY c.open_time`,assetId);
  if(rows.length<30) return 0; const values=rows.map(r=>Number(r.close)); const asOf=rows.at(-1)!.date; const metrics:Array<[string,string,number|null,string]>=[];
  const ret=(days:number)=>values.length>days ? values.at(-1)!/values[values.length-1-days]-1 : null;
  for(const [name,days] of [["RETURN_1D",1],["RETURN_7D",7],["RETURN_1M",30],["RETURN_3M",90],["RETURN_1Y",365]] as const) metrics.push([name,`${days}D`,ret(days),"CLOSE_TO_CLOSE_RETURN"]);
  const year=asOf.getUTCFullYear(),yearIndex=rows.findIndex(r=>r.date.getUTCFullYear()===year);metrics.push(["RETURN_YTD","YTD",yearIndex>=0?values.at(-1)!/values[yearIndex]-1:null,"FIRST_AVAILABLE_CLOSE_OF_YEAR_TO_LATEST"]);
  const daily=values.slice(1).map((v,i)=>Math.log(v/values[i])); for(const days of [30,90,365]){if(daily.length>=days){const x=daily.slice(-days);const mean=x.reduce((a,b)=>a+b,0)/x.length;const sd=Math.sqrt(x.reduce((a,b)=>a+(b-mean)**2,0)/(x.length-1))*Math.sqrt(365);metrics.push([`VOLATILITY_${days===365?"1Y":`${days}D`}`,`${days}D`,sd,"ANNUALIZED_LOG_RETURN_STDDEV_365"]);}}
  const oneYear=values.slice(-366);let peak=oneYear[0],maxDd=0;for(const v of oneYear){peak=Math.max(peak,v);maxDd=Math.min(maxDd,v/peak-1);}metrics.push(["MAX_DRAWDOWN_1Y","1Y",maxDd,"PEAK_TO_TROUGH_CLOSE"]);
  const ath=Math.max(...values),athIndex=values.indexOf(ath);metrics.push(["ALL_TIME_HIGH","ALL",ath,"MAX_CANONICAL_DAILY_CLOSE"],["DRAWDOWN_FROM_ATH","ALL",values.at(-1)!/ath-1,"LATEST_CLOSE_VS_ATH"]);
  for(const [metric,period,value,method] of metrics) await prisma.$executeRawUnsafe(`INSERT INTO crypto_analytics (asset_id,metric,period,as_of_date,value,calculation_method,source)
    VALUES ($1,$2,$3,$4,$5::decimal,$6,'DERIVED_FROM_CANONICAL_CRYPTO_HISTORY') ON CONFLICT (asset_id,metric,period,as_of_date) DO UPDATE SET value=EXCLUDED.value,calculation_method=EXCLUDED.calculation_method,updated_at=NOW()`,assetId,metric,period,asOf,value,method);
  await prisma.$executeRawUnsafe(`INSERT INTO crypto_analytics (asset_id,metric,period,as_of_date,value,calculation_method,source) VALUES ($1,'ATH_DATE','ALL',$2,NULL,$3,'DERIVED_FROM_CANONICAL_CRYPTO_HISTORY') ON CONFLICT DO NOTHING`,assetId,rows[athIndex].date,"DATE_OF_MAX_CANONICAL_DAILY_CLOSE");
  return metrics.length+1;
}

async function canary(c: Config): Promise<Record<string,unknown>> {
  if(!await acquireWriterLock(c.writer.singleWriterLock)) throw new Error("CRYPTO_SINGLE_WRITER_BUSY");
  try {
  const assets=["btc","eth","sol"]; const results:Record<string,unknown>={};
  for(const assetId of assets){const market=c.productionMarkets.find(m=>m[1]==="binance"&&m[2]===assetId);if(!market) throw new Error(`CANARY_MARKET_MISSING:${assetId}`);
    const workItem={id:"CANARY",dedupe_key:`CANARY:${assetId}`,kind:"CANDLES",payload:{marketId:market[0],symbol:market[4],interval:"1d",providerInterval:"1d",exchangeId:"binance"},attempts:0,max_attempts:1};
    const history=await candle(workItem,c);const snapshot=await metric({...workItem,kind:"SNAPSHOT",payload:{marketId:market[0],symbol:market[4],exchangeId:"binance"}});const analytics=await deriveAnalytics(assetId);results[assetId]={history,snapshot,analytics};}
  const nonMajor=c.productionMarkets.find(m=>m[1]==="binance"&&m[2]==="doge");if(nonMajor) await metric({id:"CANARY",dedupe_key:"CANARY:doge",kind:"SNAPSHOT",payload:{marketId:nonMajor[0],symbol:nonMajor[4],exchangeId:"binance"},attempts:0,max_attempts:1});
  results.marketCapSupply=await capSupply(c); return results;
  } finally { await releaseWriterLock(c.writer.singleWriterLock); }
}

async function completeP0(c:Config):Promise<Record<string,unknown>>{
  if(!await acquireWriterLock(c.writer.singleWriterLock))throw new Error("CRYPTO_SINGLE_WRITER_BUSY");
  const result:{binance:number;coinbase:number;analytics:number;capSupply:unknown}={binance:0,coinbase:0,analytics:0,capSupply:null};
  try{for(const market of c.productionMarkets.filter(m=>m[1]==="binance")){const item:Work={id:"P0",dedupe_key:`P0:${market[0]}`,kind:"CANDLES",payload:{marketId:market[0],symbol:market[4],interval:"1d",providerInterval:"1d",exchangeId:"binance"},attempts:0,max_attempts:1};await candle(item,c);await metric({...item,kind:"SNAPSHOT"});result.analytics+=await deriveAnalytics(market[2]);result.binance++;}
    for(const market of c.productionMarkets.filter(m=>m[1]==="coinbase")){const item:Work={id:"P0",dedupe_key:`P0:${market[0]}`,kind:"CANDLES",payload:{marketId:market[0],symbol:market[4],interval:"1d",providerInterval:"1d",exchangeId:"coinbase"},attempts:0,max_attempts:1};await candle(item,c);await metric({...item,kind:"SNAPSHOT"});result.coinbase++;}
    result.capSupply=await capSupply(c);return result;
  }finally{await releaseWriterLock(c.writer.singleWriterLock);}
}

async function queueRecoveryCanary(c:Config):Promise<Record<string,unknown>>{
  if(!await acquireWriterLock(c.writer.singleWriterLock))throw new Error("CRYPTO_SINGLE_WRITER_BUSY");
  const output:Record<string,unknown>={history:{},analytics:{},coinbase:{},supplemental:null};
  try{for(const assetId of ["bnb","ada","doge"]){const market=c.productionMarkets.find(m=>m[1]==="binance"&&m[2]===assetId);if(!market)continue;const item:Work={id:"QUEUE_CANARY",dedupe_key:`QUEUE_CANARY:${assetId}`,kind:"CANDLES",payload:{marketId:market[0],symbol:market[4],interval:"1d",providerInterval:"1d",exchangeId:"binance"},attempts:0,max_attempts:1};(output.history as Record<string,unknown>)[assetId]=await candle(item,c);(output.analytics as Record<string,unknown>)[assetId]=await deriveAnalytics(assetId);}
    for(const market of c.productionMarkets.filter(m=>m[1]==="coinbase").slice(0,2)){const item:Work={id:"QUEUE_CANARY",dedupe_key:`QUEUE_CANARY:${market[0]}`,kind:"SNAPSHOT",payload:{marketId:market[0],symbol:market[4],exchangeId:"coinbase"},attempts:0,max_attempts:1};(output.coinbase as Record<string,unknown>)[market[2]]=await metric(item);}
    output.supplemental=await capSupply(c);return output;
  }finally{await releaseWriterLock(c.writer.singleWriterLock);}
}

async function queueHealth():Promise<unknown>{return prisma.$queryRawUnsafe(`SELECT CASE WHEN kind='CANDLES' THEN 'HISTORY' WHEN kind='ANALYTICS' THEN 'ANALYTICS' WHEN kind IN ('LATEST','SNAPSHOT','CAP_SUPPLY','FUNDING_RATE','OPEN_INTEREST') THEN 'LATEST' ELSE 'OTHER' END domain,
  COUNT(*) total,COUNT(*) FILTER(WHERE status IN ('PENDING','RETRY')) pending,COUNT(*) FILTER(WHERE status='RUNNING') running,COUNT(*) FILTER(WHERE status='DONE') succeeded,COUNT(*) FILTER(WHERE status='DEAD') failed,COUNT(*) FILTER(WHERE status='BLOCKED') blocked,MAX(completed_at) last_success FROM crypto_work_items GROUP BY 1 ORDER BY 1`);}

async function onchainRecoveryStatus():Promise<Record<string,unknown>>{
  const metrics=await prisma.$queryRawUnsafe(`SELECT asset_id,COUNT(*)::text rows,COUNT(DISTINCT metric)::text metrics,MAX(observed_at) latest FROM crypto_metrics WHERE market_id='' AND asset_id IN ('btc','eth') AND (source='MEMPOOL_SPACE_PUBLIC_API' OR source='PUBLICNODE_ETHEREUM_MAINNET_RPC') GROUP BY asset_id ORDER BY asset_id`);
  const queue=await prisma.$queryRawUnsafe(`SELECT dedupe_key,status,attempts,max_attempts,checkpoint,last_error,completed_at,next_run_at,updated_at FROM crypto_work_items WHERE kind='ONCHAIN_NETWORK' ORDER BY dedupe_key`);
  const fairness=await prisma.$queryRawUnsafe(`SELECT kind,COUNT(*) FILTER(WHERE status IN ('PENDING','RETRY'))::text pending,COUNT(*) FILTER(WHERE status='RETRY')::text retry,MAX(completed_at) last_run,MIN(next_run_at) FILTER(WHERE status IN ('PENDING','RETRY','DONE')) next_run,MIN(priority) priority FROM crypto_work_items WHERE kind IN ('SNAPSHOT','CANDLES','DEEP_HISTORY','CAP_SUPPLY','FUNDING_RATE','OPEN_INTEREST','ONCHAIN_NETWORK') GROUP BY kind ORDER BY kind`);
  const quality=await prisma.$queryRawUnsafe(`SELECT
    (SELECT COUNT(*)::text FROM (SELECT asset_id,market_id,metric,observed_at,COUNT(*) FROM crypto_metrics WHERE market_id='' AND asset_id IN ('btc','eth') GROUP BY 1,2,3,4 HAVING COUNT(*)>1) d) duplicate_rows,
    (SELECT COUNT(*)::text FROM crypto_metrics WHERE market_id='' AND asset_id IN ('btc','eth') AND observed_at>NOW()+INTERVAL '5 minutes') future_timestamps,
    (SELECT COUNT(*)::text FROM crypto_metrics m LEFT JOIN crypto_assets a ON a.id=m.asset_id WHERE m.market_id='' AND m.asset_id IN ('btc','eth') AND a.id IS NULL) orphan_rows`);
  return {metrics,queue,fairness,quality};
}

async function derivativeIdentityStatus():Promise<Record<string,unknown>>{
  const products=await prisma.$queryRawUnsafe(`SELECT COUNT(*)::text total,COUNT(*) FILTER(WHERE active)::text active,
    COUNT(*) FILTER(WHERE metadata->>'officialSymbol' IS NOT NULL)::text official_symbol,COUNT(*) FILTER(WHERE metadata->>'underlyingAssetId'=base_asset_id)::text underlying,
    COUNT(*) FILTER(WHERE metadata->>'quoteAssetId'=quote_asset_id)::text quote_asset,COUNT(*) FILTER(WHERE metadata->>'settlementAssetId' IS NOT NULL)::text settlement_asset,
    COUNT(*) FILTER(WHERE metadata->>'marginType' IS NOT NULL)::text margin_type,COUNT(*) FILTER(WHERE metadata->>'linearInverse' IS NOT NULL)::text linear_inverse,
    COUNT(*) FILTER(WHERE metadata->>'multiplier' IS NOT NULL)::text multiplier,COUNT(*) FILTER(WHERE metadata->>'tickSize' IS NOT NULL)::text tick_size,
    COUNT(*) FILTER(WHERE metadata->>'tradingStatus' IS NOT NULL)::text trading_status,MIN((metadata->>'evidenceEarliest')::timestamptz) effective_from,MAX((metadata->>'evidenceLatest')::timestamptz) evidence_watermark
    FROM crypto_markets WHERE market_type='PERPETUAL' AND metadata->>'identityStatus'='EXACT_MAPPED'`);
  const series=await prisma.$queryRawUnsafe(`SELECT m.metric,COUNT(DISTINCT m.asset_id)::text assets,COUNT(DISTINCT (m.source,m.payload->>'symbol'))::text series,COUNT(*)::text historical_rows,
    COUNT(*) FILTER(WHERE d.id IS NOT NULL)::text exactly_resolvable_rows,COUNT(*) FILTER(WHERE d.id IS NULL)::text pending_rows
    FROM crypto_metrics m JOIN crypto_markets s ON s.id=m.market_id
    LEFT JOIN crypto_markets d ON d.exchange_id=s.exchange_id AND d.provider_symbol=m.payload->>'symbol' AND d.market_type='PERPETUAL' AND d.base_asset_id=m.asset_id AND d.metadata->>'identityStatus'='EXACT_MAPPED'
    WHERE m.metric IN ('FUNDING_RATE','OPEN_INTEREST') AND m.source='BINANCE_PUBLIC_API' GROUP BY m.metric ORDER BY m.metric`);
  const direct=await prisma.$queryRawUnsafe(`SELECT metric,COUNT(*)::text rows,COUNT(DISTINCT market_id)::text products FROM crypto_metrics m JOIN crypto_markets d ON d.id=m.market_id WHERE d.market_type='PERPETUAL' AND metric IN ('FUNDING_RATE','OPEN_INTEREST') GROUP BY metric ORDER BY metric`);
  const queue=await prisma.$queryRawUnsafe(`SELECT status,attempts,max_attempts,checkpoint,completed_at,next_run_at,last_error FROM crypto_work_items WHERE dedupe_key='DERIVATIVE_IDENTITY:BINANCE'`);
  const quality=await prisma.$queryRawUnsafe(`SELECT
    (SELECT COUNT(*)::text FROM (SELECT exchange_id,provider_symbol,market_type,COUNT(*) FROM crypto_markets WHERE market_type='PERPETUAL' GROUP BY 1,2,3 HAVING COUNT(*)>1) d) duplicate_products,
    (SELECT COUNT(*)::text FROM crypto_markets d LEFT JOIN crypto_assets a ON a.id=d.base_asset_id LEFT JOIN crypto_exchanges e ON e.id=d.exchange_id WHERE d.market_type='PERPETUAL' AND (a.id IS NULL OR e.id IS NULL)) orphan_products,
    (SELECT COUNT(*)::text FROM crypto_markets WHERE market_type='PERPETUAL' AND metadata->>'underlyingAssetId'<>base_asset_id) wrong_underlying,
    (SELECT COUNT(*)::text FROM crypto_markets WHERE market_type='PERPETUAL' AND metadata->>'identityStatus'='IDENTITY_CONFLICT') identity_conflicts`);
  return {products,series,direct,queue,quality};
}

async function incrementalCanary(c:Config):Promise<Record<string,unknown>>{
  if(!await acquireWriterLock(c.writer.singleWriterLock))throw new Error("CRYPTO_SINGLE_WRITER_BUSY");
  let eth:Record<string,unknown>;
  try{eth=await candle({id:"CANARY",dedupe_key:"CANARY:coinbase-eth",kind:"CANDLES",payload:{marketId:"coinbase-eth-usd-spot",symbol:"ETH-USD",interval:"1d",providerInterval:"1d",exchangeId:"coinbase"},attempts:0,max_attempts:1},c);
    await prisma.$executeRawUnsafe(`UPDATE crypto_work_items SET status='DONE',attempts=0,last_error=NULL,checkpoint=$1::jsonb,completed_at=NOW(),next_run_at=$2,updated_at=NOW() WHERE dedupe_key='CANDLES:coinbase-eth-usd-spot:1d'`,JSON.stringify(eth),eth.nextEligibleAt instanceof Date?eth.nextEligibleAt:new Date());
  }finally{await releaseWriterLock(c.writer.singleWriterLock);}
  const universe=await work(c);return {eth,universe};
}

async function updateCoverage(marketId: string, capability: string, latest: Date | null, rows: number, status: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO crypto_coverage (asset_id,exchange_id,capability,status,provider,latest_at,freshness_seconds,row_count,quality_status,details,checked_at)
     SELECT base_asset_id,exchange_id,$2,$3,$4,$5,CASE WHEN $5::timestamptz IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM NOW()-$5::timestamptz)::int END,$6,
     CASE WHEN $3='AVAILABLE' THEN 'PASS' ELSE 'PENDING' END,$7::jsonb,NOW() FROM crypto_markets WHERE id=$1
     ON CONFLICT (asset_id,exchange_id,capability) DO UPDATE SET status=EXCLUDED.status,provider=EXCLUDED.provider,
     earliest_at=COALESCE(crypto_coverage.earliest_at,EXCLUDED.latest_at),latest_at=GREATEST(crypto_coverage.latest_at,EXCLUDED.latest_at),
     freshness_seconds=EXCLUDED.freshness_seconds,row_count=crypto_coverage.row_count+EXCLUDED.row_count,
     quality_status=EXCLUDED.quality_status,details=EXCLUDED.details,checked_at=NOW()`,
    marketId, capability, status, source, latest, rows, JSON.stringify({ marketId }),
  );
}

async function work(c: Config, onlyKind: string | null = null): Promise<Record<string, number>> {
  if (!await acquireWriterLock(c.writer.singleWriterLock)) return { processed: 0, failed: 0, skipped: 1 };
  let processed = 0; let failed = 0;
  try {
    const items = await prisma.$queryRawUnsafe<Work[]>(
      `WITH ranked AS (SELECT id,dedupe_key,kind,payload,attempts,max_attempts,priority,next_run_at,
       CASE WHEN kind IN ('CANDLES','DEEP_HISTORY') THEN 'HISTORY' WHEN kind='ANALYTICS' THEN 'ANALYTICS' WHEN kind='ONCHAIN_NETWORK' THEN 'ONCHAIN' ELSE 'OTHER' END domain,
       ROW_NUMBER() OVER(PARTITION BY CASE WHEN kind IN ('CANDLES','DEEP_HISTORY') THEN 'HISTORY' WHEN kind='ANALYTICS' THEN 'ANALYTICS' WHEN kind='ONCHAIN_NETWORK' THEN 'ONCHAIN' ELSE 'OTHER' END ORDER BY priority,next_run_at) rn
       FROM crypto_work_items WHERE status IN ('PENDING','RETRY') AND next_run_at<=NOW() AND ($2::text IS NULL OR kind=$2))
       SELECT id::text,dedupe_key,kind,payload,attempts,max_attempts FROM ranked WHERE rn<=4 ORDER BY rn,domain LIMIT $1`, c.writer.maxWorkItemsPerRun, onlyKind,
    );
    for (const [index, item] of items.entries()) {
      await publishWorkStatus(c, item, "RUNNING", index, items.length);
      await prisma.$executeRawUnsafe("UPDATE crypto_work_items SET status='RUNNING',attempts=attempts+1,updated_at=NOW() WHERE id=$1::uuid", item.id);
      try {
        const result = item.kind === "CANDLES" ? await candle(item, c) : item.kind === "DEEP_HISTORY" ? await deepHistory(item, c) : item.kind === "CAP_SUPPLY" ? await capSupply(c) : item.kind === "ONCHAIN_NETWORK" ? await onchainNetwork(c, item) : item.kind === "DERIVATIVE_IDENTITY" ? await resolveDerivativeIdentities() : item.kind === "DERIVATIVE_VENUE_MARKET_DATA" ? await runDerivativeVenueMarketData(prisma,String(item.payload.venue)) : item.kind === "DERIVATIVE_TRADER_INTELLIGENCE" ? await runTraderIntelligence(prisma) : item.kind === "PUBLIC_MESH_SOURCE" ? await runPublicMeshSource(prisma, await loadPublicMesh(), String(item.payload.sourceId)) : item.kind === "CRYPTO_PUBLIC_EXPANSION" ? await runPublicDepthExpansion(prisma, await loadPublicDepthExpansion(), String(item.payload.layerId)) : item.kind === "ANALYTICS" ? {inserted:await deriveAnalytics(String(item.payload.assetId))} : await metric(item);
        const continuation = item.kind === "CANDLES" ? Number(result.rows) === 500 : (item.kind === "DEEP_HISTORY" || item.kind === "CRYPTO_PUBLIC_EXPANSION") && Boolean(result.continuation);
        await prisma.$executeRawUnsafe(
          "UPDATE crypto_work_items SET status=$2,attempts=CASE WHEN kind IN ('ONCHAIN_NETWORK','DERIVATIVE_IDENTITY','DERIVATIVE_VENUE_MARKET_DATA','DERIVATIVE_TRADER_INTELLIGENCE') THEN 0 ELSE attempts END,next_run_at=CASE WHEN $2='PENDING' THEN NOW() WHEN kind IN ('ONCHAIN_NETWORK','DERIVATIVE_IDENTITY','DERIVATIVE_VENUE_MARKET_DATA','DERIVATIVE_TRADER_INTELLIGENCE') THEN NOW()+INTERVAL '15 minutes' ELSE next_run_at END,checkpoint=$3::jsonb,last_error=NULL,completed_at=CASE WHEN $2='DONE' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$1::uuid",
          item.id, continuation ? "PENDING" : "DONE", JSON.stringify(result),
        );
        processed++;
        const rows = Number(result.rows ?? result.inserted ?? 0);
        await publishWorkStatus(c, item, "RUNNING", index + 1, items.length, `${taskName(item.kind)}: ${item.dedupe_key} checkpoint completed; +${rows} rows; ${index + 1}/${items.length} bounded items processed`);
      } catch (error) {
        const attempts = item.attempts + 1; const dead = attempts >= item.max_attempts;
        const delay = Math.min(3600, c.writer.retryBaseSeconds * 2 ** Math.min(attempts, 7));
        await prisma.$executeRawUnsafe(
          "UPDATE crypto_work_items SET status=$2,last_error=$3,next_run_at=NOW()+($4*INTERVAL '1 second'),updated_at=NOW() WHERE id=$1::uuid",
          item.id, dead ? "DEAD" : "RETRY", error instanceof Error ? error.message : String(error), delay,
        );
        failed++;
        await publishWorkStatus(c, item, "BLOCKED", index, items.length, undefined, error instanceof Error ? error.message : String(error));
      }
    }
    return { processed, failed, skipped: 0 };
  } finally {
    await releaseWriterLock(c.writer.singleWriterLock);
  }
}

async function validate(c: Config): Promise<Record<string, unknown>> {
  const registry = await prisma.$queryRawUnsafe<Array<{ networks: bigint; assets: bigint; exchanges: bigint; markets: bigint }>>(
    "SELECT (SELECT COUNT(*) FROM crypto_networks) networks,(SELECT COUNT(*) FROM crypto_assets) assets,(SELECT COUNT(*) FROM crypto_exchanges) exchanges,(SELECT COUNT(*) FROM crypto_markets) markets",
  );
  const missing = await prisma.$queryRawUnsafe<Array<{ asset_id: string; capability: string }>>(
    `SELECT a.id asset_id,c.capability FROM crypto_assets a CROSS JOIN unnest($1::text[]) c(capability)
     LEFT JOIN crypto_coverage x ON x.asset_id=a.id AND x.capability=c.capability WHERE a.active AND x.asset_id IS NULL ORDER BY a.id,c.capability`, c.capabilities,
  );
  return { registry: registry[0], missingCount: missing.length, missing: missing.slice(0, 100), status: missing.length ? "PARTIAL" : "PASS" };
}

async function main(): Promise<void> {
  const c = await config(); const args = new Set(process.argv.slice(2)); const all = args.size === 0 || args.has("--all");
  await publishSchedulerStatus("RUNNING");
  const output: Record<string, unknown> = { pipeline: "GLOBAL_CRYPTO", service: "smartfund-v2" };
  if (all || args.has("--bootstrap")) { await bootstrap(c); output.bootstrap = "OK"; }
  if (all || args.has("--enqueue")) output.enqueued = await enqueue(c);
  if (all || args.has("--work")) output.work = await work(c);
  if (args.has("--onchain-work")) output.onchainWork = await work(c, "ONCHAIN_NETWORK");
  if (args.has("--derivative-identity")) output.derivativeIdentity = await resolveDerivativeIdentities();
  if (args.has("--canary")) output.canary = await canary(c);
  if (all || args.has("--complete-p0")) output.completion = await completeP0(c);
  if (all || args.has("--validate")) output.validation = await validate(c);
  if (args.has("--queue-health")) output.queueHealth = await queueHealth();
  if (args.has("--onchain-status")) output.onchainStatus = await onchainRecoveryStatus();
  if (args.has("--derivative-status")) output.derivativeStatus = await derivativeIdentityStatus();
  if (args.has("--queue-recovery-canary")) output.queueRecoveryCanary = await queueRecoveryCanary(c);
  if (args.has("--incremental-canary")) output.incrementalCanary = await incrementalCanary(c);
  if (args.has("--onchain-canary")) output.onchainCanary = await onchainCanary(c);
  if (args.has("--onchain-activate")) output.onchainActivation = await activateOnchainQueue(c);
  if (args.has("--stablecoin-canary")) output.stablecoinCanary = await deriveStablecoinMetrics();
  if (args.has("--ethereum-canary")) output.ethereumCanary = await ethereumCanary(c);
  console.log(JSON.stringify(output, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
}

main().catch(async error => {
  const manifestText = await readFile("runtime/crypto/completion-manifest.json", "utf8").catch(() => "{}");
  const manifest = JSON.parse(manifestText.replace(/^\uFEFF/, "")) as { consecutiveFailures?: number };
  const failures = Number(manifest.consecutiveFailures ?? 0) + 1;
  const delay = Math.min(900, Math.max(30, 2 ** Math.min(failures, 9) * 15));
  const blocker = error instanceof Error ? error.message : String(error);
  await publishSchedulerStatus("SCHEDULED_WAIT", new Date(Date.now() + delay * 1000).toISOString(), blocker).catch(() => undefined);
  console.error(error); process.exitCode = 1;
}).finally(() => prisma.$disconnect());
