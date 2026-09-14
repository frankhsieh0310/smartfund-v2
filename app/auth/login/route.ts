import { NextResponse } from "next/server";

import { createSupabaseServerClient } from "@/lib/auth/supabaseAuth";

function safeNext(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeNext(url.searchParams.get("next"));
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${url.origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });

  if (error || !data.url) {
    return NextResponse.redirect(new URL("/?auth=error", url.origin));
  }

  return NextResponse.redirect(data.url);
}
