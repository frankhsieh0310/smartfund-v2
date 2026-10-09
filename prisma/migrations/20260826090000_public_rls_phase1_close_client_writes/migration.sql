-- Supabase RLS security Phase 1
-- Scope is deliberately limited to the 372 public tables that had RLS disabled
-- during the 2026-08-26 production preflight.
--
-- Phase 1 does not grant public reads and does not change existing RLS policies.
-- Direct privileged PostgreSQL roles and service_role retain their existing access.

DO $phase1$
DECLARE
  disabled_count integer;
  target record;
BEGIN
  SELECT count(*)::integer
    INTO disabled_count
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND NOT c.relrowsecurity;

  IF disabled_count <> 372 THEN
    RAISE EXCEPTION
      'RLS Phase 1 precondition failed: expected 372 RLS-disabled public tables, found %',
      disabled_count;
  END IF;

  -- No browser or mobile client is permitted to mutate an RLS-disabled table.
  FOR target IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE %I.%I FROM anon, authenticated',
      target.schema_name,
      target.table_name
    );
  END LOOP;

  -- Fail-closed operational/server-only inventory. These tables are consumed by
  -- Prisma/direct-DB jobs, never directly by a publishable-key client.
  FOR target IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
      AND (
        c.relname = '_prisma_migrations'
        OR c.relname LIKE 'production_scheduler\_%' ESCAPE '\'
        OR c.relname LIKE 'dataset\_%' ESCAPE '\'
        OR c.relname IN ('history_jobs', 'history_failed_queue', 'provider_logs', 'update_logs')
        OR c.relname LIKE '%\_work_items' ESCAPE '\'
        OR c.relname LIKE '%\_coverage' ESCAPE '\'
        OR c.relname LIKE '%\_coverage\_%' ESCAPE '\'
        OR c.relname LIKE '%\_checkpoint%' ESCAPE '\'
        OR c.relname LIKE '%\_lock%' ESCAPE '\'
        OR c.relname LIKE '%\_failure%' ESCAPE '\'
        OR c.relname LIKE '%\_mapping\_queue' ESCAPE '\'
        OR c.relname LIKE '%\_resolution\_queue' ESCAPE '\'
        OR c.relname LIKE '%\_reconciliation%' ESCAPE '\'
        OR c.relname LIKE '%\_provenance' ESCAPE '\'
        OR c.relname LIKE '%\_license\_register' ESCAPE '\'
        OR c.relname LIKE '%\_source\_cursors' ESCAPE '\'
        OR c.relname LIKE '%\_source\_states' ESCAPE '\'
        OR c.relname LIKE '%\_source\_archives' ESCAPE '\'
      )
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target.schema_name, target.table_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM anon, authenticated', target.schema_name, target.table_name);
  END LOOP;
END
$phase1$;
