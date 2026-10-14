import { prisma } from "@/lib/prisma";
import { getAuth, invalidateAuth } from "@/lib/services/dataProviders/yahoo/yahooClient";
import { beginRun, finishRun, readCheckpoint } from "@/lib/cloud-ingestion/runContext";

export const MARKETCAP_BATCH_SIZE = 250;
const JOB = "YAHOO_CRYPTO_MARKETCAP";
const CHECKPOINT = "yahoo-crypto-marketcap";

// Fixed time slots retain retry dedupe while allowing multiple slices per day.
// Actions passes run_id (not run_attempt); a re-run of the same invocation stays a no-op.
export function cryptoRunKey(phase: string, now: number, invocationId?: string | null) {
  if (invocationId && !/^[A-Za-z0-9_-]{1,80}$/.test(invocationId)) throw new Error("INVALID_INVOCATION_ID");
  const minutes = phase.startsWith("quote") ? 15 : 30;
  return `yahoo-crypto-${phase}:v2:${invocationId ? `invocation:${invocationId}` : `slot:${Math.floor(now / (minutes * 60_000))}`}`;
}

// The existing scheduler lease table protects checkpoint reads/advances across time-slot
// boundaries and manual calls. Six minutes exceeds the route's hard 280-second lifetime.
export async function withCryptoLease(phase: string, action: (owner: string) => Promise<Response>) {
  const job = `YAHOO_CRYPTO_${phase.toUpperCase()}`;
  const owner = globalThis.crypto.randomUUID();
  const rows = await prisma.$queryRawUnsafe<Array<{ owner: string }>>(
    `INSERT INTO production_scheduler_locks (job_id, owner, expires_at, created_at, updated_at)
     VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '6 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (job_id) DO UPDATE SET owner=EXCLUDED.owner, expires_at=EXCLUDED.expires_at, updated_at=CURRENT_TIMESTAMP
     WHERE production_scheduler_locks.expires_at <= CURRENT_TIMESTAMP RETURNING owner`, job, owner,
  );
  if (!rows.length) return Response.json({ ok: true, task: "yahoo-crypto", phase, skipped: true, reason: "SKIP_LOCKED" });
  try { return await action(owner); }
  finally {
    // Never delete another invocation's lease after timeout/reacquisition.
    await prisma.$executeRawUnsafe("DELETE FROM production_scheduler_locks WHERE job_id=$1 AND owner=$2", job, owner);
  }
}

type Quote = { symbol: string; marketCap?: number; circulatingSupply?: number; regularMarketTime?: number };
export async function fetchMarketcapQuotes(symbols: string[]): Promise<Quote[]> {
  const output: Quote[] = [];
  const deadline = Date.now() + 210_000;
  // Five bounded provider requests at most; never fetch the entire provider universe.
  for (let offset = 0; offset < symbols.length; offset += 50) {
    let received = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Leave time for the existing bounded auth acquisition and the final DB transaction.
      if (Date.now() > deadline - 75_000) throw new Error("YAHOO_MARKETCAP_TIME_BUDGET");
      const auth = await getAuth();
      if (!auth) throw new Error("YAHOO_AUTH_UNAVAILABLE");
      const url = new URL("https://query2.finance.yahoo.com/v7/finance/quote");
      url.searchParams.set("symbols", symbols.slice(offset, offset + 50).join(","));
      url.searchParams.set("crumb", auth.crumb);
      const res = await fetch(url, { headers: { Cookie: auth.cookie, "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401 && attempt === 0) { invalidateAuth(); continue; }
      if (!res.ok) throw new Error(`YAHOO_MARKETCAP_HTTP_${res.status}`);
      const body = await res.json() as { quoteResponse?: { error?: unknown; result?: Quote[] } };
      if (body.quoteResponse?.error || !Array.isArray(body.quoteResponse?.result)) throw new Error("YAHOO_MARKETCAP_INVALID_RESPONSE");
      output.push(...body.quoteResponse.result);
      received = true;
      break;
    }
    if (!received) throw new Error("YAHOO_MARKETCAP_AUTH_FAILED");
  }
  return output;
}

const validNumber = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

export async function runMarketcapSlice(owner: string, invocationId?: string | null) {
  const started = Date.now();
  const runKey = cryptoRunKey("marketcap", started, invocationId);
  const before = await readCheckpoint(CHECKPOINT);
  const { runId, skipped } = await beginRun({ jobName: JOB, provider: "YAHOO_QUOTE", runKey, universeCount: 0, batchSize: MARKETCAP_BATCH_SIZE, checkpointBefore: before });
  if (skipped) return Response.json({ ok: true, task: "yahoo-crypto", phase: "marketcap", skipped: true, runKey });
  try {
    // Keyset pagination over stable DB IDs, independent of Yahoo market-cap ranking.
    // A deleted cursor still works with `id > cursor`. Inserts behind it join next rotation.
    // One lookahead determines the exact end, including universes divisible by 250.
    const selected = await prisma.cryptoMarket.findMany({
      where: { exchangeId: "yahoo", active: true, ...(before?.lastSymbol ? { id: { gt: before.lastSymbol } } : {}) },
      orderBy: { id: "asc" }, take: MARKETCAP_BATCH_SIZE + 1,
      select: { id: true, providerSymbol: true, baseAssetId: true },
    });
    const markets = selected.slice(0, MARKETCAP_BATCH_SIZE);
    const wrapped = selected.length <= MARKETCAP_BATCH_SIZE;
    const quotes = markets.length ? await fetchMarketcapQuotes(markets.map(m => m.providerSymbol)) : [];
    const bySymbol = new Map(quotes.map(q => [q.symbol, q]));
    const failedMarkets: Array<{ id: string; symbol: string; reason: string }> = [];
    const values: Array<{ assetId: string; observedAt: string; marketCap: number | null; circulatingSupply: number | null }> = [];
    for (const m of markets) {
      const q = bySymbol.get(m.providerSymbol);
      const marketCap = validNumber(q?.marketCap), circulatingSupply = validNumber(q?.circulatingSupply);
      const timestamp = validNumber(q?.regularMarketTime);
      if (!q || (marketCap === null && circulatingSupply === null) || !timestamp || timestamp > Date.now() / 1000 + 300) {
        failedMarkets.push({ id: m.id, symbol: m.providerSymbol, reason: !q ? "MISSING_QUOTE" : "INVALID_SUPPLY_OR_TIMESTAMP" });
        continue;
      }
      values.push({ assetId: m.baseAssetId, observedAt: new Date(timestamp * 1000).toISOString(), marketCap, circulatingSupply });
    }
    // Missing/delisted symbols advance with explicit failures (retried next rotation).
    // Transport, authentication and malformed-envelope errors above preserve the cursor.
    const result = await prisma.$transaction(async tx => {
      const held = await tx.$queryRawUnsafe<Array<{ owner: string }>>(
        "SELECT owner FROM production_scheduler_locks WHERE job_id=$1 AND owner=$2 AND expires_at>CURRENT_TIMESTAMP FOR UPDATE", JOB, owner,
      );
      if (!held.length) throw new Error("CRYPTO_LEASE_LOST");
      // Actual Yahoo observation time gives stable idempotency across retry/crash. Preserve
      // other providers on a timestamp collision; never replace newer Yahoo observations.
      const updated = values.length ? await tx.$executeRawUnsafe(
        `WITH incoming AS (
           SELECT DISTINCT ON ("assetId") * FROM jsonb_to_recordset($1::jsonb)
             AS v("assetId" text, "observedAt" timestamptz, "marketCap" numeric, "circulatingSupply" numeric)
           ORDER BY "assetId", "observedAt" DESC
         ) INSERT INTO crypto_market_cap_supply (asset_id, observed_at, market_cap, circulating_supply, source, freshness_status, updated_at)
         SELECT "assetId", "observedAt", "marketCap", "circulatingSupply", 'YAHOO_QUOTE', 'CURRENT', CURRENT_TIMESTAMP FROM incoming v
         WHERE NOT EXISTS (SELECT 1 FROM crypto_market_cap_supply old WHERE old.asset_id=v."assetId"
           AND old.source IN ('YAHOO_QUOTE','YAHOO_SCREENER') AND old.observed_at>=v."observedAt")
         ON CONFLICT (asset_id, observed_at) DO NOTHING`, JSON.stringify(values),
      ) : 0;
      const after = { lastSymbol: wrapped ? null : markets[markets.length - 1].id,
        processed: (before?.processed ?? 0) + markets.length, succeeded: (before?.succeeded ?? 0) + updated,
        failed: failedMarkets.length };
      const details = { provider: "YAHOO_QUOTE", checkpoint_before: before, checkpoint_after: after,
        runtime_ms: Date.now() - started, wrapped, processed: markets.length, updated,
        staleSkipped: values.length - updated, failedMarkets, batchSize: MARKETCAP_BATCH_SIZE };
      await tx.$executeRawUnsafe(
        `INSERT INTO production_scheduler_checkpoints (checkpoint_key,job_id,run_id,last_symbol,processed,succeeded,failed,started_at,updated_at,run_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'ROLLING')
         ON CONFLICT (checkpoint_key) DO UPDATE SET run_id=EXCLUDED.run_id,last_symbol=EXCLUDED.last_symbol,
         processed=EXCLUDED.processed,succeeded=EXCLUDED.succeeded,failed=EXCLUDED.failed,updated_at=CURRENT_TIMESTAMP`,
        CHECKPOINT, JOB, runId, after.lastSymbol, after.processed, after.succeeded, after.failed,
      );
      await tx.$executeRawUnsafe(
        `UPDATE production_scheduler_runs SET status=$2,completed_at=CURRENT_TIMESTAMP,attempted=$3,completed=$4,
         updated=$4,failed=$5,retryable_failure_count=$5,details=$6::jsonb WHERE id=$1`,
        runId, failedMarkets.length ? "PARTIAL" : "COMPLETED", markets.length, updated, failedMarkets.length, JSON.stringify(details),
      );
      return details;
    }, { timeout: 30_000 });
    return Response.json({ ok: true, task: "yahoo-crypto", phase: "marketcap", runId, runKey, ...result });
  } catch (error) {
    await finishRun(runId, JOB, "YAHOO_QUOTE", started, { status: "FAILED", attempted: 0, completed: 0, inserted: 0, updated: 0, failed: 1, retryableFailures: 1, checkpointAfter: before, error: (error as Error).message });
    return Response.json({ ok: false, task: "yahoo-crypto", phase: "marketcap", runId, error: (error as Error).message }, { status: 500 });
  }
}
