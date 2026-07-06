
## Backend (Supabase)

Server-side backend per `webdev.md`: Supabase (Postgres + Auth + Storage)
accessed only through Server Actions and middleware — no keys or queries in
the browser beyond the public anon key, with RLS enforcing access.

- `lib/supabase/` — server / browser / admin (service-role) clients
- `lib/db-types.ts` — TypeScript interfaces mapped 1:1 to the DB tables
- `middleware.ts` — session refresh + role routing (Client → /client, Employee/Admin → /employee)
- `app/actions/` — all six backend features (see `app/actions/README.md`)

Setup: copy `.env.example` to `.env.local` and fill in your Supabase URL and
anon key. `SUPABASE_SERVICE_ROLE_KEY` is optional (admin ops only, server-only).

Auth model: email OTP ("code access with email confirmation") via
`signInWithOtp`; the `users` table row determines the portal a user lands on.
The proposal chat is a deterministic rules engine returning typed
Risk/Opportunity/Cost JSON — the LLM swap point is marked in
`app/actions/proposal.ts`.
