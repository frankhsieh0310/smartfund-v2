import type { PrismaClient } from "@prisma/client";

type Page = { limit?: number; cursorAt?: Date; cursorId?: string };
const bounded = (limit = 50) => Math.max(1, Math.min(limit, 100));

export async function listWatchlists(db: PrismaClient, ownerUserId: string, page: Page = {}) {
  return db.$queryRawUnsafe(`SELECT w.*, count(i.id)::int AS item_count
    FROM watchlists w LEFT JOIN watchlist_items i ON i.watchlist_id=w.id AND i.removed_at IS NULL
    WHERE w.owner_user_id=$1 AND w.status <> 'ARCHIVED'
    GROUP BY w.id ORDER BY w.updated_at DESC, w.id DESC LIMIT $2`, ownerUserId, bounded(page.limit));
}

export async function watchlistDetail(db: PrismaClient, ownerUserId: string, watchlistId: string) {
  const [watchlist, items, rules, pending] = await Promise.all([
    db.$queryRawUnsafe(`SELECT * FROM watchlists WHERE id=$1 AND owner_user_id=$2`, watchlistId, ownerUserId),
    db.$queryRawUnsafe(`SELECT * FROM watchlist_items WHERE watchlist_id=$1 AND removed_at IS NULL ORDER BY created_at,id`, watchlistId),
    db.$queryRawUnsafe(`SELECT r.*,s.current_condition_state,s.last_evaluated_at,s.last_triggered_at FROM alert_rules_p0 r LEFT JOIN alert_rule_states s ON s.rule_id=r.id WHERE r.watchlist_id=$1 AND r.status='ACTIVE'`, watchlistId),
    db.$queryRawUnsafe(`SELECT count(*)::int AS count FROM alert_occurrences WHERE watchlist_id=$1 AND status IN ('TRIGGERED','QUEUED','DELIVERY_PENDING')`, watchlistId),
  ]);
  return { watchlist, items, rules, pending };
}

export async function alertHistory(db: PrismaClient, ownerUserId: string, filters: { status?: string; severity?: string; assetType?: string; watchlistId?: string; from?: Date; to?: Date } = {}, page: Page = {}) {
  return db.$queryRawUnsafe(`SELECT o.* FROM alert_occurrences o JOIN alert_rules_p0 r ON r.id=o.rule_id
    WHERE r.owner_user_id=$1 AND ($2::text IS NULL OR o.status=$2) AND ($3::text IS NULL OR o.severity=$3)
      AND ($4::text IS NULL OR o.asset_type=$4) AND ($5::text IS NULL OR o.watchlist_id=$5)
      AND ($6::timestamp IS NULL OR o.triggered_at >= $6) AND ($7::timestamp IS NULL OR o.triggered_at <= $7)
    ORDER BY o.triggered_at DESC,o.id DESC LIMIT $8`, ownerUserId, filters.status ?? null, filters.severity ?? null, filters.assetType ?? null, filters.watchlistId ?? null, filters.from ?? null, filters.to ?? null, bounded(page.limit));
}

export async function ruleHistory(db: PrismaClient, ownerUserId: string, ruleId: string, page: Page = {}) {
  return db.$queryRawUnsafe(`SELECT v.* FROM alert_rule_versions v JOIN alert_rules_p0 r ON r.id=v.rule_id WHERE v.rule_id=$1 AND r.owner_user_id=$2 ORDER BY v.version_number DESC LIMIT $3`, ruleId, ownerUserId, bounded(page.limit));
}

export async function membershipHistory(db: PrismaClient, ownerUserId: string, watchlistId: string, page: Page = {}) {
  return db.$queryRawUnsafe(`SELECT e.* FROM watchlist_membership_events e JOIN watchlist_items i ON i.id=e.watchlist_item_id JOIN watchlists w ON w.id=i.watchlist_id WHERE w.id=$1 AND w.owner_user_id=$2 ORDER BY e.effective_at DESC,e.id DESC LIMIT $3`, watchlistId, ownerUserId, bounded(page.limit));
}

export async function deliveryHistory(db: PrismaClient, ownerUserId: string, occurrenceId: string, page: Page = {}) {
  return db.$queryRawUnsafe(`SELECT d.* FROM alert_delivery_attempts d JOIN alert_occurrences o ON o.id=d.alert_occurrence_id JOIN alert_rules_p0 r ON r.id=o.rule_id WHERE o.id=$1 AND r.owner_user_id=$2 ORDER BY d.attempt_number DESC LIMIT $3`, occurrenceId, ownerUserId, bounded(page.limit));
}
