-- Supabase RLS security Phase 2
-- Evidence review found no browser/mobile direct table, RPC, realtime, or
-- PostgREST reads. The remaining 314 RLS-disabled public tables are reached
-- through server-side Prisma/API routes or privileged ingestion workers.
--
-- Do not add client policies here. Direct privileged PostgreSQL roles and
-- service_role retain their existing access.

DO $phase2$
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

  IF disabled_count <> 314 THEN
    RAISE EXCEPTION
      'RLS Phase 2 precondition failed: expected 314 RLS-disabled public tables, found %',
      disabled_count;
  END IF;

  FOR target IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target.schema_name, target.table_name);
    EXECUTE format('REVOKE SELECT ON TABLE %I.%I FROM anon, authenticated', target.schema_name, target.table_name);
  END LOOP;
END
$phase2$;
