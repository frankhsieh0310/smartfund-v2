import { createClient } from "@supabase/supabase-js";

// Account deletion needs Supabase's admin API (auth.admin.deleteUser), which requires the
// service-role key -- the publishable key lib/auth/supabaseAuth.ts uses for normal requests
// cannot do this. SUPABASE_SERVICE_ROLE_KEY is NOT currently set in this environment (checked
// this round) -- this throws clearly rather than silently failing until it's added.
export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY (and NEXT_PUBLIC_SUPABASE_URL) must be set to use the Supabase admin API");
  }
  return createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}
