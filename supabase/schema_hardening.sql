-- =====================================================================
-- Schema hardening applied directly to the live project via the
-- Supabase MCP tool (mcp__supabase__apply_migration). Captured here so
-- it's reproducible from the repo, not just live-only state — same
-- reasoning as supabase/setup.sql and supabase/fix_login.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. RLS was disabled on 5 pricing reference/output tables, leaving them
--    fully readable/writable by the anon key. Enabled with a read-only
--    policy for any authenticated user; writes still only happen via a
--    role that bypasses RLS (service role, or a dedicated role like
--    app_ingestion below) — never via the anon/authenticated client.
-- ---------------------------------------------------------------------

ALTER TABLE pricing.pricing_guardrails ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.region_multipliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.premium_service_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.pricing_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing.pricing_compliance_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "authenticated_read" ON pricing.pricing_guardrails FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON pricing.region_multipliers FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON pricing.premium_service_costs FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON pricing.pricing_scenarios FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_read" ON pricing.pricing_compliance_results FOR SELECT TO authenticated USING (true);

-- Enabling RLS above silently broke pricing_recommendations.py: it reads
-- pricing_guardrails via nl_query_readonly, which had no policy on these
-- 5 tables (RLS with zero matching policies = zero visible rows, not an
-- error — the query just silently returned nothing). Same lesson as
-- app_ingestion's missing DELETE/UPDATE grants below: a GRANT and an RLS
-- policy are both required, one doesn't imply the other.
GRANT SELECT ON pricing.pricing_guardrails, pricing.region_multipliers, pricing.premium_service_costs,
  pricing.pricing_scenarios, pricing.pricing_compliance_results TO nl_query_readonly;

CREATE POLICY "nl_query_readonly_select" ON pricing.pricing_guardrails FOR SELECT TO nl_query_readonly USING (true);
CREATE POLICY "nl_query_readonly_select" ON pricing.region_multipliers FOR SELECT TO nl_query_readonly USING (true);
CREATE POLICY "nl_query_readonly_select" ON pricing.premium_service_costs FOR SELECT TO nl_query_readonly USING (true);
CREATE POLICY "nl_query_readonly_select" ON pricing.pricing_scenarios FOR SELECT TO nl_query_readonly USING (true);
CREATE POLICY "nl_query_readonly_select" ON pricing.pricing_compliance_results FOR SELECT TO nl_query_readonly USING (true);

-- ---------------------------------------------------------------------
-- 2. app_ingestion — write-capable role for the Next.js tender-upload
--    and email/CRM-import server actions (app/actions/tender_ingestion.ts,
--    app/actions/email_ingestion.ts). Direct Postgres connection, not
--    PostgREST — same reasoning as nl_query_readonly (see
--    nl_query_gemini.py header comment): 'core'/'constraints' are not
--    exposed to the Supabase Data API, and RLS on these tables only
--    grants SELECT to nl_query_readonly, nothing to anon/authenticated.
--    Scoped to exactly the tables those two entry points write —
--    least privilege, not a general-purpose write role.
--
--    Replace the placeholder password before running, then set
--    APP_INGESTION_DB_URL in .env to the resulting connection string
--    (same host/port/db as SUPABASE_DB_URL, role app_ingestion).
-- ---------------------------------------------------------------------

CREATE ROLE app_ingestion LOGIN PASSWORD '<set a strong password, then update APP_INGESTION_DB_URL in .env>';

GRANT USAGE ON SCHEMA core, constraints TO app_ingestion;

GRANT SELECT ON core.opportunities, core.customers TO app_ingestion;
GRANT SELECT, INSERT ON core.documents, core.document_chunks TO app_ingestion;
GRANT SELECT, INSERT ON core.email_threads TO app_ingestion;
-- UPDATE needed too: persist.py flips email_messages.resolved after
-- retrieve() finds which messages a later reply resolves.
GRANT SELECT, INSERT, UPDATE ON core.email_messages TO app_ingestion;

CREATE POLICY "app_ingestion_select" ON core.opportunities FOR SELECT TO app_ingestion USING (true);
CREATE POLICY "app_ingestion_select" ON core.customers FOR SELECT TO app_ingestion USING (true);
CREATE POLICY "app_ingestion_rw" ON core.documents FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
CREATE POLICY "app_ingestion_rw" ON core.document_chunks FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
CREATE POLICY "app_ingestion_rw" ON core.email_threads FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
CREATE POLICY "app_ingestion_rw" ON core.email_messages FOR ALL TO app_ingestion USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 3. Storage bucket for tender document uploads (tender_ingestion.ts).
--    No buckets existed at all prior to this. Private bucket; the file
--    blob goes through Storage's own API (authenticated user session,
--    not the app_ingestion Postgres role — Storage isn't reachable over
--    a Postgres connection), so it needs its own RLS policies here.
-- ---------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('tender_documents', 'tender_documents', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "authenticated_upload_tender_documents" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'tender_documents');

CREATE POLICY "authenticated_read_tender_documents" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'tender_documents');

-- Same, for email/CRM export uploads (email_ingestion.ts).
INSERT INTO storage.buckets (id, name, public)
VALUES ('email_imports', 'email_imports', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "authenticated_upload_email_imports" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'email_imports');

CREATE POLICY "authenticated_read_email_imports" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'email_imports');

-- ---------------------------------------------------------------------
-- 4. Extend app_ingestion so skills/retrieval/persist.py can write
--    retrieve()'s answers into the 3 remaining structured tables it
--    didn't already have access to. Same role, same least-privilege
--    reasoning as §2 — this is the one piece that turns retrieval.py
--    from "answers a question on demand" into "the 8 downstream skills
--    (risk_assessment, commercial_strategy, ...) have real data to read,
--    permanently, without re-running extraction every time."
-- ---------------------------------------------------------------------

GRANT USAGE ON SCHEMA knowledge TO app_ingestion;

GRANT SELECT, INSERT, UPDATE ON core.opportunity_features TO app_ingestion;
-- DELETE needed too: persist.py replaces tender_constraints/client_highlights
-- wholesale on each run (delete-then-insert) so re-running after new
-- documents arrive doesn't leave stale rows from the previous extraction.
GRANT SELECT, INSERT, DELETE ON constraints.tender_constraints TO app_ingestion;
GRANT SELECT, INSERT, DELETE ON knowledge.client_highlights TO app_ingestion;
GRANT SELECT ON constraints.constraint_catalog TO app_ingestion;

CREATE POLICY "app_ingestion_rw" ON core.opportunity_features FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
CREATE POLICY "app_ingestion_rw" ON constraints.tender_constraints FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
CREATE POLICY "app_ingestion_rw" ON knowledge.client_highlights FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
CREATE POLICY "app_ingestion_select" ON constraints.constraint_catalog FOR SELECT TO app_ingestion USING (true);
