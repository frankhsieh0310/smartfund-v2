-- DEFERRED DEFINITION ONLY. This file is deliberately outside prisma/migrations.
-- Do not execute until the corresponding 13 tables have been created by their schema migration.
-- These definitions preserve the already-reviewed Phase 1 ownership paths without creating tables.

DO $phase1b$
DECLARE
  item record;
  backend_table text;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('watchlists',
       'exists (select 1 from public.users u where u.id = watchlists.owner_user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = watchlists.owner_user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('watchlist_items',
       'exists (select 1 from public.watchlists p join public.users u on u.id = p.owner_user_id where p.id = watchlist_items.watchlist_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.watchlists p join public.users u on u.id = p.owner_user_id where p.id = watchlist_items.watchlist_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('watchlist_membership_events',
       'exists (select 1 from public.watchlist_items i join public.watchlists p on p.id = i.watchlist_id join public.users u on u.id = p.owner_user_id where i.id = watchlist_membership_events.watchlist_item_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.watchlist_items i join public.watchlists p on p.id = i.watchlist_id join public.users u on u.id = p.owner_user_id where i.id = watchlist_membership_events.watchlist_item_id and u.id = watchlist_membership_events.actor_user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('alert_rules_p0',
       'exists (select 1 from public.users u where u.id = alert_rules_p0.owner_user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = alert_rules_p0.owner_user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('alert_rule_versions',
       'exists (select 1 from public.alert_rules_p0 p join public.users u on u.id = p.owner_user_id where p.id = alert_rule_versions.rule_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.alert_rules_p0 p join public.users u on u.id = p.owner_user_id where p.id = alert_rule_versions.rule_id and u.id = alert_rule_versions.created_by and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('alert_occurrences',
       'exists (select 1 from public.alert_rules_p0 p join public.users u on u.id = p.owner_user_id where p.id = alert_occurrences.rule_id and u.supabase_id = (select auth.uid())::text)',
       'false',
       'read'),
      ('alert_occurrence_events',
       'exists (select 1 from public.alert_occurrences o join public.alert_rules_p0 p on p.id = o.rule_id join public.users u on u.id = p.owner_user_id where o.id = alert_occurrence_events.alert_occurrence_id and u.supabase_id = (select auth.uid())::text)',
       'false',
       'read'),
      ('notification_profiles',
       'exists (select 1 from public.users u where u.id = notification_profiles.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = notification_profiles.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud')
    ) AS owned(table_name, using_expression, check_expression, access_kind)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', item.table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', item.table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', item.table_name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', item.table_name);
    EXECUTE format('CREATE POLICY phase1_select_own ON public.%I FOR SELECT TO authenticated USING (%s)', item.table_name, item.using_expression);
    IF item.access_kind = 'crud' THEN
      EXECUTE format('GRANT INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', item.table_name);
      EXECUTE format('CREATE POLICY phase1_insert_own ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)', item.table_name, item.check_expression);
      EXECUTE format('CREATE POLICY phase1_update_own ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', item.table_name, item.using_expression, item.check_expression);
      EXECUTE format('CREATE POLICY phase1_delete_own ON public.%I FOR DELETE TO authenticated USING (%s)', item.table_name, item.using_expression);
    END IF;
  END LOOP;

  FOREACH backend_table IN ARRAY ARRAY[
    'alert_rule_states',
    'watchlist_input_sources',
    'alert_evaluation_work_items',
    'alert_delivery_attempts',
    'alert_delivery_dead_letters'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', backend_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', backend_table);
  END LOOP;
END
$phase1b$;
