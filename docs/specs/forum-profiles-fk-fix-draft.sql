-- ============================================================================
-- Fix for a schema gap discovered while implementing full account deletion (2026-10-13).
-- DRAFT ONLY. DO NOT EXECUTE without the user's explicit approval.
-- ============================================================================
-- Problem (VERIFIED against the live DB's pg_constraint, 2026-10-13):
--   forum.profiles.user_id  -> public.users(id)   ON DELETE CASCADE
--   forum.posts.author_id   -> forum.profiles(id)  ON DELETE NO ACTION (default, i.e. effectively RESTRICT)
--   forum.replies.author_id -> forum.profiles(id)  ON DELETE NO ACTION (same)
--
-- Deleting a public.users row whose forum profile has ever authored a post/reply currently FAILS:
-- Postgres's cascade from users -> forum.profiles tries to delete that profile row, which then hits
-- the RESTRICT on forum.posts/forum.replies and aborts the whole deletion. This has zero real-world
-- impact today because forum.posts/forum.replies are still empty (the forum hasn't launched), but it
-- must be fixed before "delete my account" (lib/accountDeletion.ts) can work for anyone who has
-- actually used the forum.
--
-- Fix: forum.profiles.user_id becomes nullable and its FK becomes ON DELETE SET NULL, matching the
-- same "clear content, don't hard-delete the row" design already used for posts/replies (spec § 8/9) --
-- the profile row survives account deletion (orphaned, user_id NULL) so other users' quotes of this
-- author's (already-cleared) content keep resolving instead of hitting a dangling reference.
-- ============================================================================

BEGIN;

ALTER TABLE forum.profiles ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE forum.profiles DROP CONSTRAINT profiles_user_id_fkey;
ALTER TABLE forum.profiles
  ADD CONSTRAINT profiles_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

COMMIT;

-- Rollback (saved only, not executed):
-- BEGIN;
-- ALTER TABLE forum.profiles DROP CONSTRAINT profiles_user_id_fkey;
-- ALTER TABLE forum.profiles
--   ADD CONSTRAINT profiles_user_id_fkey
--   FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;
-- ALTER TABLE forum.profiles ALTER COLUMN user_id SET NOT NULL;
-- COMMIT;
-- (Only safe to roll back while every forum.profiles.user_id is still non-null.)
