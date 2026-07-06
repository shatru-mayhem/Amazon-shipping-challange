import { createClient } from "@supabase/supabase-js";

// Service-role client. BYPASSES RLS — server-only, never import in client code.
// Requires SUPABASE_SERVICE_ROLE_KEY in the server environment.
export function createSupabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Admin operations unavailable.",
    );
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
