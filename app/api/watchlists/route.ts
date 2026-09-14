import { prisma } from '@/lib/prisma';
import { getAccountForRequest } from '@/lib/auth/userService';
import { isPublicReadyAsset } from '@/lib/data-platform/web/publicReadiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ASSET_TYPES = ['STOCK','ETF','FUND','INDEX','DERIVATIVES','FIXED_INCOME','FX','MACRO','COMMODITY','CRYPTO'] as const;
const LENSES = ['MARKET','VALUATION','FUNDAMENTAL','TECHNICAL','ATTENTION','OWNERSHIP','FLOW','WHAT_CHANGED','EVENTS','CUSTOM'] as const;
const text = (value: unknown, max = 200) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
const json = async (request: Request) => request.json().catch(() => ({})) as Promise<Record<string, unknown>>;
const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
export function OPTIONS() { return new Response(null, { status: 204, headers: corsHeaders }); }
const response = (data: unknown, status = 200) => Response.json({ data, error: null }, { status, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
const failure = (message: string, status: number) => Response.json({ data: null, error: { message } }, { status, headers: corsHeaders });

async function owner(request: Request) {
  const account = await getAccountForRequest(request);
  if (!account) throw new Error('UNAUTHENTICATED');
  return account;
}

async function ownedWatchlist(id: string, userId: string) {
  return prisma.watchlist.findFirst({ where: { id, ownerUserId: userId, archivedAt: null } });
}

async function validateAsset(request: Request, assetId: string, assetType: string) {
  if (!ASSET_TYPES.includes(assetType as (typeof ASSET_TYPES)[number])) return false;
  void request;
  return isPublicReadyAsset(assetType, assetId);
}

const includeItems = { items: { where: { removedAt: null }, orderBy: [{ isPinned: 'desc' as const }, { sortOrder: 'asc' as const }, { createdAt: 'asc' as const }], take: 250 } };

export async function GET(request: Request) {
  try {
    const account = await owner(request);
    const rows = await prisma.watchlist.findMany({ where: { ownerUserId: account.id, archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 50, include: includeItems });
    return response(rows);
  } catch (error) { return failure(error instanceof Error && error.message === 'UNAUTHENTICATED' ? 'Authentication required.' : 'Unable to load watchlists.', error instanceof Error && error.message === 'UNAUTHENTICATED' ? 401 : 500); }
}

export async function POST(request: Request) {
  try {
    const account = await owner(request); const body = await json(request); const action = text(body.action, 40) ?? 'CREATE';
    if (action === 'CREATE') {
      const name = text(body.name, 80); if (!name) return failure('Name is required.', 400);
      const count = await prisma.watchlist.count({ where: { ownerUserId: account.id, archivedAt: null } });
      const row = await prisma.watchlist.create({ data: { ownerUserId: account.id, name, description: text(body.description, 500), sortOrder: count, isDefault: count === 0 } });
      return response(row, 201);
    }
    const watchlistId = text(body.watchlistId); const assetId = text(body.assetId); const assetType = text(body.assetType, 30)?.toUpperCase();
    if (action !== 'ADD_ITEM' || !watchlistId || !assetId || !assetType || !(await ownedWatchlist(watchlistId, account.id))) return failure('Invalid watchlist item request.', 400);
    if (!(await validateAsset(request, assetId, assetType))) return failure('Asset is not public ready.', 409);
    const existing = await prisma.watchlistItem.findFirst({ where: { watchlistId, canonicalAssetId: assetId, assetType } });
    const item = await prisma.$transaction(async (tx) => {
      if (existing?.removedAt === null) return existing;
      const order = await tx.watchlistItem.count({ where: { watchlistId, removedAt: null } });
      const saved = existing ? await tx.watchlistItem.update({ where: { id: existing.id }, data: { removedAt: null, status: 'ACTIVE', sortOrder: order } }) : await tx.watchlistItem.create({ data: { watchlistId, canonicalAssetId: assetId, assetType, displaySymbol: text(body.symbol, 60), sortOrder: order } });
      await tx.watchlistMembershipEvent.create({ data: { watchlistItemId: saved.id, eventType: 'ADDED', effectiveAt: new Date(), actorUserId: account.id, metadata: { source: text(body.source, 30) ?? 'API' } } });
      return saved;
    });
    return response(item, existing?.removedAt === null ? 200 : 201);
  } catch (error) { return failure(error instanceof Error && error.message === 'UNAUTHENTICATED' ? 'Authentication required.' : 'Unable to update watchlist.', error instanceof Error && error.message === 'UNAUTHENTICATED' ? 401 : 500); }
}

export async function PATCH(request: Request) {
  try {
    const account = await owner(request); const body = await json(request); const action = text(body.action, 40); const watchlistId = text(body.watchlistId);
    if (!watchlistId || !(await ownedWatchlist(watchlistId, account.id))) return failure('Watchlist not found.', 404);
    if (action === 'UPDATE_WATCHLIST') {
      const lens = text(body.defaultLens, 30)?.toUpperCase();
      const row = await prisma.watchlist.update({ where: { id: watchlistId }, data: { ...(text(body.name, 80) ? { name: text(body.name, 80)! } : {}), ...(body.description !== undefined ? { description: text(body.description, 500) } : {}), ...(lens && LENSES.includes(lens as (typeof LENSES)[number]) ? { defaultLens: lens } : {}), ...(Number.isInteger(body.sortOrder) ? { sortOrder: Number(body.sortOrder) } : {}) } });
      return response(row);
    }
    const itemId = text(body.itemId); if (!itemId) return failure('Item is required.', 400);
    const item = await prisma.watchlistItem.findFirst({ where: { id: itemId, watchlistId, removedAt: null } }); if (!item) return failure('Item not found.', 404);
    const tags = Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20).map((tag) => tag.slice(0, 40)) : undefined;
    const row = await prisma.watchlistItem.update({ where: { id: itemId }, data: { ...(typeof body.isPinned === 'boolean' ? { isPinned: body.isPinned } : {}), ...(Number.isInteger(body.sortOrder) ? { sortOrder: Number(body.sortOrder) } : {}), ...(body.note !== undefined ? { note: text(body.note, 2000) } : {}), ...(tags ? { tags } : {}) } });
    return response(row);
  } catch (error) { return failure(error instanceof Error && error.message === 'UNAUTHENTICATED' ? 'Authentication required.' : 'Unable to update watchlist.', error instanceof Error && error.message === 'UNAUTHENTICATED' ? 401 : 500); }
}

export async function DELETE(request: Request) {
  try {
    const account = await owner(request); const body = await json(request); const watchlistId = text(body.watchlistId); if (!watchlistId || !(await ownedWatchlist(watchlistId, account.id))) return failure('Watchlist not found.', 404);
    const itemId = text(body.itemId);
    if (!itemId) { await prisma.watchlist.update({ where: { id: watchlistId }, data: { archivedAt: new Date(), status: 'ARCHIVED', isDefault: false } }); return response({ deleted: true }); }
    const item = await prisma.watchlistItem.findFirst({ where: { id: itemId, watchlistId, removedAt: null } }); if (!item) return response({ deleted: true });
    await prisma.$transaction([prisma.watchlistItem.update({ where: { id: item.id }, data: { removedAt: new Date(), status: 'REMOVED' } }), prisma.watchlistMembershipEvent.create({ data: { watchlistItemId: item.id, eventType: 'REMOVED', effectiveAt: new Date(), actorUserId: account.id } })]);
    return response({ deleted: true });
  } catch (error) { return failure(error instanceof Error && error.message === 'UNAUTHENTICATED' ? 'Authentication required.' : 'Unable to delete watchlist data.', error instanceof Error && error.message === 'UNAUTHENTICATED' ? 401 : 500); }
}

