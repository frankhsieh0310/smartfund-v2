// Function 2 mobile API — searchable list of ETFs that have at least one official daily holdings
// snapshot. Read-only; never triggers a fetch. Used by SmartMatch Mobile's 「每日持股變化」 ETF
// search/select control. Defaults the app's own UI filter to isActive, but every ETF with real data
// is returned so users can search beyond the default.
import { prisma } from "@/lib/prisma";
import { isActiveEtfCode } from "@/lib/etf-holdings-engine/activeEtfCodes";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const search = q.get("q")?.trim().toUpperCase() ?? "";

  const rows = await prisma.$queryRawUnsafe<
    Array<{ etf_code: string; issuer: string; snapshot_count: bigint; latest_data_date: string }>
  >(
    `SELECT etf_code, MAX(issuer) AS issuer, COUNT(*) AS snapshot_count,
            to_char(MAX(data_date), 'YYYY-MM-DD') AS latest_data_date
       FROM etf_official_daily_snapshots
      GROUP BY etf_code
      ORDER BY etf_code`,
  );

  const codes = rows.map((r) => r.etf_code);
  const names = codes.length
    ? await prisma.$queryRawUnsafe<Array<{ code: string; name: string }>>(
        `SELECT code, name FROM etfs WHERE code = ANY($1::text[])`,
        codes,
      )
    : [];
  const nameByCode = new Map(names.map((n) => [n.code, n.name]));

  const list = rows
    .map((r) => ({
      code: r.etf_code,
      name: nameByCode.get(r.etf_code) ?? null,
      issuer: r.issuer,
      isActive: isActiveEtfCode(r.etf_code),
      snapshotCount: Number(r.snapshot_count),
      latestDataDate: r.latest_data_date,
      diffAvailable: Number(r.snapshot_count) >= 2,
    }))
    .filter((e) => !search || e.code.includes(search) || (e.name?.includes(search) ?? false));

  return Response.json({ data: list, meta: { total: list.length } }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
