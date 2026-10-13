-- ============================================================================
-- Rollback for docs/specs/forum-billing-schema-applied.sql — SAVED ONLY, NOT EXECUTED.
-- ============================================================================
-- Drops everything created by the applied DDL, in dependency order (children before parents,
-- then the schemas themselves). Run manually (and only by the user, with a fresh backup/snapshot
-- in hand) if the forum/billing rollout needs to be reverted before any real user data accumulates
-- in these tables. Once real posts/replies/memberships exist, do NOT run this blindly — it is a
-- destructive DROP, not a soft rollback.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS forum.suspensions;
DROP TABLE IF EXISTS forum.blocked_attempts;
DROP TABLE IF EXISTS forum.rule_acceptance;
DROP TABLE IF EXISTS forum.moderation_log;
DROP TABLE IF EXISTS forum.reports;
DROP TABLE IF EXISTS forum.replies;
DROP TABLE IF EXISTS forum.posts;
DROP TABLE IF EXISTS forum.channels;
DROP TABLE IF EXISTS forum.profiles;
DROP TABLE IF EXISTS billing.memberships;

DROP SCHEMA IF EXISTS forum;
DROP SCHEMA IF EXISTS billing;

COMMIT;
