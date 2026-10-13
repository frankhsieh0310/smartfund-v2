import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const COVERAGE_NOTE = "目前優先涵蓋大型美股，資料範圍持續擴充中。";

// Real SEC Form 4 insider-ownership data (insider_ownership_transactions), canonically mapped via
// CIK -> security_id (never a ticker-string guess). Shared by App + Web — neither computes this on
// its own. Every SEC Form 4 transaction code below is real; NOT every code means "bought" or "sold"
// — only P (open-market purchase) and S (open-market sale) are ever labeled that way. Everything
// else (option exercise, grant/award, gift, tax-withholding, other) is bucketed separately so a
// stock grant or a tax-withholding disposition is never shown as a real market buy/sell signal.
const CODE_MAP: Record<string, { bucket: string; zh: string }> = {
  P: { bucket: "OPEN_MARKET_PURCHASE", zh: "公開市場買進" },
  S: { bucket: "OPEN_MARKET_SALE", zh: "公開市場賣出" },
  M: { bucket: "OPTION_EXERCISE", zh: "衍生證券轉換/行使" },
  C: { bucket: "OPTION_EXERCISE", zh: "衍生證券轉換/行使" },
  X: { bucket: "OPTION_EXERCISE", zh: "衍生證券轉換/行使" },
  A: { bucket: "GRANT_AWARD", zh: "獎酬/授予取得" },
  G: { bucket: "GIFT", zh: "贈與" },
  F: { bucket: "OTHER", zh: "繳稅／代扣股份" },
  D: { bucket: "OTHER", zh: "處分予發行人" },
  J: { bucket: "OTHER", zh: "其他（詳見申報附註）" },
  I: { bucket: "OTHER", zh: "自由裁量交易" },
};
const bucketOf = (code: string) => CODE_MAP[code]?.bucket ?? "OTHER";

type Row = {
  id: string; insider: string; role: string | null; ticker: string; company: string;
  transaction_type: string; shares: string; price: string | null; transaction_date: Date; filing_id: string; cik: string | null;
};

async function fetchRows(where: string, params: unknown[]): Promise<Row[]> {
  return prisma.$queryRawUnsafe<Row[]>(
    `SELECT t.id, t.insider, t.role, s.ticker, s.name AS company,
            t.transaction_type, t.shares, t.price, t.transaction_date, t.filing_id, eig.cik
     FROM insider_ownership_transactions t
     JOIN securities s ON s.id = t.security_id
     LEFT JOIN insider_ownership_eligible_issuers eig ON eig.security_id = t.security_id
     ${where}
     ORDER BY t.transaction_date DESC
     LIMIT 100`,
    ...params
  );
}

function serialize(rows: Row[]) {
  return rows.map((r) => {
    const shares = Number(r.shares);
    const price = r.price !== null ? Number(r.price) : null;
    return {
      id: r.id, person_name: r.insider, title: r.role, ticker: r.ticker, company: r.company,
      transaction_code: r.transaction_type, transaction_type: bucketOf(r.transaction_type),
      transaction_type_zh: CODE_MAP[r.transaction_type]?.zh ?? "其他",
      shares, price, transaction_value: price !== null ? Math.round(shares * price) : null,
      transaction_date: r.transaction_date.toISOString().slice(0, 10),
      // Not captured by this round's ingestion (only transaction_date was parsed from the Form 4
      // XML) — never fabricated. See REMAINING_P1: would require re-parsing each filing's own
      // filing/accepted date, out of scope for this round's "don't re-fetch" instruction.
      filing_date: null as string | null,
      ownership_type: null as string | null,
      source: "SEC EDGAR Form 4",
      source_url: r.cik ? `https://www.sec.gov/Archives/edgar/data/${Number(r.cik)}/${r.filing_id.replaceAll("-", "")}/` : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=4`,
    };
  });
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const ticker = q.get("ticker")?.toUpperCase() ?? null;
  const person = q.get("person") ?? null;
  const company = q.get("company") ?? null;
  const scope = q.get("scope");

  if (ticker) {
    const rows = await fetchRows(`WHERE s.ticker = $1`, [ticker]);
    return Response.json({ data: { ticker, transactions: serialize(rows) }, meta: { source: "SEC EDGAR Form 4 (canonical CIK mapping)", note: COVERAGE_NOTE } }, { headers });
  }
  if (person) {
    const rows = await fetchRows(`WHERE t.insider ILIKE $1`, [`%${person}%`]);
    return Response.json({ data: { person, transactions: serialize(rows) }, meta: { source: "SEC EDGAR Form 4", note: COVERAGE_NOTE } }, { headers });
  }
  if (company) {
    const rows = await fetchRows(`WHERE s.name ILIKE $1`, [`%${company}%`]);
    return Response.json({ data: { company, transactions: serialize(rows) }, meta: { source: "SEC EDGAR Form 4", note: COVERAGE_NOTE } }, { headers });
  }

  const [latest, purchases, sales, coverage] = await Promise.all([
    fetchRows("", []),
    fetchRows(`WHERE t.transaction_type = 'P'`, []),
    fetchRows(`WHERE t.transaction_type = 'S'`, []),
    prisma.$queryRawUnsafe<Array<{ issuers: bigint; transactions: bigint; last_30d: bigint }>>(
      `SELECT count(DISTINCT security_id) AS issuers, count(*) AS transactions,
              count(*) FILTER (WHERE transaction_date >= now() - interval '30 days') AS last_30d
       FROM insider_ownership_transactions`
    ),
  ]);
  const scoped = scope === "buys" ? purchases : scope === "sells" ? sales : latest;

  return Response.json({
    data: {
      latest_transactions: serialize(scoped).slice(0, 30),
      insider_buys: serialize(purchases).slice(0, 20),
      insider_sells: serialize(sales).slice(0, 20),
      issuers_covered: Number(coverage[0]?.issuers ?? 0),
      transactions_covered: Number(coverage[0]?.transactions ?? 0),
      transactions_last_30d: Number(coverage[0]?.last_30d ?? 0),
    },
    meta: { source: "SEC EDGAR Form 4 (canonical CIK -> security_id mapping)", note: COVERAGE_NOTE },
  }, { headers });
}

export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
