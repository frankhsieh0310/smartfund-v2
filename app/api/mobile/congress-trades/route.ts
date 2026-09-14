import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

// Real US House Periodic Transaction Report (PTR) data — official source: disclosures-clerk.house.gov.
// This is disclosure data, not real-time trading: transaction_date and disclosure_date are always
// kept separate, and every response below carries the same fixed disclaimer the App/Web copy uses.
// Senate is not yet ingested (P1 — no equivalent no-login bulk source was found). Shared by both
// the SmartMatch App and Web — neither computes or fetches this on its own.
const DISCLOSURE_NOTE = "此資料為依法揭露資訊，揭露日可能晚於實際交易日。";

type Row = {
  id: string; person_name: string; chamber: string; state: string | null; party: string | null;
  asset_name: string; ticker: string | null; transaction_type: string; transaction_date: Date; disclosure_date: Date;
  amount_min: string | null; amount_max: string | null; owner: string | null; source_url: string; mapping_method: string | null;
};

async function fetchRows(where: string, params: unknown[]): Promise<Row[]> {
  return prisma.$queryRawUnsafe<Row[]>(
    `SELECT t.id, p.name AS person_name, p.chamber, p.state, p.party,
            t.asset_name, t.ticker, t.transaction_type, t.transaction_date, t.disclosure_date,
            t.amount_min, t.amount_max, t.owner, t.source_url, t.mapping_method
     FROM political_transactions t
     JOIN political_persons p ON p.id = t.person_id
     ${where}
     ORDER BY t.disclosure_date DESC, t.transaction_date DESC
     LIMIT 100`,
    ...params
  );
}

function serialize(rows: Row[]) {
  return rows.map((r) => ({
    id: r.id, person_name: r.person_name, chamber: r.chamber, state: r.state, party: r.party,
    asset_name: r.asset_name, ticker: r.ticker, transaction_type: r.transaction_type,
    transaction_date: r.transaction_date.toISOString().slice(0, 10),
    disclosure_date: r.disclosure_date.toISOString().slice(0, 10),
    amount_min: r.amount_min !== null ? Number(r.amount_min) : null,
    amount_max: r.amount_max !== null ? Number(r.amount_max) : null,
    owner: r.owner, source_url: r.source_url, mapped: r.mapping_method !== "UNMAPPED" && r.mapping_method !== null,
  }));
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const ticker = q.get("ticker")?.toUpperCase() ?? null;
  const person = q.get("person") ?? null;
  const scope = q.get("scope"); // latest | buys | sells

  if (ticker) {
    const rows = await fetchRows(`WHERE t.ticker = $1`, [ticker]);
    return Response.json({ data: { ticker, disclosures: serialize(rows) }, meta: { source: "US House Clerk PTR filings", note: DISCLOSURE_NOTE } }, { headers });
  }
  if (person) {
    const rows = await fetchRows(`WHERE p.name ILIKE $1`, [`%${person}%`]);
    return Response.json({ data: { person, disclosures: serialize(rows) }, meta: { source: "US House Clerk PTR filings", note: DISCLOSURE_NOTE } }, { headers });
  }

  const [latest, buys, sells, coverage] = await Promise.all([
    fetchRows("", []),
    fetchRows(`WHERE t.transaction_type = 'P'`, []),
    fetchRows(`WHERE t.transaction_type = 'S'`, []),
    prisma.$queryRawUnsafe<Array<{ people: bigint; transactions: bigint; latest_disclosure: Date | null }>>(
      `SELECT count(DISTINCT person_id) AS people, count(*) AS transactions, max(disclosure_date) AS latest_disclosure FROM political_transactions`
    ),
  ]);
  const scoped = scope === "buys" ? buys : scope === "sells" ? sells : latest;

  return Response.json({
    data: {
      latest_disclosures: serialize(scoped).slice(0, 30),
      recent_buys: serialize(buys).slice(0, 20),
      recent_sells: serialize(sells).slice(0, 20),
      people_covered: Number(coverage[0]?.people ?? 0),
      transactions_covered: Number(coverage[0]?.transactions ?? 0),
      latest_disclosure_date: coverage[0]?.latest_disclosure ? coverage[0].latest_disclosure.toISOString().slice(0, 10) : null,
    },
    meta: { source: "US House Clerk PTR filings (House only — Senate not yet ingested)", note: DISCLOSURE_NOTE },
  }, { headers });
}

export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
