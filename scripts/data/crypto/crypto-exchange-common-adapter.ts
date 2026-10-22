export type ExchangeTicker = { observedAt: Date; price: string; bid: string | null; ask: string | null; volume24h: string | null; sourceRecordId: string; payload: unknown };

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "SmartFund/2 public-crypto-mesh" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}:${url}`);
  return response.json();
}

export async function fetchExchangeTicker(sourceId: string, baseUrl: string, symbol: string): Promise<ExchangeTicker> {
  const now = new Date();
  if (sourceId === "KRAKEN") {
    const payload = await getJson(`${baseUrl}/0/public/Ticker?pair=${encodeURIComponent(symbol)}`) as { error?: unknown[]; result?: Record<string, { a: string[]; b: string[]; c: string[]; v: string[] }> };
    if (payload.error?.length || !payload.result) throw new Error(`KRAKEN_TICKER_ERROR:${JSON.stringify(payload.error ?? [])}`);
    const row = Object.values(payload.result)[0];
    if (!row) throw new Error("KRAKEN_TICKER_EMPTY");
    return { observedAt: now, price: row.c[0], bid: row.b[0] ?? null, ask: row.a[0] ?? null, volume24h: row.v[1] ?? null, sourceRecordId: `${symbol}:${now.toISOString()}`, payload };
  }
  throw new Error(`ADAPTER_ROUTE_NOT_IMPLEMENTED:${sourceId}`);
}
