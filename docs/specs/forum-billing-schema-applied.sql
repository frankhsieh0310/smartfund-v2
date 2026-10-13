-- ============================================================================
-- Forum / Billing schema — AS APPLIED to production on 2026-10-13.
-- ============================================================================
-- Approval: user's message of 2026-10-13 ("三、修改 DDL 草案並執行（本指令即為核准...)") explicitly
-- approved executing this DDL, superseding docs/specs/forum-schema-draft.sql (which remains in the
-- repo as the original, unexecuted draft for history).
--
-- Change from the draft: `memberships` moved from `forum` to a new `billing` schema, because other
-- future paid features (e.g. dividend reminders) will also need to read/write membership status and
-- shouldn't depend on the `forum` schema.
--
-- Correction from the draft: the draft referenced `public."User"` as the FK target. Live-DB
-- information_schema inspection on 2026-10-13 found the actual table is `public.users` (lowercase,
-- via the User model's `@@map("users")` in prisma/schema.prisma, which the earlier draft missed) with
-- primary key column `id` of type `text`. This file uses the verified `public.users(id)` / `text` FK.
--
-- Executed via a single pg.Client against DIRECT_URL (not the pooled DATABASE_URL), in one transaction,
-- by scripts/forum-billing/apply.mjs. See docs/specs/forum-billing-rollback.sql for the corresponding
-- DROP statements (saved only, not executed).
-- ============================================================================

BEGIN;

CREATE SCHEMA forum;
CREATE SCHEMA billing;

-- ----------------------------------------------------------------------------
-- billing.memberships — RevenueCat-derived paid-membership status, shared across paid features.
-- ----------------------------------------------------------------------------
CREATE TABLE billing.memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id   text NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('ACTIVE', 'EXPIRED')),
  expires_at    timestamptz NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_memberships_status ON billing.memberships (status);

ALTER TABLE billing.memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON billing.memberships FROM anon, authenticated;

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
-- forum.moderation_log — append-only (INSERT/SELECT only); no content/PII stored.
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
-- Retention: 90-day auto-purge proposed, still pending the user's decision.
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
-- now() is STABLE, not IMMUTABLE, and index predicates require an immutable expression.
CREATE INDEX idx_suspensions_active ON forum.suspensions (ends_at);

ALTER TABLE forum.suspensions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON forum.suspensions FROM anon, authenticated;

-- Schema-level REVOKE (in addition to the per-table REVOKEs above).
REVOKE ALL ON SCHEMA forum FROM anon, authenticated;
REVOKE ALL ON SCHEMA billing FROM anon, authenticated;

COMMIT;
