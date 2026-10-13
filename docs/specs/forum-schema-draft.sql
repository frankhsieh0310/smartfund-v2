-- ============================================================================
-- Forum / Paid-membership schema — ORIGINAL DRAFT, SUPERSEDED. Kept for history only.
-- ============================================================================
-- SUPERSEDED on 2026-10-13: the user approved and this was actually executed with one change —
-- `memberships` moved out of `forum` into its own new `billing` schema, since other paid features
-- (e.g. dividend reminders) will also need it. See docs/specs/forum-billing-schema-applied.sql for
-- what was actually run, and docs/specs/forum-billing-rollback.sql for the saved-only rollback.
--
-- Design basis: docs/specs/paid-member-forum-spec.md 第十節草案，逐表轉為可執行 DDL，並新增
-- forum.memberships（RevenueCat 會員身分，決定記錄第 1 項新增需求，原規格草案未列；後於 2026-10-13
-- 執行時依使用者指示移至 billing.memberships，此檔案的 forum.memberships 定義已不代表實際狀態）。
--
-- Isolation: dedicated `forum` Postgres schema, separate from the shared `public` schema the
-- TW-stock app's Prisma models live in (see spec § 0-4 / 決定紀錄 第 6 項). Accessed via a plain
-- `pg` Pool (lib/forum/membership/db.ts), not Prisma — prisma/schema.prisma is intentionally untouched.
--
-- RLS: every table below follows CLAUDE.md's existing global convention — ENABLE ROW LEVEL SECURITY
-- and REVOKE ALL FROM anon, authenticated, since all access goes through the Next.js server (service
-- role / direct DB connection), never through a Supabase client SDK call from the app.
--
-- CORRECTED 2026-10-13: this draft originally claimed the FK target table was `public."User"`
-- (capital U), reasoning that the Prisma `User` model has no `@@map`. That was WRONG — the model
-- does have `@@map("users")` further down in the model block (missed on first read); live-DB
-- information_schema inspection confirmed the real table is `public.users` (lowercase), primary key
-- `id` of type `text`. Fixed below to `public.users(id)`.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS forum;

-- ----------------------------------------------------------------------------
-- forum.memberships — RevenueCat-derived paid-membership status (決定記錄 第 1 項)
-- ----------------------------------------------------------------------------
CREATE TABLE forum.memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id   text NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('ACTIVE', 'EXPIRED')),
  expires_at    timestamptz NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_memberships_status ON forum.memberships (status);

ALTER TABLE forum.memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.memberships FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- forum.profiles
-- ----------------------------------------------------------------------------
CREATE TABLE forum.profiles (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              text NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  nickname             text NOT NULL,
  nickname_changed_at  timestamptz NULL,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BANNED', 'DELETED')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness so "frank" and "Frank" can't both be taken.
CREATE UNIQUE INDEX idx_profiles_nickname_lower ON forum.profiles (lower(nickname));

ALTER TABLE forum.profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.profiles FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- forum.channels
-- ----------------------------------------------------------------------------
CREATE TABLE forum.channels (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE,
  name           text NOT NULL,
  description    text NOT NULL,
  official_only  boolean NOT NULL DEFAULT false,
  sort_order     int NOT NULL DEFAULT 0
);

ALTER TABLE forum.channels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.channels FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- forum.posts
-- ----------------------------------------------------------------------------
CREATE TABLE forum.posts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    uuid NOT NULL REFERENCES forum.channels(id),
  author_id     uuid NOT NULL REFERENCES forum.profiles(id),
  title         text NULL,
  body          text NULL,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PUBLISHED', 'HIDDEN', 'DELETED')),
  report_count  int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz NULL
);
CREATE INDEX idx_posts_channel_status_created ON forum.posts (channel_id, status, created_at);
CREATE INDEX idx_posts_author ON forum.posts (author_id);

ALTER TABLE forum.posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.posts FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- forum.replies
-- ----------------------------------------------------------------------------
CREATE TABLE forum.replies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       uuid NOT NULL REFERENCES forum.posts(id),
  author_id     uuid NOT NULL REFERENCES forum.profiles(id),
  body          text NULL,
  status        text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED', 'HIDDEN', 'DELETED')),
  report_count  int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz NULL
);
CREATE INDEX idx_replies_post_status_created ON forum.replies (post_id, status, created_at);
CREATE INDEX idx_replies_author ON forum.replies (author_id);

ALTER TABLE forum.replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.replies FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- forum.reports
-- ----------------------------------------------------------------------------
CREATE TABLE forum.reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type   text NOT NULL CHECK (target_type IN ('POST', 'REPLY')),
  target_id     uuid NOT NULL,
  reporter_id   uuid NOT NULL REFERENCES forum.profiles(id),
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz NULL,
  resolved_by   text NULL,
  UNIQUE (target_type, target_id, reporter_id)
);
CREATE INDEX idx_reports_target ON forum.reports (target_type, target_id);
CREATE INDEX idx_reports_unresolved ON forum.reports (resolved_at) WHERE resolved_at IS NULL;

ALTER TABLE forum.reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.reports FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- forum.moderation_log — append-only (INSERT/SELECT only; never UPDATE/DELETE); no content/PII stored.
-- ----------------------------------------------------------------------------
CREATE TABLE forum.moderation_log (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type             text NOT NULL CHECK (action_type IN
                            ('HIDE', 'DELETE', 'SUSPEND_1D', 'SUSPEND_7D', 'SUSPEND_30D', 'BAN', 'APPROVE')),
  target_type             text NOT NULL CHECK (target_type IN ('POST', 'REPLY', 'PROFILE')),
  target_ref              uuid NOT NULL,
  actor_ref               text NOT NULL,
  report_count_at_action  int NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_moderation_log_target ON forum.moderation_log (target_type, target_ref);

ALTER TABLE forum.moderation_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.moderation_log FROM anon, authenticated;
-- Intentionally no UPDATE/DELETE grant to the application role even after REVOKE ALL + targeted
-- GRANT below — this table must only ever grow.
-- GRANT SELECT, INSERT ON forum.moderation_log TO <app_role>;  -- fill in <app_role> on approval

-- ----------------------------------------------------------------------------
-- forum.rule_acceptance
-- ----------------------------------------------------------------------------
CREATE TABLE forum.rule_acceptance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    uuid NOT NULL REFERENCES forum.profiles(id),
  rule_version  text NOT NULL,
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (profile_id, rule_version)
);

ALTER TABLE forum.rule_acceptance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.rule_acceptance FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- forum.blocked_attempts — contains the user's raw rejected input; filter-tuning use only.
-- Retention: 90-day auto-purge proposed, PENDING THE USER'S DECISION (spec § 12 待決定清單).
-- ----------------------------------------------------------------------------
CREATE TABLE forum.blocked_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id         uuid NOT NULL REFERENCES forum.profiles(id),
  channel_id         uuid NULL REFERENCES forum.channels(id),
  matched_category   text NOT NULL CHECK (matched_category IN ('FRAUD_REDIRECT', 'STOCK_ADVICE', 'PROFANITY')),
  matched_term_ref    text NULL,
  raw_content        text NOT NULL,
  attempted_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_blocked_attempts_profile_time ON forum.blocked_attempts (profile_id, attempted_at);

ALTER TABLE forum.blocked_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.blocked_attempts FROM anon, authenticated;

-- ----------------------------------------------------------------------------
-- forum.suspensions
-- ----------------------------------------------------------------------------
CREATE TABLE forum.suspensions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id    uuid NOT NULL REFERENCES forum.profiles(id),
  type          text NOT NULL CHECK (type IN ('TEMP_1D', 'TEMP_7D', 'TEMP_30D', 'PERMANENT')),
  reason        text NOT NULL,
  starts_at     timestamptz NOT NULL DEFAULT now(),
  ends_at       timestamptz NULL,
  created_by    text NOT NULL
);
CREATE INDEX idx_suspensions_profile ON forum.suspensions (profile_id);
-- Plain (non-partial) index: a partial predicate using now() is rejected by Postgres because
-- now() is STABLE, not IMMUTABLE, and index predicates require an immutable expression. (Confirmed
-- by actually attempting this DDL on 2026-10-13 — see docs/specs/forum-billing-schema-applied.sql.)
CREATE INDEX idx_suspensions_active ON forum.suspensions (ends_at);

ALTER TABLE forum.suspensions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.suspensions FROM anon, authenticated;

COMMIT;

-- ============================================================================
-- Deliberately NOT included in this draft (pending decisions — see spec § 12):
--   - Any ON DELETE CASCADE from forum.profiles into forum.posts/forum.replies: account deletion is
--     handled at the application layer (clear title/body, set status='DELETED'), not via DB cascade,
--     per spec § 8's resolution. The FK here only cascades forum.profiles -> auth user deletion.
--   - A scheduled job to purge forum.blocked_attempts after 90 days (needs the user's go-ahead first).
--   - GRANT statements for the actual application DB role name (unknown at draft time).
-- ============================================================================
