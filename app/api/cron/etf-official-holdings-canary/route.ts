// Temporary, single-ticker production canary for the 331-ETF browser-based adapters. Exists only to
// prove puppeteer-core + @sparticuz/chromium actually launch inside Vercel's serverless runtime — a
// full-puppeteer success on a local desktop machine proves nothing about that. Not part of the normal
// pipeline (the real route has no single-ticker override by design, to keep its checkpoint semantics
// simple); this file should be deleted once the canary has run.
import { prisma } from "@/lib/prisma";
import { upsertSnapshot, type QueryFn } from "@/lib/etf-holdings-engine/storage";
import { syncOfficialSnapshotToHoldings } from "@/lib/etf-holdings-engine/syncToHoldings";
import { JpmorganOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/jpmorgan";
import { AbOfficialPcfAdapter } from "@/lib/etf-holdings-engine/adapters/ab";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const ADAPTERS = { "00401A": JpmorganOfficialPcfAdapter, "00404A": AbOfficialPcfAdapter } as const;

export async function GET(request: Request) {
  const secret = process.env.CANARY_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const ticker = (new URL(request.url).searchParams.get("ticker") ?? "00401A") as keyof typeof ADAPTERS;
  const adapter = ADAPTERS[ticker];
  if (!adapter) return Response.json({ ok: false, error: "unsupported canary ticker" }, { status: 400 });

  const query: QueryFn = async (sql, params) => prisma.$queryRawUnsafe(sql, ...params);
  try {
    const snap = await adapter.fetchSnapshot(ticker);
    const { snapshotId, wasNew } = await upsertSnapshot(query, snap);
    const sync = await syncOfficialSnapshotToHoldings(query, ticker, { snapshotId });
    return Response.json({
      ok: true, ticker, dataDate: snap.dataDate, positions: snap.positions.length,
      snapshotId, wasNew, syncStatus: sync.status,
    });
  } catch (e) {
    return Response.json({ ok: false, ticker, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
