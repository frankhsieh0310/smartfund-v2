import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const date = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : value ? String(value).slice(0, 10) : null;

export async function GET() {
  const [row] = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT
      (SELECT max(latest_date) FROM stocks WHERE is_active=true) AS stock_date,
      (SELECT max(price_updated_at::date) FROM etfs WHERE is_active=true) AS etf_price_date,
      (SELECT max(date) FROM institutional_daily WHERE market='TWSE') AS institutional_twse_date,
      (SELECT max(date) FROM institutional_daily WHERE market='TPEx') AS institutional_tpex_date,
      (SELECT max(as_of_date) FROM holdings WHERE etf_id IS NOT NULL) AS etf_holdings_date,
      (SELECT max(latest_nav_date) FROM funds WHERE is_active=true) AS fund_nav_date,
      (SELECT max(as_of_date) FROM holdings WHERE fund_id IS NOT NULL) AS fund_holdings_date
  `);
  const data = {
    stockDate: date(row?.stock_date), etfPriceDate: date(row?.etf_price_date),
    institutionalTwseDate: date(row?.institutional_twse_date), institutionalTpexDate: date(row?.institutional_tpex_date),
    etfHoldingsLatestDate: date(row?.etf_holdings_date), fundNavDate: date(row?.fund_nav_date), fundHoldingsDate: date(row?.fund_holdings_date),
  };
  const latestMarket = data.stockDate;
  const status = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value ? (key.startsWith("institutional") && latestMarket && value < latestMarket ? "SOURCE_NOT_UPDATED_YET" : "CURRENT") : "FAILED"]));
  return Response.json({ data, status, lastCheckedAt: new Date().toISOString() }, { headers });
}

export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
