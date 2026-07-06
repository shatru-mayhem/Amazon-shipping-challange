-- =====================================================================
-- TENDER ANALYSIS SYSTEM — CORE SCHEMA
-- =====================================================================
-- Flow this schema supports:
--   1. Ingestion & storage: tenders + emails land in raw tables;
--      only distilled, source-referenced records go into the vector store.
--   2. Constraint check: every tender is checked against the constraint
--      catalog (geography, size/volume, SLA, etc.) and Amazon's actual
--      capability profile — producing a pass/fail/unclear per constraint.
--   3. Downstream functions: every function declares what it needs in
--      function_input_requirements; a run is validated against that
--      registry, and anything missing is a row in run_flags, not a
--      silent gap.
-- =====================================================================


-- =====================================================================
-- SECTION 1 — CORE ENTITIES
-- =====================================================================

CREATE TABLE customers (
    customer_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    industry            TEXT,
    region              TEXT,
    crm_external_id     TEXT,               -- ID in Salesforce/HubSpot/etc.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE opportunities (
    opportunity_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL REFERENCES customers(customer_id),
    title               TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'intake'
                        CHECK (status IN ('intake','analysis','pricing','review','proposal_sent','won','lost','withdrawn')),
    estimated_value     NUMERIC,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE documents (
    document_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id       UUID REFERENCES opportunities(opportunity_id),
    filename            TEXT NOT NULL,
    source_type         TEXT NOT NULL
                        CHECK (source_type IN ('challenge_doc','market_intel','benchmark','internal_policy')),
    blob_url            TEXT NOT NULL,
    file_hash           TEXT NOT NULL,       -- for audit / dedup
    ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE document_chunks (
    chunk_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id         UUID NOT NULL REFERENCES documents(document_id),
    section_heading     TEXT,
    page_number         INT,
    raw_text            TEXT NOT NULL,       -- full text, cold storage only — never retrieved directly by reasoning functions
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE email_threads (
    thread_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL REFERENCES customers(customer_id),
    opportunity_id      UUID REFERENCES opportunities(opportunity_id),
    subject             TEXT,
    started_at          TIMESTAMPTZ
);

CREATE TABLE email_messages (
    message_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id           UUID NOT NULL REFERENCES email_threads(thread_id),
    sent_at             TIMESTAMPTZ NOT NULL,
    sender              TEXT NOT NULL,
    body_redacted       TEXT NOT NULL,        -- PII-redacted before storage
    resolved            BOOLEAN DEFAULT FALSE -- flips true once a follow-up question in this message is addressed
);

CREATE TABLE historical_tenders (
    tender_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    features            JSONB NOT NULL,       -- same schema as opportunity_features below
    price               NUMERIC,
    margin              NUMERIC,
    outcome             TEXT CHECK (outcome IN ('won','lost','pending')),
    customer_profile    JSONB,
    closed_at           TIMESTAMPTZ
);

CREATE TABLE opportunity_features (
    opportunity_id          UUID PRIMARY KEY REFERENCES opportunities(opportunity_id),
    volume                  NUMERIC,
    lanes                   JSONB,             -- e.g. [{"origin":"ES","destination":"FR"}]
    geography               TEXT[],
    industry_vertical       TEXT,
    contract_length_months  INT,
    required_sla_hours      NUMERIC,
    incumbent_provider      TEXT,
    requested_discount_pct  NUMERIC,
    -- per-field confidence, since extraction is LLM-driven and each field needs its own trust score
    field_confidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
    extracted_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =====================================================================
-- SECTION 1B — COST MATRIX (standalone rate lookup table)
-- =====================================================================

CREATE TABLE cost_matrix (
    cost_matrix_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mile_type           TEXT NOT NULL,        -- e.g. "first_mile", "last_mile", "middle_mile"
    daily_volume_band   TEXT NOT NULL,        -- e.g. "0-100", "100-500"
    weight_band         TEXT NOT NULL,        -- e.g. "0-1kg", "1-5kg"
    cost_eur            NUMERIC NOT NULL
);


-- =====================================================================
-- SECTION 2 — CONSTRAINTS: catalog, capability profile, per-tender checks
-- =====================================================================
-- "Constraints talk about what Amazon can do and what they can't."
-- Some are cleanly numeric (max weight, SLA hours), some are lists
-- (allowed regions), some are genuinely just qualitative text
-- (a legal clause) — data_type on constraint_catalog tells you which.

CREATE TABLE constraint_categories (
    category_id         SERIAL PRIMARY KEY,
    name                TEXT NOT NULL UNIQUE,   -- e.g. Geography, Volume/Size, SLA, Legal, Financial, Insurance, Customs, Data/Security, Packaging
    description         TEXT
);

CREATE TABLE constraint_catalog (
    constraint_type_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id         INT NOT NULL REFERENCES constraint_categories(category_id),
    name                TEXT NOT NULL,            -- e.g. "Maximum package weight", "Delivery SLA", "Data residency requirement"
    data_type           TEXT NOT NULL
                        CHECK (data_type IN ('numeric_range','boolean','enumerated_list','free_text')),
    unit                TEXT,                      -- kg, hours, currency — null for non-numeric types
    description         TEXT,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What Amazon Shipping can/cannot actually do, per constraint type.
-- This is the "capability profile" — the thing that didn't exist yet
-- in the earlier design and everything constraint-checking depends on.
CREATE TABLE amazon_capability_profile (
    capability_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    constraint_type_id  UUID NOT NULL REFERENCES constraint_catalog(constraint_type_id),
    capability_status   TEXT NOT NULL
                        CHECK (capability_status IN ('can_do','cannot_do','can_do_with_conditions')),
    structured_value    JSONB,                     -- e.g. {"max_weight_kg": 30} or {"regions": ["ES","FR","DE"]}
    conditions_text     TEXT,                      -- free text, used when capability_status = 'can_do_with_conditions'
    owner_team          TEXT NOT NULL,              -- who is accountable for keeping this current
    last_reviewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (constraint_type_id)                     -- one current capability row per constraint type; supersede, don't duplicate
);

-- Constraints as extracted from a specific tender's documents.
-- Always keep stated_text even when a structured value is derivable —
-- the raw wording is the audit evidence.
CREATE TABLE tender_constraints (
    tender_constraint_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id       UUID NOT NULL REFERENCES opportunities(opportunity_id),
    constraint_type_id   UUID REFERENCES constraint_catalog(constraint_type_id), -- NULL if not yet matched to catalog
    stated_value         JSONB,
    stated_text          TEXT NOT NULL,
    source_document_id   UUID NOT NULL REFERENCES documents(document_id),
    source_chunk_id      UUID REFERENCES document_chunks(chunk_id),
    confidence_score     NUMERIC CHECK (confidence_score BETWEEN 0 AND 1),
    extracted_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Queue for constraints found in a document that don't match any
-- existing catalog entry — small human-in-the-loop step before the
-- catalog grows, so it doesn't fill up with near-duplicate entries.
CREATE TABLE new_constraint_review_queue (
    review_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    proposed_name         TEXT NOT NULL,
    proposed_category_id  INT REFERENCES constraint_categories(category_id),
    source_document_id    UUID NOT NULL REFERENCES documents(document_id),
    raw_text              TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected','merged_into_existing')),
    merged_into_type_id   UUID REFERENCES constraint_catalog(constraint_type_id),
    reviewer_id           TEXT,
    reviewed_at           TIMESTAMPTZ
);

-- The actual per-tender, per-constraint compliance result —
-- this is the table the "check tender against constraints" step writes to,
-- and the table risk assessment / follow-up actions read from.
CREATE TABLE constraint_compliance_results (
    compliance_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id        UUID NOT NULL REFERENCES opportunities(opportunity_id),
    tender_constraint_id  UUID NOT NULL REFERENCES tender_constraints(tender_constraint_id),
    capability_id         UUID REFERENCES amazon_capability_profile(capability_id), -- NULL if no matching capability found at all
    result                TEXT NOT NULL
                          CHECK (result IN ('satisfied','unsatisfied','unclear_needs_verification')),
    gap_description       TEXT,
    severity              TEXT CHECK (severity IN ('low','medium','high')),
    checked_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =====================================================================
-- SECTION 3 — VECTOR STORE (pgvector) — only distilled, referenced records
-- =====================================================================
-- Rule: embed a record only if someone will plausibly search for
-- "something similar to this" later. Raw chunks (Section 1) are cold
-- storage for audit only and are never queried by reasoning functions.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE vector_records (
    vector_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type         TEXT NOT NULL
                        CHECK (source_type IN ('constraint_description','constraint_stated_requirement','client_highlight','risk_description')),
    source_table        TEXT NOT NULL,        -- polymorphic pointer: which table source_id belongs to
    source_id           UUID NOT NULL,
    opportunity_id      UUID REFERENCES opportunities(opportunity_id),  -- NULL for catalog-level records (e.g. constraint_catalog descriptions)
    embedded_text       TEXT NOT NULL,        -- the short, distilled text actually embedded — not a raw chunk
    embedding           VECTOR(1536) NOT NULL,
    metadata            JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX vector_records_embedding_idx ON vector_records USING ivfflat (embedding vector_cosine_ops);


-- =====================================================================
-- SECTION 4 — CLIENT HIGHLIGHTS (deck-facing extraction)
-- =====================================================================

CREATE TABLE client_highlights (
    highlight_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id       UUID NOT NULL REFERENCES opportunities(opportunity_id),
    highlight_type       TEXT NOT NULL
                        CHECK (highlight_type IN ('growth_objective','pain_point','stated_priority','past_complaint')),
    text                TEXT NOT NULL,
    source_type         TEXT NOT NULL CHECK (source_type IN ('document','email')),
    source_id           UUID NOT NULL,        -- points to documents.document_id or email_messages.message_id
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =====================================================================
-- SECTION 5 — WIN/LOSS SIGNALS
-- =====================================================================

CREATE TABLE win_loss_signal_catalog (
    signal_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    factor_name         TEXT NOT NULL UNIQUE,   -- e.g. "incumbent_provider_absent"
    direction           TEXT NOT NULL CHECK (direction IN ('win','loss')),
    strength            NUMERIC NOT NULL,        -- derived from SHAP value magnitude
    maps_to_feature     TEXT NOT NULL,           -- which opportunity_features column this checks, e.g. "incumbent_provider"
    model_version        TEXT NOT NULL,          -- which win-probability model version this was derived from
    refreshed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE signal_check_results (
    check_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    opportunity_id       UUID NOT NULL REFERENCES opportunities(opportunity_id),
    signal_id           UUID NOT NULL REFERENCES win_loss_signal_catalog(signal_id),
    status               TEXT NOT NULL CHECK (status IN ('present','absent_should_check','unknown_missing_data')),
    checked_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =====================================================================
-- SECTION 6 — FUNCTION INPUT REGISTRY  ("what does each function need to run?")
-- =====================================================================
-- This is the mechanism that turns "if any constraints/inputs are
-- missing, we flag it" from a manual check into a query. Every
-- function declares its required inputs as rows here, keyed by
-- table + field. A run validator checks these against what actually
-- exists for a given opportunity_id before invoking the function,
-- and writes gaps to run_flags instead of failing silently.

CREATE TABLE function_registry (
    function_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    function_name        TEXT NOT NULL UNIQUE,   -- e.g. "pricing_engine", "risk_assessment"
    description          TEXT
);

CREATE TABLE function_input_requirements (
    requirement_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    function_id           UUID NOT NULL REFERENCES function_registry(function_id),
    required_source_table TEXT NOT NULL,          -- e.g. "opportunity_features"
    required_source_field TEXT NOT NULL,          -- e.g. "volume", or "*" for "needs the whole row"
    is_required           BOOLEAN NOT NULL DEFAULT TRUE  -- FALSE = optional/nice-to-have, degrades gracefully
);

-- Every pipeline run, per function, records what was actually
-- available vs. what the registry said was required.
CREATE TABLE run_executions (
    run_execution_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id                UUID NOT NULL,          -- groups all function calls for one end-to-end analysis
    opportunity_id        UUID NOT NULL REFERENCES opportunities(opportunity_id),
    function_id           UUID NOT NULL REFERENCES function_registry(function_id),
    status                TEXT NOT NULL CHECK (status IN ('success','missing_required_input','failed')),
    started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at          TIMESTAMPTZ
);

CREATE TABLE run_flags (
    flag_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_execution_id      UUID NOT NULL REFERENCES run_executions(run_execution_id),
    flag_type             TEXT NOT NULL
                          CHECK (flag_type IN ('missing_required_input','low_confidence_field','new_constraint_found','constraint_unsatisfied','constraint_unclear')),
    detail                JSONB NOT NULL,          -- e.g. {"missing_field": "opportunity_features.required_sla_hours"}
    severity              TEXT CHECK (severity IN ('low','medium','high')),
    resolved              BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_by           TEXT,
    resolved_at           TIMESTAMPTZ
);


-- =====================================================================
-- SECTION 7 — SEED DATA: constraint categories
-- =====================================================================
-- Placeholder categories — replace/extend once your source documents
-- are uploaded. These map directly to the examples you gave (size, geography).

INSERT INTO constraint_categories (name, description) VALUES
    ('Geography',       'Where the service must operate — countries, regions, specific lanes'),
    ('Volume / Size',   'Package size, weight, and volume thresholds'),
    ('SLA',             'Delivery time commitments and service level requirements'),
    ('Insurance',       'Liability and insurance coverage requirements'),
    ('Customs',         'Cross-border documentation and customs handling requirements'),
    ('Data / Security', 'Data residency, security certification, and privacy requirements'),
    ('Financial',       'Payment terms, currency, penalty clauses'),
    ('Legal',           'Contractual terms, exclusivity clauses, termination conditions');


-- =====================================================================
-- SECTION 8 — SEED DATA: function registry + input requirements
-- =====================================================================
-- Encodes the input map worked out earlier, so "what does this
-- function need to run" is queryable rather than living in a doc.

INSERT INTO function_registry (function_name, description) VALUES
    ('document_ingestion',          'Parses and chunks raw challenge documents'),
    ('email_crm_ingestion',         'Pulls prior correspondence and CRM history'),
    ('opportunity_profile_extraction', 'Extracts structured features from tender documents'),
    ('constraint_extraction',       'Extracts stated constraints from tender documents'),
    ('constraint_compliance_check', 'Checks extracted constraints against Amazon capability profile'),
    ('comparable_tender_matching',  'Deterministic MCDA matching against historical tenders'),
    ('signal_check',                'Checks opportunity against the win/loss signal catalog'),
    ('risk_assessment',             'Identifies operational, commercial, financial risks'),
    ('pricing_engine',              'Produces three pricing scenarios within guardrails'),
    ('win_probability',             'Estimates win probability per pricing scenario'),
    ('commercial_strategy',         'Recommends positioning and negotiation approach'),
    ('follow_up_actions',           'Surfaces open questions and required validations'),
    ('executive_summary',           'Synthesizes score, risk, and strategy into a summary'),
    ('client_highlight_extraction', 'Extracts client-facing growth objectives and priorities'),
    ('pitch_deck_generation',       'Generates the client-facing proposal/deck');

-- Example requirement rows — extend per function as needed.
-- required_source_field = '*' means "needs the full row/object", not one column.

INSERT INTO function_input_requirements (function_id, required_source_table, required_source_field, is_required)
SELECT function_id, 'documents', '*', TRUE FROM function_registry WHERE function_name = 'document_ingestion';

INSERT INTO function_input_requirements (function_id, required_source_table, required_source_field, is_required)
SELECT function_id, 'document_chunks', '*', TRUE FROM function_registry WHERE function_name = 'opportunity_profile_extraction';

INSERT INTO function_input_requirements (function_id, required_source_table, required_source_field, is_required)
SELECT function_id, 'document_chunks', '*', TRUE FROM function_registry WHERE function_name = 'constraint_extraction'
UNION ALL
SELECT function_id, 'constraint_catalog', '*', TRUE FROM function_registry WHERE function_name = 'constraint_extraction';

INSERT INTO function_input_requirements (function_id, required_source_table, required_source_field, is_required)
SELECT function_id, 'tender_constraints', '*', TRUE FROM function_registry WHERE function_name = 'constraint_compliance_check'
UNION ALL
SELECT function_id, 'amazon_capability_profile', '*', TRUE FROM function_registry WHERE function_name = 'constraint_compliance_check';

INSERT INTO function_input_requirements (function_id, required_source_table, required_source_field, is_required)
SELECT function_id, 'opportunity_features', 'volume', TRUE FROM function_registry WHERE function_name = 'comparable_tender_matching'
UNION ALL
SELECT function_id, 'opportunity_features', 'geography', TRUE FROM function_registry WHERE function_name = 'comparable_tender_matching'
UNION ALL
SELECT function_id, 'opportunity_features', 'industry_vertical', TRUE FROM function_registry WHERE function_name = 'comparable_tender_matching'
UNION ALL
SELECT function_id, 'opportunity_features', 'contract_length_months', TRUE FROM function_registry WHERE function_name = 'comparable_tender_matching'
UNION ALL
SELECT function_id, 'historical_tenders', '*', TRUE FROM function_registry WHERE function_name = 'comparable_tender_matching';

INSERT INTO function_input_requirements (function_id, required_source_table, required_source_field, is_required)
SELECT function_id, 'opportunity_features', '*', TRUE FROM function_registry WHERE function_name = 'risk_assessment'
UNION ALL
SELECT function_id, 'signal_check_results', '*', TRUE FROM function_registry WHERE function_name = 'risk_assessment'
UNION ALL
SELECT function_id, 'constraint_compliance_results', '*', TRUE FROM function_registry WHERE function_name = 'risk_assessment';

INSERT INTO function_input_requirements (function_id, required_source_table, required_source_field, is_required)
SELECT function_id, 'opportunity_features', 'requested_discount_pct', FALSE FROM function_registry WHERE function_name = 'pricing_engine'
UNION ALL
SELECT function_id, 'historical_tenders', 'price', TRUE FROM function_registry WHERE function_name = 'pricing_engine'
UNION ALL
SELECT function_id, 'historical_tenders', 'margin', TRUE FROM function_registry WHERE function_name = 'pricing_engine';

INSERT INTO function_input_requirements (function_id, required_source_table, required_source_field, is_required)
SELECT function_id, 'client_highlights', '*', TRUE FROM function_registry WHERE function_name = 'pitch_deck_generation'
UNION ALL
SELECT function_id, 'constraint_compliance_results', '*', TRUE FROM function_registry WHERE function_name = 'pitch_deck_generation';


-- =====================================================================
-- SECTION 9 — VALIDATION QUERY EXAMPLE
-- =====================================================================
-- "For this opportunity, is anything this function needs missing?"
-- This is the actual query the orchestrator runs before invoking a
-- function — the flag isn't something a person has to notice.

-- Example: check pitch_deck_generation readiness for a given opportunity
/*
SELECT r.required_source_table, r.required_source_field, r.is_required
FROM function_input_requirements r
JOIN function_registry f ON f.function_id = r.function_id
WHERE f.function_name = 'pitch_deck_generation'
  AND r.is_required = TRUE
  AND NOT EXISTS (
    -- pseudocode: actual check depends on required_source_table,
    -- e.g. for 'client_highlights' check a row exists for this opportunity_id
    SELECT 1 FROM client_highlights ch
    WHERE ch.opportunity_id = '<opportunity_id>'::uuid
    AND r.required_source_table = 'client_highlights'
  );
*/
