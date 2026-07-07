# Deployment & Auth Setup (fixes MIDDLEWARE_INVOCATION_FAILED)

## 1. Vercel environment variables — required, fixes the 500

The 500 error happens because the deployment has no Supabase credentials
(`.env.local` is gitignored and never reaches Vercel).

Vercel → your project → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://iehzlcsdzbrbeupdufcu.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your anon key (Supabase → Settings → API) |
| `APP_INGESTION_DB_URL` | connection string for the `app_ingestion` role — see `supabase/schema_hardening.sql` §2 |

Then **redeploy**. The middleware is now also defensive: if env vars are
missing it logs an error instead of crashing the site.

Locally, `.env` already has `SUPABASE_URL`/`SUPABASE_API_KEY` (used by the
Python skills) aliased to `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`
for the frontend — keep both pairs in sync if the key is ever rotated.

### Schema note

The tables this app actually reads/writes today (`core.opportunities`,
`core.documents`, `core.email_threads`, etc. — see `tender-analysis-schema.sql`)
are **not** the same tables some of the original server actions
(`app/actions/documents.ts`, `opportunities.ts`, `qna.ts`, `audit.ts`) were
written against (`evidence_documents`, `intake_profiles`, `qna_threads`,
`audit_events` — none of which exist in the live database). Those legacy
actions are left as-is for now; `app/actions/tender_ingestion.ts` and
`email_ingestion.ts` are the ones written against the real, live schema.

## 2. Create the head account (one time, ~1 min)

Supabase Dashboard → **Authentication → Users → Add user**:

- Email: `singhshatrughna.singh22@gmail.com`
- Password: `654321`  ← this is the standing access code
- Check **Auto Confirm User**

## 3. Run the setup SQL (one time, ~1 min)

Supabase Dashboard → **SQL Editor** → paste and run `supabase/setup.sql`.
It creates the `employee_roster` table, a trigger that auto-creates a
profile on signup (Admin for the head email, Employee for rostered emails,
Client for everyone else), and backfills the head account's Admin profile.

## 4. Make the OTP email show the code (one time)

Supabase Dashboard → **Authentication → Email Templates → Magic Link**:
make sure the body includes `{{ .Token }}` — e.g.

    <p>Your ASCS access code: <strong>{{ .Token }}</strong></p>

Without this, clients receive a link instead of the 6-digit code.

## How sign-in works now

- **Head account:** Employee Portal → email + access code `654321` → lands
  on the Solution Architecture overview, then Unified Intelligence
  (/employee/dashboard). Team Management (add employees, assign
  hierarchy) lives under **Operations** (/employee/operations).
- **Employees:** once added to the roster by the head, they sign in with
  "Email me a code" — the trigger gives them the Employee role + assigned
  hierarchy on first login.
- **Clients:** enter their email → receive a 6-digit access code by email
  → verify → land on /client as role Client. New emails register
  automatically.

## Security note

The standing access code is a Supabase password. Change it in
Dashboard → Authentication → Users whenever needed. Consider rotating the
anon key if the repo ever becomes public with keys committed (they are not
committed by this project).

## 5. Document upload on Vercel (tender / email import)

Uploads fail without this one-time setup:

1. **Set the ingestion DB password** — Supabase → SQL Editor:

       alter role app_ingestion with password 'PICK-A-STRONG-PASSWORD';

2. **Add the env var in Vercel** → Settings → Environment Variables:

       APP_INGESTION_DB_URL=postgresql://app_ingestion:PICK-A-STRONG-PASSWORD@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require

   Use the **pooler** host from Supabase → Settings → Database →
   Connection string → "Transaction pooler" (serverless functions need
   pooled connections), swapping user/password for app_ingestion.
   Then **redeploy**.

3. **Create the storage bucket** — Supabase → Storage → New bucket:
   name `tender_documents`, **private**.

4. **Size limit:** Vercel serverless caps request bodies at ~4.5 MB.
   Larger files are rejected client-side with a clear message. The 25 MB
   code limit only applies when self-hosting.
