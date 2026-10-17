import { Pool } from 'pg';
import { currentReverseHoldings } from '@/lib/data-platform/reverseIndex';
import { classifyHeldByProducts, computeTwPurchasableBreakdownFull, METHODOLOGY_VERSION, type HeldByProduct } from '@/lib/data-platform/externalNumberMethodology';

export const preferredRegion = 'sin1';

// One bounded read pool for this function instance; canonical writes still use their existing writers.
const pool = new Pool({connectionString:process.env.DATABASE_URL,max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:5000,statement_timeout:3000,application_name:'reverse-current-read'});
pool.on('error',()=>console.error('Reverse read idle connection failed'));

const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  try {
    const query = async <T,>(sql:string, ...values:unknown[]) => (await pool.query(sql,values)).rows as T[];
    const result = await currentReverseHoldings(query, {
      tickers: (q.get('tickers') ?? q.get('ticker') ?? '').split(','),
      market: q.get('market') ?? '', type: q.get('type') ?? 'ALL',
      page: Number(q.get('page') ?? 1), limit: Number(q.get('limit') ?? 50),
      sort: q.get('sort') ?? 'weight_desc',
    });
    // 固定範圍第 7 項 (對外數字口徑): split 台灣買得到／買不到, ETF/FUND already separate upstream.
    // Per-item tag uses the current page only (cheap); twPurchasableBreakdown below is the FULL,
    // non-paginated count (the one actually safe to quote publicly -- see
    // computeTwPurchasableBreakdownFull's doc comment for why the page total would undercount).
    const pageProducts: HeldByProduct[] = [...result.etfs, ...result.funds].map((p) => ({ id: p.id, code: p.code, name: p.name, type: p.type, assetId: p.assetId, date: p.date }));
    const { statusByProductId } = await classifyHeldByProducts(query, pageProducts);
    const resultsWithPurchasable = result.results.map((p) => ({ ...p, twPurchasable: statusByProductId.get(p.id) ?? 'UNKNOWN' }));
    const fullBreakdown = await computeTwPurchasableBreakdownFull(query, result.tickers, q.get('market') ?? '');
    const enriched = {
      ...result,
      results: resultsWithPurchasable,
      etfs: resultsWithPurchasable.filter((p) => p.type === 'ETF'),
      funds: resultsWithPurchasable.filter((p) => p.type === '基金'),
      twPurchasableBreakdown: fullBreakdown,
      methodologyVersion: METHODOLOGY_VERSION,
    };
    return Response.json(enriched, { headers: {...headers,'Server-Timing':`db;dur=${result.timing.db_ms}`} });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'QUERY_FAILED';
    const invalid = /^(INVALID_|UNRESOLVED_OR_AMBIGUOUS_SECURITY)/.test(message);
    const notReady=message==='REVERSE_INDEX_NOT_READY';
    return Response.json({ ok: false, error: invalid || notReady ? message : 'QUERY_FAILED' }, { status: invalid ? 400 : notReady ? 503 : 500, headers });
  }
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
