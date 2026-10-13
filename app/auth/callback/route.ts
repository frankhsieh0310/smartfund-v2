import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/auth/supabaseAuth";
import { resolveSmartMatchUser } from "@/lib/auth/userService";

function safeNext(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNext(url.searchParams.get("next"));

  if (!code) return NextResponse.redirect(new URL("/?auth=error", url.origin));

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return NextResponse.redirect(new URL("/?auth=error", url.origin));
  }

  await resolveSmartMatchUser(data.user);
  return NextResponse.redirect(new URL(next, url.origin));
}
