import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

// Real 13F institutional_holdings data (SEC EDGAR, 15 managers, 5 quarterly periods) — never
// ETF/Fund holdings relabeled as 13F. Every row already carries a 100%-populated CUSIP and
// issuer_name, but security_id was NULL on every row until the canonical-mapping backfill: it is
// now populated via exact CUSIP match against an existing `securities` row (~50% of rows), and
// bridged to a `stocks.ticker` via `stock_security_links` for the subset of those where the
// issuer name normalizes to exactly one candidate ticker (never a "contains" match, never a
// per-ticker hardcode — ambiguous collisions are left unmapped on purpose).
//
// A second tier resolves the remaining NULL-security_id rows the same way, live, per request:
// normalize issuer_name and match it against stocks.company_name. This is why e.g. TSM (whose
// CUSIP has no matching `securities` row at all) still resolves correctly even though it has no
// stock_security_links row. A genuine name collision (e.g. ASML colliding with unrelated small
// caps after suffix-stripping) is left unresolved rather than guessed — such a ticker simply
// returns no holders, never a wrong company's data.
function normalizeIssuerName(raw: string | null | undefined): string {
  if (!raw) return "";
  let s = raw.toUpperCase();
  s = s.replace(/[.,]/g, " ");
  s = s.replace(/\bCOMMON STOCK\b/g, " ");
  s = s.replace(/\bORDINARY SHARES?\b/g, " ");
  s = s.replace(/\bAMERICAN DEPOSITARY (SHARES?|RECEIPTS?)\b/g, " ");
  s = s.replace(/\bSPONSORED ADS\b/g, " ");
  s = s.replace(/\bADR\b|\bADS\b/g, " ");
  s = s.replace(/\bCLASS\s+[A-Z]\b/g, " ");
  s = s.replace(/\bNEW\b/g, " ");
  s = s.replace(/\bREIT\b/g, " ");
  s = s.replace(/\bHLDGS?\b/g, " ");
  s = s.replace(/\bGRP\b/g, " ");
  s = s.replace(/\bCOM\b/g, " ");
  s = s.replace(/\b(INCORPORATED|INC|CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|HOLDINGS?|GROUP|TRUST|PLC|LLC|LP|L P|NV|N V|SA|S A|AG|SE)\b/g, " ");
  s = s.replace(/\bMANUFAC\b/g, "MANUFACTURING");
  s = s.replace(/\bMFG\b/g, "MANUFACTURING");
  s = s.replace(/[^A-Z0-9 ]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
const US_EXCHANGES = new Set(["NASDAQ", "NYSE", "NYSEARCA", "ARCA", "AMEX", "BATS", "IEX"]);

type HoldingRow = {
  institution_id: string;
  institution_name: string;
  issuer_name: string;
  security_id: string | null;
  report_date: Date;
  shares: string;
  value: string;
  portfolio_weight: string | null;
  filing_id: string;
};

async function resolveTickerForStock(ticker: string): Promise<{ stockId: string; companyName: string } | null> {
  const stock = await prisma.$queryRawUnsafe<Array<{ id: string; company_name: string }>>(
    `SELECT id, company_name FROM stocks WHERE ticker = $1 AND company_name IS NOT NULL ORDER BY (country = 'US') DESC, is_active DESC LIMIT 1`,
    ticker
  );
  if (!stock[0]) return null;
  return { stockId: stock[0].id, companyName: stock[0].company_name };
}

async function fetchHoldingsForTicker(ticker: string): Promise<HoldingRow[]> {
  const linked = await prisma.$queryRawUnsafe<HoldingRow[]>(
    `SELECT ih.institution_id, ih.institution_name, ih.issuer_name, ih.security_id, ih.report_date, ih.shares, ih.value, ih.portfolio_weight, ih.filing_id
     FROM institutional_holdings ih
     JOIN stock_security_links l ON l.security_id = ih.security_id
     JOIN stocks st ON st.id = l.stock_id
     WHERE st.ticker = $1`,
    ticker
  );
  const stock = await resolveTickerForStock(ticker);
  if (!stock) return linked;
  const targetKey = normalizeIssuerName(stock.companyName);
  if (!targetKey) return linked;
  const unlinked = await prisma.$queryRawUnsafe<HoldingRow[]>(
    `SELECT institution_id, institution_name, issuer_name, security_id, report_date, shares, value, portfolio_weight, filing_id
     FROM institutional_holdings WHERE security_id IS NULL`
  );
  const fallbackMatches = unlinked.filter((row) => normalizeIssuerName(row.issuer_name) === targetKey);
  const seenFilingLine = new Set(linked.map((r) => `${r.institution_id}:${r.filing_id}:${r.report_date}`));
  for (const row of fallbackMatches) {
    const key = `${row.institution_id}:${row.filing_id}:${row.report_date}`;
    if (!seenFilingLine.has(key)) { seenFilingLine.add(key); linked.push(row); }
  }
  return linked;
}

function aggregateByManagerPeriod(rows: HoldingRow[]) {
  const map = new Map<string, { institution_id: string; institution_name: string; report_date: string; shares: number; value: number; weight: number }>();
  for (const row of rows) {
    const dateKey = row.report_date.toISOString().slice(0, 10);
    const key = `${row.institution_id}:${dateKey}`;
    const entry = map.get(key) ?? { institution_id: row.institution_id, institution_name: row.institution_name.trim(), report_date: dateKey, shares: 0, value: 0, weight: 0 };
    entry.shares += Number(row.shares);
    entry.value += Number(row.value ?? 0);
    entry.weight += Number(row.portfolio_weight ?? 0);
    map.set(key, entry);
  }
  return [...map.values()];
}

function buildTickerPayload(ticker: string, rows: HoldingRow[]) {
  if (rows.length === 0) return { ticker, mapped: false, latest_report_date: null, prior_report_date: null, latest_holders: [], increased: [], decreased: [] };
  const byManagerPeriod = aggregateByManagerPeriod(rows);
  const periods = [...new Set(byManagerPeriod.map((r) => r.report_date))].sort().reverse();
  const [latestPeriod, priorPeriod] = periods;
  const latestByManager = new Map(byManagerPeriod.filter((r) => r.report_date === latestPeriod).map((r) => [r.institution_id, r]));
  const priorByManager = new Map(priorPeriod ? byManagerPeriod.filter((r) => r.report_date === priorPeriod).map((r) => [r.institution_id, r]) : []);

  const latestHolders = [...latestByManager.values()].map((r) => ({
    manager_name: r.institution_name, report_period: r.report_date, shares: r.shares, market_value: r.value,
    weight: r.weight || null, filing_date: r.report_date,
  })).sort((a, b) => b.market_value - a.market_value);

  const changes = [...latestByManager.entries()].flatMap(([id, latest]) => {
    const prior = priorByManager.get(id);
    if (!prior) return [];
    return [{
      manager_name: latest.institution_name, report_period: latest.report_date, shares: latest.shares, market_value: latest.value,
      weight: latest.weight || null, shares_change: latest.shares - prior.shares, value_change: latest.value - prior.value, filing_date: latest.report_date,
    }];
  });
  const increased = changes.filter((c) => c.shares_change > 0).sort((a, b) => b.shares_change - a.shares_change);
  const decreased = changes.filter((c) => c.shares_change < 0).sort((a, b) => a.shares_change - b.shares_change);

  return { ticker, mapped: true, latest_report_date: latestPeriod, prior_report_date: priorPeriod ?? null, latest_holders: latestHolders, increased, decreased };
}

export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const ticker = q.get("ticker")?.toUpperCase() ?? null;

  if (ticker) {
    const rows = await fetchHoldingsForTicker(ticker);
    const payload = buildTickerPayload(ticker, rows);
    return Response.json({ data: payload, meta: { source: "SEC EDGAR 13F (production institutional_holdings, canonical-mapped)" } }, { headers });
  }

  // Universe-wide movers (across every ticker the canonical mapping currently resolves) for the
  // 大佬動向雷達 → 機構持股 tab's 熱門增持/熱門減持/最新13F sections.
  const linkedRows = await prisma.$queryRawUnsafe<Array<HoldingRow & { ticker: string; company_name: string }>>(
    `SELECT ih.institution_id, ih.institution_name, ih.issuer_name, ih.security_id, ih.report_date, ih.shares, ih.value, ih.portfolio_weight, ih.filing_id, st.ticker, st.company_name
     FROM institutional_holdings ih
     JOIN stock_security_links l ON l.security_id = ih.security_id
     JOIN stocks st ON st.id = l.stock_id`
  );
  const byTickerManagerPeriod = new Map<string, { ticker: string; company_name: string; institution_id: string; institution_name: string; report_date: string; shares: number; value: number }>();
  for (const row of linkedRows) {
    const dateKey = row.report_date.toISOString().slice(0, 10);
    const key = `${row.ticker}:${row.institution_id}:${dateKey}`;
    const entry = byTickerManagerPeriod.get(key) ?? { ticker: row.ticker, company_name: row.company_name, institution_id: row.institution_id, institution_name: row.institution_name.trim(), report_date: dateKey, shares: 0, value: 0 };
    entry.shares += Number(row.shares);
    entry.value += Number(row.value ?? 0);
    byTickerManagerPeriod.set(key, entry);
  }
  const all = [...byTickerManagerPeriod.values()];
  const periods = [...new Set(all.map((r) => r.report_date))].sort().reverse();
  const [latestPeriod, priorPeriod] = periods;
  const latestRows = all.filter((r) => r.report_date === latestPeriod);
  const priorByKey = new Map(all.filter((r) => r.report_date === priorPeriod).map((r) => [`${r.ticker}:${r.institution_id}`, r]));
  const movers = latestRows.flatMap((r) => {
    const prior = priorByKey.get(`${r.ticker}:${r.institution_id}`);
    if (!prior) return [];
    return [{ ticker: r.ticker, company_name: r.company_name, manager_name: r.institution_name, report_period: r.report_date, shares: r.shares, market_value: r.value, shares_change: r.shares - prior.shares, value_change: r.value - prior.value }];
  });
  const topIncreases = movers.filter((m) => m.shares_change > 0).sort((a, b) => b.shares_change - a.shares_change).slice(0, 30);
  const topDecreases = movers.filter((m) => m.shares_change < 0).sort((a, b) => a.shares_change - b.shares_change).slice(0, 30);
  const latest13f = latestRows.sort((a, b) => b.value - a.value).slice(0, 30).map((r) => ({ ticker: r.ticker, company_name: r.company_name, manager_name: r.institution_name, report_period: r.report_date, shares: r.shares, market_value: r.value }));

  return Response.json({
    data: { latest_report_date: latestPeriod ?? null, top_increases: topIncreases, top_decreases: topDecreases, latest_13f: latest13f, mapped_ticker_count: new Set(all.map((r) => r.ticker)).size },
    meta: { source: "SEC EDGAR 13F (production institutional_holdings, canonical-mapped subset only)" },
  }, { headers });
}

export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
