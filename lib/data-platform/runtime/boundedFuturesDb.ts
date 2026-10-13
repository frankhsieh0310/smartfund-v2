export const MAX_DB_CONCURRENCY = 1;
export const FUTURES_DB_POOL_MODE = "SUPABASE_TRANSACTION_POOLER_6543_PGBOUNCER";

export function futuresDatabaseUrl(raw = process.env.DATABASE_URL ?? process.env.DIRECT_URL ?? "") {
  if (!raw) throw new Error("DATABASE_URL_MISSING");
  const url = new URL(raw);
  url.searchParams.set("pgbouncer", "true");
  url.searchParams.set("connection_limit", "1");
  return url.toString();
}

export async function boundedDbRetry<T>(operation: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await operation(); } catch (error) {
      last = error;
      if (!/EMAXCONNSESSION|max clients|closed the connection|connection.*(?:interrupt|terminat)|P1001|P1017/i.test(String(error)) || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw last;
}
