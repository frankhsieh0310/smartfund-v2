// Function 2 mobile API — read-only diff between an ETF's two most recent DIFFERENT official
// dataDate snapshots. Reuses the existing, already-verified diff engine
// (lib/etf-holdings-engine/storage.ts loadFrontendDiff) unchanged — this route only adapts its
// output to the mobile app's contract and handles the "only one snapshot exists yet" state, which
// is normal for the first production batch and must never be presented as a fake diff.
import { prisma } from "@/lib/prisma";
import { loadFrontendDiff, type QueryFn } from "@/lib/etf-holdings-engine/storage";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const code = q.get("code")?.trim().toUpperCase();
  if (!code) return Response.json({ error: "code is required" }, { status: 400, headers });

  const query: QueryFn = async (sql, params) => prisma.$queryRawUnsafe(sql, ...params);

  try {
    const diff = await loadFrontendDiff(query, code);
    const name = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT name FROM etfs WHERE code = $1 LIMIT 1`,
      code,
    );
    return Response.json({
      state: "DIFF_AVAILABLE",
      etfCode: diff.etfCode,
      etfName: name[0]?.name ?? null,
      fromDate: diff.dateFrom,
      toDate: diff.dateTo,
      summary: {
        addedCount: diff.addedCount,
        removedCount: diff.removedCount,
        increasedCount: diff.increasedCount,
        decreasedCount: diff.decreasedCount,
        unchangedCount: diff.unchangedCount,
      },
      positions: diff.changes.map((c) => ({
        securityCode: c.code,
        securityName: c.name,
        action: c.action,
        positionType: c.positionType,
        positionUnit: c.positionUnit,
        previousAmount: c.previousAmount,
        currentAmount: c.currentAmount,
        changeAmount: c.changeAmount,
        changeLots: c.changeLots,
        previousWeight: c.previousWeight,
        currentWeight: c.currentWeight,
      })),
    }, { headers });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith("NOT_ENOUGH_SNAPSHOTS_")) {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ data_date: string; fund_nav: string; outstanding_units: string }>
      >(
        `SELECT data_date::text AS data_date, fund_nav, outstanding_units
           FROM etf_official_daily_snapshots WHERE etf_code = $1
          ORDER BY data_date DESC LIMIT 1`,
        code,
      );
      if (!rows.length) {
        // 200, not 404 — this is a normal, expected read-API state (no snapshot exists yet for this
        // code), not a request error; the mobile client only distinguishes real failures by HTTP status.
        return Response.json({ state: "NOT_FOUND", etfCode: code }, { headers });
      }
      const name = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM etfs WHERE code = $1 LIMIT 1`,
        code,
      );
      return Response.json({
        state: "ONE_SNAPSHOT_ONLY",
        etfCode: code,
        etfName: name[0]?.name ?? null,
        dataDate: rows[0].data_date,
      }, { headers });
    }
    return Response.json({ state: "ERROR", etfCode: code }, { status: 500, headers });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
