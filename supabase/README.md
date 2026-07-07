# Supabase SQL — what to run, in what order

Two kinds of files live here: **run-me scripts** (paste into the SQL
Editor) and **applied-via-MCP records** (already applied to the live DB
by an agent with direct access; kept for reproducibility — do not re-run
blindly).

## Run-me scripts, in order

1. `setup.sql` — users trigger, employee_roster, head-account backfill.
   Prerequisite: create the head auth user first (see /SETUP.md).
2. `fix_login.sql` — replaces recursive RLS policies (security-definer
   helpers). Required or every profile read fails.
3. `rag_knowledge_base.sql` — knowledge tables + search_knowledge().
   ⚠ Drops and recreates public.historical_opportunities WITH CASCADE.
   `migrate_historical_data.sql` backfills core.historical_tenders FROM
   that table, so if you ever re-run this file, re-run the migrate
   afterwards — and expect anything depending on the dropped table to
   need reapplying.

## Applied-via-MCP records (reference only)

- `schema_hardening.sql` — roles (nl_query_readonly, app_ingestion),
  constraints schema, capability queue.
- `observability_schema.sql` — observability.llm_call_log etc.
- `migrate_historical_data.sql` — core.historical_tenders backfill.

## Root-level seeds (reference / partially applied)

- `/constraint-capability-seed.sql` — constraints.* seed data.
- `/tender-analysis-schema.sql` — tender ingestion schema.
  ⚠ Creates UNQUALIFIED `customers` and `opportunities` tables. The app
  already has `public.opportunities` (webdev.md schema). Do not run this
  file against the public schema as-is — qualify a target schema first.
