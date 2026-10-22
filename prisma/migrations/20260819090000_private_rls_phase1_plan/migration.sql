-- PLAN ONLY: do not apply without staging validation and an explicit production change window.
-- Phase 1 is intentionally limited to the 35 user-private/user-associated tables.
-- auth.uid() maps to users.supabase_id; application foreign keys map to users.id.
-- RLS is not forced so the existing privileged PostgreSQL owner/service path can continue
-- backend and Desktop ingestion work. anon and PUBLIC receive no direct table access.

DO $phase1$
DECLARE
  item record;
  backend_table text;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('users',
       'supabase_id = (select auth.uid())::text',
       'supabase_id = (select auth.uid())::text',
       'crud'),
      ('investor_questionnaires',
       'exists (select 1 from public.users u where u.id = investor_questionnaires.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = investor_questionnaires.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('user_criteria',
       'exists (select 1 from public.users u where u.id = user_criteria.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = user_criteria.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('criteria_conditions',
       'exists (select 1 from public.user_criteria p join public.users u on u.id = p.user_id where p.id = criteria_conditions.criteria_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.user_criteria p join public.users u on u.id = p.user_id where p.id = criteria_conditions.criteria_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('criteria_results',
       'exists (select 1 from public.user_criteria p join public.users u on u.id = p.user_id where p.id = criteria_results.criteria_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.user_criteria p join public.users u on u.id = p.user_id where p.id = criteria_results.criteria_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('criteria_matches',
       'exists (select 1 from public.user_criteria p join public.users u on u.id = p.user_id where p.id = criteria_matches.criteria_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.user_criteria p join public.users u on u.id = p.user_id where p.id = criteria_matches.criteria_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('criteria_versions',
       'exists (select 1 from public.user_criteria p join public.users u on u.id = p.user_id where p.id = criteria_versions.criteria_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.user_criteria p join public.users u on u.id = p.user_id where p.id = criteria_versions.criteria_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('matching_logs',
       'exists (select 1 from public.user_criteria p join public.users u on u.id = p.user_id where p.id = matching_logs.criteria_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.user_criteria p join public.users u on u.id = p.user_id where p.id = matching_logs.criteria_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('search_logs',
       'exists (select 1 from public.users u where u.id = search_logs.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = search_logs.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('compare_sessions',
       'exists (select 1 from public.users u where u.id = compare_sessions.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = compare_sessions.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('compare_items',
       'exists (select 1 from public.compare_sessions p join public.users u on u.id = p.user_id where p.id = compare_items.session_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.compare_sessions p join public.users u on u.id = p.user_id where p.id = compare_items.session_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('strategies',
       'exists (select 1 from public.users u where u.id = strategies.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = strategies.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('strategy_items',
       'exists (select 1 from public.strategies p join public.users u on u.id = p.user_id where p.id = strategy_items.strategy_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.strategies p join public.users u on u.id = p.user_id where p.id = strategy_items.strategy_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('strategy_shares',
       'exists (select 1 from public.strategies p join public.users u on u.id = p.user_id where p.id = strategy_shares.strategy_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.strategies p join public.users u on u.id = p.user_id where p.id = strategy_shares.strategy_id and p.user_id = strategy_shares.shared_by_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('strategy_favorites',
       'exists (select 1 from public.users u where u.id = strategy_favorites.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = strategy_favorites.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('favorites',
       'exists (select 1 from public.users u where u.id = favorites.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = favorites.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('strategy_history',
       'exists (select 1 from public.strategies p join public.users u on u.id = p.user_id where p.id = strategy_history.strategy_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.strategies p join public.users u on u.id = p.user_id where p.id = strategy_history.strategy_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('workspaces',
       'exists (select 1 from public.users u where u.id = workspaces.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = workspaces.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('workspace_modules',
       'exists (select 1 from public.workspaces p join public.users u on u.id = p.user_id where p.id = workspace_modules.workspace_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.workspaces p join public.users u on u.id = p.user_id where p.id = workspace_modules.workspace_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('workspace_versions',
       'exists (select 1 from public.workspaces p join public.users u on u.id = p.user_id where p.id = workspace_versions.workspace_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.workspaces p join public.users u on u.id = p.user_id where p.id = workspace_versions.workspace_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('notifications',
       'exists (select 1 from public.users u where u.id = notifications.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = notifications.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('notification_settings',
       'exists (select 1 from public.users u where u.id = notification_settings.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = notification_settings.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('saved_filters',
       'exists (select 1 from public.users u where u.id = saved_filters.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = saved_filters.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('portfolios',
       'exists (select 1 from public.users u where u.id = portfolios.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = portfolios.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('portfolio_items',
       'exists (select 1 from public.portfolios p join public.users u on u.id = p.user_id where p.id = portfolio_items.portfolio_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.portfolios p join public.users u on u.id = p.user_id where p.id = portfolio_items.portfolio_id and u.supabase_id = (select auth.uid())::text)',
       'crud'),
      ('alerts',
       'exists (select 1 from public.users u where u.id = alerts.user_id and u.supabase_id = (select auth.uid())::text)',
       'exists (select 1 from public.users u where u.id = alerts.user_id and u.supabase_id = (select auth.uid())::text)',
       'crud')
    ) AS owned(table_name, using_expression, check_expression, access_kind)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', item.table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon', item.table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', item.table_name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', item.table_name);

    EXECUTE format('DROP POLICY IF EXISTS phase1_select_own ON public.%I', item.table_name);
    EXECUTE format('DROP POLICY IF EXISTS phase1_insert_own ON public.%I', item.table_name);
    EXECUTE format('DROP POLICY IF EXISTS phase1_update_own ON public.%I', item.table_name);
    EXECUTE format('DROP POLICY IF EXISTS phase1_delete_own ON public.%I', item.table_name);
    EXECUTE format('CREATE POLICY phase1_select_own ON public.%I FOR SELECT TO authenticated USING (%s)', item.table_name, item.using_expression);

    IF item.access_kind = 'crud' THEN
      EXECUTE format('GRANT INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', item.table_name);
      EXECUTE format('CREATE POLICY phase1_insert_own ON public.%I FOR INSERT TO authenticated WITH CHECK (%s)', item.table_name, item.check_expression);
      EXECUTE format('CREATE POLICY phase1_update_own ON public.%I FOR UPDATE TO authenticated USING (%s) WITH CHECK (%s)', item.table_name, item.using_expression, item.check_expression);
      EXECUTE format('CREATE POLICY phase1_delete_own ON public.%I FOR DELETE TO authenticated USING (%s)', item.table_name, item.using_expression);
    END IF;
  END LOOP;

  -- Operational/audit tables are server-only. RLS is enabled with no client policy.
  FOREACH backend_table IN ARRAY ARRAY[
    'audit_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', backend_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', backend_table);
  END LOOP;
END
$phase1$;
