# Deployment & Auth Setup (fixes MIDDLEWARE_INVOCATION_FAILED)

## 1. Vercel environment variables — required, fixes the 500

The 500 error happens because the deployment has no Supabase credentials
(`.env.local` is gitignored and never reaches Vercel).

Vercel → your project → **Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://iehzlcsdzbrbeupdufcu.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | your anon key (Supabase → Settings → API) |

Then **redeploy**. The middleware is now also defensive: if env vars are
missing it logs an error instead of crashing the site.

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
  on /employee with the Team Management panel (add employees, assign
  hierarchy: Executive / Manager / Associate).
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
