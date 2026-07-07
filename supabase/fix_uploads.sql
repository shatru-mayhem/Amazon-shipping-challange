-- Fixes document upload on Vercel. Run in Supabase SQL Editor. Idempotent.
-- Root causes: (1) transaction pooler drops per-connection search_path;
-- (2) dashboard-created buckets ship with ZERO storage.objects policies;
-- (3) app_ingestion grants may never have been applied to this project;
-- (4) audit_events table was never created (log noise on every upload).

-- 1. Make search_path a role default (survives transaction pooling).
alter role app_ingestion in database postgres
  set search_path = core, constraints;

-- 2. Storage policies for the tender_documents bucket.
drop policy if exists "authenticated_upload_tender_documents" on storage.objects;
create policy "authenticated_upload_tender_documents" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'tender_documents');

drop policy if exists "authenticated_read_tender_documents" on storage.objects;
create policy "authenticated_read_tender_documents" on storage.objects
  for select to authenticated
  using (bucket_id = 'tender_documents');

-- 3. Grants for the ingestion role (no-ops if already applied).
grant usage on schema core, constraints to app_ingestion;
grant select on core.opportunities, core.customers to app_ingestion;
grant select, insert on core.documents, core.document_chunks to app_ingestion;
grant select, insert on core.email_threads, core.email_messages to app_ingestion;

-- 4. Audit trail table (app/actions/audit.ts writes here; failures are
--    swallowed but spam the function logs on every upload).
create table if not exists public.audit_events (
  id bigserial primary key,
  actor_id uuid,
  opportunity_id text,
  event_type text not null,
  before_value text,
  after_value text,
  created_at timestamptz not null default now()
);
alter table public.audit_events enable row level security;
drop policy if exists "authenticated insert own audit" on public.audit_events;
create policy "authenticated insert own audit" on public.audit_events
  for insert to authenticated with check (actor_id = auth.uid());
drop policy if exists "admins read audit" on public.audit_events;
create policy "admins read audit" on public.audit_events
  for select using (public.is_admin());

select 'fix_uploads applied' as status;
