// Read-only reverse lookup: given one or more stock tickers, find which ETFs / funds hold them.
// Built to fix 跨國股票反查基金/ETF returning 0 for every non-Taiwan ticker (including NVDA) — the
// app's GlobalLookupPage only ever matched against the locally-bundled Taiwan-only ETF/fund JSON, so
// no global stock could ever match. This route queries the real etf_holdings / holdings tables.
//
// Join key note: etf_holdings.security_id is null for effectively all rows in production (ingestion
// never backfilled it), so the only reliable join key today is the raw `ticker` text column — same
// key already used elsewhere in this codebase for holdings lookups. Do not join via security_id.
//
// Fund side: real fund holdings (82k+ rows, master-fund-deduped — one write per master's
// representative fund, per lib/yahoo/fundIngest.ts and lib/cloud-ingestion/fundHoldings.ts) live in
// `holdings` WHERE asset_type='FUND', NOT in the near-empty legacy `fund_holdings` table (10 rows,
// unrelated/vestigial — do not use it). Ticker coverage on holding_code is source-dependent: Yahoo US
// funds and the small MONEYDJ source populate it; the two largest sources (MONEYDJ_PUBLIC_DISCLOSURE,
// 62k+ rows, and YAHOO_TW_FUND, 10k+ rows) only ever wrote holding_name text — no schema change this
// round, so those are matched by a company-name prefix derived from the canonical stock's own
// company_name (never a per-ticker hardcoded string), skipped only when holding_code is already
// present and didn't match on ticker.
import { prisma } from "@/lib/prisma";

const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
const MAX_TICKERS = 10;
const MAX_PRODUCTS_PER_TICKER = 150;
// First-word company-name matching is unreliable for these generic/geographic leading words (e.g.
// "Taiwan Semiconductor..." vs "Taiwan Mobile...") — fall back to a two-word prefix for those only.
const GENERIC_NAME_PREFIXES = new Set(["TAIWAN", "CHINA", "GLOBAL", "AMERICAN", "UNITED", "NEW", "GREATER", "ASIA", "JAPAN", "KOREA", "EUROPE", "INDIA", "GENERAL", "NATIONAL"]);

function namePrefixFor(companyName: string | null): string {
  if (!companyName) return "";
  const cleaned = companyName.split(/[-–—]/)[0].replace(/[^A-Za-z0-9 ]/g, " ").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const first = words[0].toUpperCase();
  if (GENERIC_NAME_PREFIXES.has(first) && words.length > 1) return `${first} ${words[1].toUpperCase()}`;
  return first;
}

type EtfHoldingRow = { code: string; name: string; exchange: string | null; region: string | null; ticker: string; holding_name: string; weight: string | null; holding_date: string | null };
type FundHoldingRow = {
  fund_id: string; fund_name: string; company: string | null; master_id: string | null; master_name: string | null;
  representative_fund_id: string | null; matched_ticker: string; holding_name: string | null; weight: string | null; holding_date: string | null; source: string;
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = (searchParams.get("tickers") ?? searchParams.get("ticker") ?? "").trim();
  if (!raw) return Response.json({ ok: false, error: "MISSING_TICKERS" }, { status: 400, headers });
  const tickers = [...new Set(raw.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))].slice(0, MAX_TICKERS);
  if (tickers.length === 0) return Response.json({ ok: false, error: "MISSING_TICKERS" }, { status: 400, headers });

  try {
    // Canonical company name per ticker, to derive a generic (never per-ticker-hardcoded) name-prefix
    // fallback for the two fund-holdings sources that never stored a ticker (see file header note).
    const nameRows = await prisma.$queryRawUnsafe<{ ticker: string; company_name: string }[]>(
      `SELECT DISTINCT ON (ticker) UPPER(ticker) AS ticker, company_name
         FROM stocks WHERE UPPER(ticker) = ANY($1::text[])
        ORDER BY ticker, (exchange IN ('NASDAQ','NYSE')) DESC`,
      tickers,
    );
    const nameByTicker = new Map(nameRows.map((r) => [r.ticker, r.company_name]));
    const namePrefixes = tickers.map((t) => namePrefixFor(nameByTicker.get(t) ?? null));

    const [etfRows, fundRows] = await Promise.all([
      prisma.$queryRawUnsafe<EtfHoldingRow[]>(
        `SELECT DISTINCT ON (r.etf_id, r.ticker)
                e.code, e.name, e.exchange, e.region, r.ticker, r.holding_name,
                r.weight::text AS weight,
                COALESCE(r.effective_date, s.retrieved_at)::date::text AS holding_date
           FROM etf_holdings r
           JOIN etfs e ON e.id = r.etf_id
           JOIN etf_holding_snapshots s ON s.id = r.snapshot_id
          WHERE UPPER(r.ticker) = ANY($1::text[])
          ORDER BY r.etf_id, r.ticker, COALESCE(r.effective_date, s.retrieved_at) DESC`,
        tickers,
      ),
      prisma.$queryRawUnsafe<FundHoldingRow[]>(
        `WITH targets AS (SELECT * FROM unnest($1::text[], $2::text[]) AS t(ticker, name_prefix))
         SELECT DISTINCT ON (r.fund_id, t.ticker)
                f.id AS fund_id, f.name AS fund_name, f.company,
                fm.id AS master_id, fm.canonical_name AS master_name, fm.representative_fund_id,
                t.ticker AS matched_ticker, r.holding_name,
                r.weight::text AS weight, r.as_of_date::date::text AS holding_date, r.source
           FROM holdings r
           JOIN targets t
             ON (r.holding_code IS NOT NULL AND UPPER(r.holding_code) = t.ticker)
             OR (r.holding_code IS NULL AND t.name_prefix <> '' AND r.holding_name ILIKE t.name_prefix || '%')
           JOIN funds f ON f.id = r.fund_id
           LEFT JOIN fund_share_classes sc ON sc.fund_id = r.fund_id
           LEFT JOIN fund_master fm ON fm.id = sc.master_fund_id
          WHERE r.asset_type = 'FUND'
          ORDER BY r.fund_id, t.ticker, r.as_of_date DESC NULLS LAST`,
        tickers,
        namePrefixes,
      ),
    ]);

    // `assetId` is the identifier smartfund-v2's own detail endpoint
    // (`/api/mobile/assets/{assetId}?type=ETF|FUND`, backed by getEtfDetail/getFundDetail) can actually
    // resolve. For ETF it's the same as `id` (etf.code). For Fund it must be a real `funds.id` — `id`
    // itself is `master_id ?? fund_id` for master-grouped display/dedup, and `fund_master.id` is NOT a
    // `funds.id`, so a caller trying to look up detail by `id` alone would 404 for any master-linked
    // fund. Added for consumers (e.g. smartmatch-fund-matcher's /fund/[id]) that need to navigate from
    // a reverse-holdings result into that detail endpoint — never used for matching/ranking itself.
    type Product = { id: string; type: "ETF" | "基金"; name: string; date: string | null; assetId: string; holdings: { ticker: string; name: string; weight: number | null }[] };
    const etfMap = new Map<string, Product>();
    for (const row of etfRows) {
      const key = row.code;
      const product = etfMap.get(key) ?? { id: row.code, type: "ETF" as const, name: row.name, date: null, assetId: row.code, holdings: [] };
      product.holdings.push({ ticker: row.ticker, name: row.holding_name, weight: row.weight != null ? Number(row.weight) : null });
      if (!product.date || (row.holding_date && row.holding_date > product.date)) product.date = row.holding_date;
      etfMap.set(key, product);
    }
    // Some historical MoneyDJ rows were written per share class before the master-representative-only
    // rule existed, so several fund_ids can carry near-identical holdings for the same master. Dedupe
    // to one entry per (master, ticker) — most recent as_of_date wins — so a display product never
    // shows the same underlying holding repeated once per legacy share class.
    const fundHoldingByKey = new Map<string, { productKey: string; ticker: string; name: string; weight: number | null; date: string | null }>();
    const fundMap = new Map<string, Product>();
    for (const row of fundRows) {
      // Group by master when linked (share classes share one underlying portfolio — never fetched or
      // displayed per class), otherwise the fund stands alone as its own display product.
      const key = row.master_id ?? row.fund_id;
      const displayName = row.master_name ?? row.fund_name;
      const assetId = row.representative_fund_id ?? row.fund_id;
      const product = fundMap.get(key) ?? { id: key, type: "基金" as const, name: displayName, date: null, assetId, holdings: [] };
      fundMap.set(key, product);
      const holdingKey = `${key}:${row.matched_ticker}`;
      const existing = fundHoldingByKey.get(holdingKey);
      if (!existing || (row.holding_date && (!existing.date || row.holding_date > existing.date))) {
        fundHoldingByKey.set(holdingKey, { productKey: key, ticker: row.matched_ticker, name: row.holding_name ?? row.matched_ticker, weight: row.weight != null ? Number(row.weight) : null, date: row.holding_date });
      }
      if (!product.date || (row.holding_date && row.holding_date > product.date)) product.date = row.holding_date;
    }
    for (const holding of fundHoldingByKey.values()) {
      fundMap.get(holding.productKey)?.holdings.push({ ticker: holding.ticker, name: holding.name, weight: holding.weight });
    }
    const rank = (p: Product) => p.holdings.reduce((sum, h) => sum + (h.weight ?? 0), 0);
    const etfs = [...etfMap.values()].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_PRODUCTS_PER_TICKER);
    const funds = [...fundMap.values()].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_PRODUCTS_PER_TICKER);
    const matchedTickers = new Set([...etfRows.map((r) => r.ticker.toUpperCase()), ...fundRows.map((r) => r.matched_ticker.toUpperCase())]);

    return Response.json(
      {
        ok: true,
        generated_at: new Date().toISOString(),
        tickers,
        unmatched_tickers: tickers.filter((t) => !matchedTickers.has(t)),
        etf_total_products: etfMap.size,
        fund_total_products: fundMap.size,
        etfs,
        funds,
      },
      { headers },
    );
  } catch (err) {
    return Response.json({ ok: false, error: "QUERY_FAILED", message: err instanceof Error ? err.message : String(err) }, { status: 500, headers });
  }
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
