-- =====================================================================
-- Observability schema — captures real token/latency data for every
-- LLM call (skills/_llm.py's embed()/generate_json()), so the software
-- analytics page has genuine telemetry to show instead of mock numbers.
-- Applied directly to the live project via the Supabase MCP tool
-- (mcp__supabase__apply_migration, migration
-- create_observability_llm_call_log_v2). Captured here so it's
-- reproducible from the repo, not just live-only state — same reasoning
-- as supabase/schema_hardening.sql.
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS observability;

CREATE TABLE observability.llm_call_log (
    call_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id      UUID REFERENCES core.opportunities(opportunity_id),
    skill               TEXT,               -- which retrieval.py function initiated the call; null for
                                             -- calls with no natural attribution (e.g. VectorStore's
                                             -- internal embed() calls)
    call_type           TEXT NOT NULL CHECK (call_type IN ('embed', 'generate_json')),
    model               TEXT NOT NULL,
    is_cloud            BOOLEAN NOT NULL,
    prompt_tokens       INT,                -- null for embed: Ollama's legacy /api/embeddings doesn't return counts
    completion_tokens   INT,
    total_tokens        INT,
    total_duration_ms   NUMERIC,
    load_duration_ms    NUMERIC,
    eval_duration_ms    NUMERIC,
    success             BOOLEAN NOT NULL,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX llm_call_log_created_at_idx ON observability.llm_call_log (created_at);
CREATE INDEX llm_call_log_opportunity_id_idx ON observability.llm_call_log (opportunity_id);

-- app_ingestion writes one row per LLM call (best-effort, see _llm.py);
-- nl_query_readonly is what skills/software_analytics.py reads through
-- (same as every other pure-read skill, via skills/_db.py).
GRANT USAGE ON SCHEMA observability TO app_ingestion, nl_query_readonly;
GRANT SELECT, INSERT ON observability.llm_call_log TO app_ingestion;
GRANT SELECT ON observability.llm_call_log TO nl_query_readonly;

ALTER TABLE observability.llm_call_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "app_ingestion_rw" ON observability.llm_call_log FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
CREATE POLICY "nl_query_readonly_select" ON observability.llm_call_log FOR SELECT TO nl_query_readonly USING (true);

-- ---------------------------------------------------------------------
-- draft_send_log — closes the loop on skills/follow_up_actions.py's
-- Zapier sends. A 200 from Zapier's Catch Hook only means "Zapier
-- received the payload," not "the Gmail draft exists" (that's a later
-- step in the Zap, and can fail independently — wrong scope, revoked
-- Gmail auth, etc). Every send logs a row here as 'sent_to_zapier';
-- app/api/zapier-draft-callback/route.ts flips it to 'completed'/
-- 'failed' once a step added to the END of the Zap (after Gmail's
-- "Create Draft") calls back with the draft_id. The dashboard polls
-- get_draft_status() so the UI shows real completion, not just "sent."
-- ---------------------------------------------------------------------

CREATE TABLE observability.draft_send_log (
    draft_id        UUID PRIMARY KEY,
    opportunity_id  UUID REFERENCES core.opportunities(opportunity_id),
    kind            TEXT NOT NULL CHECK (kind IN ('client_reply', 'internal_summary')),
    to_email        TEXT NOT NULL,
    subject         TEXT,
    status          TEXT NOT NULL DEFAULT 'sent_to_zapier'
                    CHECK (status IN ('sent_to_zapier', 'completed', 'failed')),
    gmail_draft_id  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX draft_send_log_created_at_idx ON observability.draft_send_log (created_at);

GRANT SELECT, INSERT, UPDATE ON observability.draft_send_log TO app_ingestion;
GRANT SELECT ON observability.draft_send_log TO nl_query_readonly;

ALTER TABLE observability.draft_send_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "app_ingestion_rw" ON observability.draft_send_log FOR ALL TO app_ingestion USING (true) WITH CHECK (true);
CREATE POLICY "nl_query_readonly_select" ON observability.draft_send_log FOR SELECT TO nl_query_readonly USING (true);
