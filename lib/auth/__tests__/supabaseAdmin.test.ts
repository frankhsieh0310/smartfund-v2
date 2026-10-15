import assert from "node:assert/strict";
import { createSupabaseAdminClient } from "../supabaseAdmin.ts";

function test(name: string, fn: () => void) {
  try { fn(); console.log(`PASS: ${name}`); } catch (e) { console.log(`FAIL: ${name} — ${(e as Error).message}`); process.exitCode = 1; }
}

const ORIGINAL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORIGINAL_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
function restore() {
  if (ORIGINAL_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_KEY;
  if (ORIGINAL_URL === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = ORIGINAL_URL;
}

test("throws a clear error when SUPABASE_SERVICE_ROLE_KEY is not set, rather than failing obscurely later", () => {
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  assert.throws(() => createSupabaseAdminClient(), /SUPABASE_SERVICE_ROLE_KEY/);
  restore();
});

test("succeeds (returns a client) once both env vars are set", () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  const client = createSupabaseAdminClient();
  assert.ok(client);
  restore();
});
