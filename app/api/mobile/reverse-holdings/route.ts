import { Pool } from 'pg';
import { currentReverseHoldings } from '@/lib/data-platform/reverseIndex';
import { getCachedReverseLookup } from '@/lib/data-platform/reverseLookupCache';

export const preferredRegion = 'sin1';

// One bounded read pool for this function instance; canonical writes still use their existing writers.
const pool = new Pool({connectionString:process.env.DATABASE_URL,max:2,idleTimeoutMillis:10000,connectionTimeoutMillis:5000,statement_timeout:3000,application_name:'reverse-current-read'});
pool.on('error',()=>console.error('Reverse read idle connection failed'));

const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const input = {
    tickers: (q.get('tickers') ?? q.get('ticker') ?? '').split(','),
    market: q.get('market') ?? '', type: q.get('type') ?? 'ALL',
    page: Number(q.get('page') ?? 1), limit: Number(q.get('limit') ?? 50),
    sort: q.get('sort') ?? 'weight_desc', direction: q.get('direction') ?? undefined,
    category: q.get('category') ?? 'ALL',
  };
  try {
    // 2026-11-12（使用者核准定案，反查效能）: 單一股票、預設排序/篩選這一種最常見的形狀先查快取
    // 表（見reverseLookupCache.ts），命中就直接回，不打即時查詢；沒命中（含還沒刷新過、或非
    // 預設形狀）照舊即時查詢，快取本身出問題也不會擋住這支route。
    if (input.tickers.length === 1 && input.tickers[0]) {
      const cached = await getCachedReverseLookup(input.tickers[0], input);
      if (cached) return Response.json(cached, { headers: { ...headers, 'Server-Timing': 'db;dur=0;desc="cache"' } });
    }
    const result = await currentReverseHoldings(async <T,>(sql:string, ...values:unknown[]) => (await pool.query(sql,values)).rows as T[], input);
    return Response.json(result, { headers: {...headers,'Server-Timing':`db;dur=${result.timing.db_ms}`} });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'QUERY_FAILED';
    const invalid = /^(INVALID_|UNRESOLVED_OR_AMBIGUOUS_SECURITY)/.test(message);
    const notReady=message==='REVERSE_INDEX_NOT_READY';
    return Response.json({ ok: false, error: invalid || notReady ? message : 'QUERY_FAILED' }, { status: invalid ? 400 : notReady ? 503 : 500, headers });
  }
}
export async function OPTIONS() { return new Response(null, { status: 204, headers }); }
