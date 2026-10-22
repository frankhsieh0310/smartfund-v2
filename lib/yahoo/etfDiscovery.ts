// Yahoo ETF universe discovery — global full-sweep enumeration.
//
// Yahoo's v1 screener has no reliable single "give me everything" cursor beyond ~a few thousand rows,
// and its own `total` counter is not trustworthy (observed to vary wildly between unrelated filter
// shapes on the same quoteType). The robust approach is the same one used for mutual funds: shard by
// a categorical anchor Yahoo actually filters on, page each shard, and dedup into one Set. For ETFs
// the anchor that empirically narrows correctly is `exchange` (Yahoo's short venue code, e.g. "PCX"
// for NYSEArca, "LSE" for London, "JPX" for Tokyo — NOT the display name our own `etfs.exchange`
// column stores). Confirmed empirically 2026-09-11: exchange=EQ narrows correctly; region=EQ does not
// (Yahoo always reports region:"US" on every quote regardless of listing venue).
//
// matchOrInsertEtf never uses the Yahoo symbol as canonical id — id stays gen_random_uuid()::text,
// matching every other row in this table. The Yahoo symbol is a mapping field only (code/data_source),
// exactly like every existing ETF row already inserted by the pre-existing local pipeline.

import { screenerPage, fetchQuoteSummary, rawText, sleep, type RateStats } from "./productSession";

export type QueryFn = (sql: string, params: any[]) => Promise<any[]>;

// Yahoo short exchange codes covering the major global ETF venues (probed 2026-09-11).
export const EXCHANGE_SHARDS = [
  "PCX", "NAS", "NYQ", "BTS",           // US (NYSEArca, Nasdaq, NYSE, BATS/Cboe)
  "LSE", "IOB", "AQS",                  // UK
  "GER", "DUS", "FRA", "MCE",           // Germany/pan-EU cross-listings (Xetra/Düsseldorf/Frankfurt)
  "MIL", "PAR", "AMS", "STO", "OSL",    // Italy/France/Netherlands/Sweden/Norway
  "VIE", "BUD", "WSE", "IST",           // Austria/Hungary/Poland/Turkey
  "JPX", "HKG", "KSC", "TAI", "TWO",    // Japan/Hong Kong/Korea/Taiwan (TSE+TPEx)
  "ASX", "SES", "JKT", "VSE",           // Australia/Singapore/Indonesia/Vietnam
  "TOR", "MEX",                         // Canada/Mexico
  "TLV", "SAU", "DOH", "NGM",           // Israel/Saudi/Qatar/Nordic growth market
];

// Also sweep the unfiltered highest-AUM window — catches large/global funds a single exchange shard
// might miss (dual/triple-listed symbols, or venues not in the shard list above).
const UNFILTERED_PAGES = 40; // 40 * 25 = 1000 largest-by-AUM ETFs worldwide

export async function discoverEtfUniverse(
  opts: { perShardPages?: number; stats?: RateStats },
): Promise<{ symbols: string[]; perShardTotals: Record<string, number> }> {
  const pages = opts.perShardPages ?? 12; // 12 * 25 = 300 per shard, generous vs observed shard sizes
  const seen = new Set<string>();
  const perShardTotals: Record<string, number> = {};

  for (let p = 0; p < UNFILTERED_PAGES; p++) {
    const r = await screenerPage("ETF", [{ operator: "GT", operands: ["fundnetassets", 0] }], p * 25, 25, "fundnetassets", opts.stats);
    for (const s of r.symbols) seen.add(s);
    if (r.symbols.length < 25) break;
    await sleep(250);
  }
  perShardTotals["_unfiltered_top"] = seen.size;

  for (const ex of EXCHANGE_SHARDS) {
    let shardCount = 0;
    for (let p = 0; p < pages; p++) {
      const r = await screenerPage("ETF", [{ operator: "EQ", operands: ["exchange", ex] }], p * 25, 25, "fundnetassets", opts.stats);
      if (p === 0) perShardTotals[ex] = r.total;
      for (const s of r.symbols) { seen.add(s); shardCount++; }
      if (r.symbols.length < 25) break;
      await sleep(250);
    }
  }
  return { symbols: [...seen], perShardTotals };
}

export type MatchResult = {
  symbol: string;
  matched: boolean;
  inserted: boolean;
  etfId: string | null;
  error?: string;
};

/**
 * Idempotent: if an ETF already exists under this Yahoo symbol (by code or data_source), just return
 * its id — no write. Otherwise insert a minimal net-new row (id=gen_random_uuid()::text; symbol is a
 * mapping field only) with a real name fetched via one quoteSummary `price` module call, then let the
 * existing enrich/history phases fill in everything else via their normal COALESCE upserts.
 */
export async function matchOrInsertEtf(query: QueryFn, symbol: string): Promise<MatchResult> {
  const out: MatchResult = { symbol, matched: false, inserted: false, etfId: null };
  try {
    const existing = await query(
      `SELECT id::text FROM etfs WHERE data_source = $1 OR code = $1 LIMIT 1`,
      [symbol],
    );
    if (existing[0]) { out.matched = true; out.etfId = existing[0].id; return out; }

    const qs = await fetchQuoteSummary(symbol, ["price"]);
    const pr = qs?.result?.price ?? {};
    if ((rawText(pr.quoteType) ?? "").toUpperCase() !== "ETF") { out.error = "NOT_ETF_QUOTE_TYPE"; return out; }
    const name = rawText(pr.longName) ?? rawText(pr.shortName) ?? symbol;
    const currency = rawText(pr.currency) ?? "USD";
    const exchangeDisp = rawText(pr.exchangeName) ?? null;

    const ins = await query(
      `INSERT INTO etfs (id, code, name, name_en, provider, exchange, currency, region, is_active,
                          created_at, updated_at, data_provider, data_source)
       VALUES (gen_random_uuid()::text, $1::text, $2::text, $2::text, 'YAHOO', $3::text, $4::text, NULL, true,
               NOW(), NOW(), 'yahoo-finance', $1::text)
       ON CONFLICT (code) DO NOTHING
       RETURNING id::text`,
      [symbol, name, exchangeDisp, currency],
    );
    if (ins[0]) { out.inserted = true; out.etfId = ins[0].id; return out; }
    // lost an ON CONFLICT race (or code already taken by an unrelated pre-existing row) — re-select
    const again = await query(`SELECT id::text FROM etfs WHERE data_source = $1 OR code = $1 LIMIT 1`, [symbol]);
    out.matched = !!again[0];
    out.etfId = again[0]?.id ?? null;
    return out;
  } catch (e) {
    out.error = String((e as Error).message ?? e);
    return out;
  }
}
