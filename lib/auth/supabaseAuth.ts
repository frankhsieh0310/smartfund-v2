import { createServerClient } from "@supabase/ssr";
import { createClient, type User as SupabaseUser } from "@supabase/supabase-js";
import { cookies } from "next/headers";

function getSupabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error("Supabase Auth environment variables are not configured");
  }

  return { url, publishableKey };
}

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { url, publishableKey } = getSupabaseConfig();

  return createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        for (const { name, value, options } of cookiesToSet) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
}

function readBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function getBearerUser(token: string) {
  const { url, publishableKey } = getSupabaseConfig();
  const supabase = createClient(url, publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await supabase.auth.getUser(token);

  return error ? null : data.user;
}

async function getCookieUser(request: Request) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader || !/(?:^|;\s*)sb-[^=;]*-auth-token(?:\.\d+)?=/.test(cookieHeader)) {
    return null;
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();

  return error ? null : data.user;
}

export async function getAuthenticatedSupabaseUser(
  request: Request,
): Promise<SupabaseUser | null> {
  const bearerToken = readBearerToken(request);
  return bearerToken ? getBearerUser(bearerToken) : getCookieUser(request);
}
