// CANARY — Vercel Spark batch-request probe. NOT part of the real cron ingestion pipeline.
// Local-only proposal file: not committed, not pushed, not deployed by this session.
//
// Safety invariants, enforced by what this file does NOT do:
// - No `import { prisma }` / no Prisma Client at all.
// - No read of DATABASE_URL, DIRECT_URL, or any other DB connection env var.
// - No write of any kind — this is a pure outbound-fetch probe that returns its own result.
// - Gated by the same CRON_SECRET bearer check as the real cron routes (lib/cron/authorize.ts),
//   which itself never touches the DB.
//
// Intent: run a bounded number of Yahoo Spark batch requests (<=20 symbols each) from wherever
// this route is actually deployed (Preview, to confirm real Vercel-region behavior before touching
// cloud-etf-price), log HTTP status / timing / returned-symbol-count per call, and stop immediately
// on 401/403/429 — never retrying, never looping past the caller-supplied limits.

import { isAuthorizedCron, unauthorizedCron } from "@/lib/cron/authorize";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_BATCHES = 50; // hard ceiling regardless of what the caller asks for
const MAX_SYMBOLS_PER_BATCH = 20; // Yahoo's own hard limit, confirmed 2026-10-09

type BatchResult = {
  batchIndex: number;
  symbolsRequested: number;
  httpStatus: number | null;
  elapsedMs: number;
  symbolsReturned: number | null;
  error: string | null;
  stoppedReason: "RATE_LIMIT" | "UNAUTHORIZED" | null;
};

export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return unauthorizedCron();

  const url = new URL(request.url);
  const symbolsParam = url.searchParams.get("symbols"); // comma-joined full candidate list
  const requestedBatches = Math.min(MAX_BATCHES, Math.max(1, Number(url.searchParams.get("batches") ?? 5)));

  if (!symbolsParam) {
    return Response.json({ ok: false, error: "symbols query param required (comma-joined tickers)" }, { status: 400 });
  }
  const allSymbols = symbolsParam.split(",").map((s) => s.trim()).filter(Boolean);

  const results: BatchResult[] = [];
  let stoppedEarly = false;

  for (let i = 0; i < requestedBatches; i++) {
    const slice = allSymbols.slice(i * MAX_SYMBOLS_PER_BATCH, (i + 1) * MAX_SYMBOLS_PER_BATCH);
    if (slice.length === 0) break;

    const started = Date.now();
    let httpStatus: number | null = null;
    let symbolsReturned: number | null = null;
    let error: string | null = null;
    let stoppedReason: BatchResult["stoppedReason"] = null;

    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${slice.map(encodeURIComponent).join(",")}&range=5d&interval=1d`,
        { headers: { "User-Agent": "Mozilla/5.0" } },
      );
      httpStatus = res.status;
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        stoppedReason = "RATE_LIMIT";
      } else {
        const json = await res.json();
        symbolsReturned = Array.isArray(json?.spark?.result) ? json.spark.result.length : null;
      }
    } catch (e) {
      error = String(e).slice(0, 300);
    }

    results.push({
      batchIndex: i,
      symbolsRequested: slice.length,
      httpStatus,
      elapsedMs: Date.now() - started,
      symbolsReturned,
      error,
      stoppedReason,
    });

    if (stoppedReason) {
      stoppedEarly = true;
      break;
    }
  }

  return Response.json({
    ok: true,
    note: "CANARY — no DB access, no Prisma, no write of any kind.",
    totalSymbolsAvailable: allSymbols.length,
    batchesRun: results.length,
    stoppedEarly,
    results,
  });
}
