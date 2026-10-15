// 債券反查 (item 2, ETF-side only). Given a bond's CUSIP or ISIN, returns which ETFs disclose
// holding it, using the `holdings` table's BlackRock-official-CSV-sourced bond rows (confirmed
// this round: 3,075,903 of 3,715,741 `holdings` rows have a real, populated cusip; 56,910 distinct
// ISINs) -- a genuinely joinable identifier space, unlike etf_holdings' BOND rows (which store an
// ISIN string in the `ticker` column as an undocumented convention) or the MoneyDJ fund-side bond
// disclosures (pure free text, no identifier at all -- NOT covered by this endpoint, disclosed).
//
// Only the LATEST disclosed snapshot per ETF is returned (same "latest per product" pattern as
// lib/data-platform/holdingsHistory.ts), never a stale historical row mixed in with current ones.
import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const CUSIP_RE = /^[0-9A-Z]{9}$/;
const ISIN_RE = /^[A-Z]{2}[0-9A-Z]{9}[0-9]$/;

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const raw = (q.get("cusip") ?? q.get("isin") ?? "").trim().toUpperCase();
  if (!raw) return Response.json({ ok: false, error: "MISSING_CUSIP_OR_ISIN" }, { status: 400, headers });
  const isCusip = CUSIP_RE.test(raw);
  const isIsin = ISIN_RE.test(raw);
  if (!isCusip && !isIsin) return Response.json({ ok: false, error: "INVALID_FORMAT", hint: "cusip must be 9 alphanumeric chars, isin must be 2 letters + 9 alphanumeric + 1 digit" }, { status: 400, headers });

  const rows = await prisma.$queryRawUnsafe<
    { etf_id: string; code: string; name: string; holding_name: string; weight: string; as_of_date: string | null; source: string | null }[]
  >(
    `WITH matched AS (
       SELECT h.etf_id, h.holding_name, h.weight, h.as_of_date, h.source,
              ROW_NUMBER() OVER (PARTITION BY h.etf_id ORDER BY h.as_of_date DESC NULLS LAST) rn
         FROM holdings h
        WHERE h.asset_type = 'ETF' AND h.etf_id IS NOT NULL AND ${isCusip ? "h.cusip = $1" : "h.isin = $1"}
     )
     SELECT m.etf_id, e.code, e.name, m.holding_name, m.weight::text AS weight, m.as_of_date::text, m.source
       FROM matched m JOIN etfs e ON e.id = m.etf_id
      WHERE m.rn = 1 AND e.is_active
      ORDER BY m.weight DESC`,
    raw,
  );

  return Response.json({
    ok: true,
    query: { value: raw, matchedBy: isCusip ? "CUSIP" : "ISIN" },
    total: rows.length,
    generated_at: new Date().toISOString(),
    scopeNote: "ETF disclosures only (BlackRock-CSV-sourced bond holdings). Fund-side bond disclosures (MoneyDJ) have no identifier and are not covered.",
    results: rows.map((r) => ({
      etfId: r.etf_id, code: r.code, name: r.name, holdingName: r.holding_name,
      weightPct: Number(r.weight), asOfDate: r.as_of_date, source: r.source,
    })),
  }, { headers });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers });
}
