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

-- ---------------------------------------------------------------------
-- 5. Extend app_ingestion so skills/constraint_compliance/constraint_compliance.py
--    can write the constraint_compliance_check step's verdicts (was
--    missing entirely — risk_assessment.py and commercial_strategy.py
--    were reading from an always-empty table). Same delete-then-insert
--    idempotency as §4, so DELETE is needed alongside SELECT/INSERT;
--    amazon_capability_profile is read-only reference data, SELECT only.
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, DELETE ON constraints.constraint_compliance_results TO app_ingestion;
GRANT SELECT ON constraints.amazon_capability_profile TO app_ingestion;

CREATE POLICY "app_ingestion_rw" ON constraints.constraint_compliance_results FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
CREATE POLICY "app_ingestion_select" ON constraints.amazon_capability_profile FOR SELECT TO app_ingestion USING (true);

-- ---------------------------------------------------------------------
-- 6. Extend app_ingestion so skills/win_loss_signals/win_loss_signals.py
--    can persist signal_check_results (win_loss_signal_catalog was
--    empty, so win_probability.py always just returned the raw
--    historical base rate — no signal ever adjusted it). nl_query_readonly
--    already had SELECT on both these tables from the original DB setup;
--    only app_ingestion (write side) was missing.
--
--    Also seeds the one signal validated by
--    skills/exploration/historical_archetypes.py's PCA/clustering pass
--    over the real historical_tenders data (see
--    supabase/migrate_historical_data.sql): opportunities requiring
--    delivery to a region Amazon doesn't cover win 35.3% of the time vs.
--    61.8% otherwise, and the dominant loss reason for that segment is
--    specifically "Geographic gap" (47/74), not generic competitive loss
--    ("Lost to competitor" was only 5/74) — evidence of a real
--    capability-driven loss pattern, not noise. strength (0.73) is a
--    log-odds delta: logit(0.618) - logit(0.353).
-- ---------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE ON knowledge.win_loss_signal_catalog TO app_ingestion;
GRANT SELECT, INSERT, DELETE ON knowledge.signal_check_results TO app_ingestion;
CREATE POLICY "app_ingestion_rw" ON knowledge.win_loss_signal_catalog FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
CREATE POLICY "app_ingestion_rw" ON knowledge.signal_check_results FOR ALL TO app_ingestion USING (true) WITH CHECK (true);

INSERT INTO knowledge.win_loss_signal_catalog (factor_name, direction, strength, maps_to_feature, model_version)
VALUES (
  'Requires delivery to a region outside Amazon''s covered network',
  'loss',
  0.73,
  'geography',
  'historical_tenders_v1_2026'
)
ON CONFLICT (factor_name) DO UPDATE SET
  strength = EXCLUDED.strength,
  maps_to_feature = EXCLUDED.maps_to_feature,
  model_version = EXCLUDED.model_version,
  refreshed_at = now();

-- ---------------------------------------------------------------------
-- 7. amazon_capability_update_queue — ground-truth capability updates
--    (skills/capability_ingestion/) are a fundamentally different kind
--    of ingestion from tender_constraints: a wrong extraction here
--    silently corrupts every future opportunity's compliance/risk/
--    pricing checked against that constraint type, not just one
--    opportunity. So proposals always land here first; nothing writes
--    to amazon_capability_profile without an explicit human approval.
-- ---------------------------------------------------------------------

CREATE TABLE constraints.amazon_capability_update_queue (
    update_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    constraint_type_id       UUID NOT NULL REFERENCES constraints.constraint_catalog(constraint_type_id),
    proposed_capability_status TEXT NOT NULL
                             CHECK (proposed_capability_status IN ('can_do','cannot_do','can_do_with_conditions')),
    proposed_structured_value JSONB,
    proposed_conditions_text TEXT,
    source_document_id      UUID REFERENCES core.documents(document_id),
    source_chunk_id         UUID REFERENCES core.document_chunks(chunk_id),
    raw_text                TEXT NOT NULL,
    confidence               NUMERIC CHECK (confidence BETWEEN 0 AND 1),
    is_demo                  BOOLEAN NOT NULL DEFAULT FALSE,
    status                   TEXT NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','approved','rejected','reset')),
    reviewer_id               TEXT,
    reviewed_at               TIMESTAMPTZ,
    created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Pre-image of amazon_capability_profile captured at approval time, so
    -- a demo-approved change can be undone later without guessing what the
    -- row looked like before (reset_demo_capability_changes(), 'reset_demo'
    -- CLI action / "Reset Demo" button — only ever touches is_demo=TRUE rows).
    previous_row_existed        BOOLEAN,
    previous_capability_status  TEXT,
    previous_structured_value   JSONB,
    previous_conditions_text    TEXT
);

GRANT SELECT, INSERT, UPDATE ON constraints.amazon_capability_update_queue TO app_ingestion;
CREATE POLICY "app_ingestion_rw" ON constraints.amazon_capability_update_queue FOR ALL TO app_ingestion USING (true) WITH CHECK (true);

GRANT SELECT ON constraints.amazon_capability_update_queue TO nl_query_readonly;
CREATE POLICY "nl_query_readonly_select" ON constraints.amazon_capability_update_queue FOR SELECT TO nl_query_readonly USING (true);

-- app_ingestion previously only had SELECT on amazon_capability_profile
-- (read-only reference data for every other pipeline) — approval writes
-- here now, as a true upsert (INSERT ... ON CONFLICT (constraint_type_id)),
-- since a constraint type might not have an existing row yet. FOR ALL,
-- not just UPDATE: INSERT ... ON CONFLICT DO UPDATE still needs INSERT
-- permission evaluated up front even when every row in practice already
-- exists and resolves via the conflict path (an UPDATE-only policy hit
-- "new row violates row-level security policy" in testing).
GRANT INSERT, UPDATE ON constraints.amazon_capability_profile TO app_ingestion;
CREATE POLICY "app_ingestion_rw" ON constraints.amazon_capability_profile FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
