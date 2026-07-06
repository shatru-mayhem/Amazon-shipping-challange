import { createBrowserClient } from "@supabase/ssr";

// Browser client. Anon key only — RLS enforces all access rules.
export function createSupabaseBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
