export type SharedWatchlistItem = { id: string; canonicalAssetId: string; assetType: string; displaySymbol: string | null; sortOrder: number; isPinned: boolean; note: string | null; tags: string[] | null };
export type SharedWatchlist = { id: string; name: string; description: string | null; defaultLens: string; sortOrder: number; isDefault: boolean; items: SharedWatchlistItem[] };

async function call<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  const result = await fetch('/api/watchlists', { method, credentials: 'include', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const payload = await result.json();
  if (!result.ok) throw new Error(payload.error?.message ?? 'Watchlist request failed.');
  return payload.data as T;
}

export const listSharedWatchlists = () => call<SharedWatchlist[]>('GET');
export const createSharedWatchlist = (name: string) => call<SharedWatchlist>('POST', { action: 'CREATE', name });
export const addSharedWatchlistItem = (watchlistId: string, assetId: string, assetType: string, symbol?: string) => call<SharedWatchlistItem>('POST', { action: 'ADD_ITEM', watchlistId, assetId, assetType, symbol, source: 'WEB' });
export const removeSharedWatchlistItem = (watchlistId: string, itemId: string) => call<{ deleted: true }>('DELETE', { watchlistId, itemId });
