// TypeScript interfaces mapped 1:1 to the Supabase tables defined in webdev.md §2.
// If a column differs in the live database, update it here first — all server
// actions and components consume these types.

export type UserRole = "Client" | "Employee" | "Admin";
export type HierarchyLevel = "Executive" | "Manager" | "Associate";
export type QnaStatus = "open" | "viewed" | "reviewed" | "answered";
export type DocSourceType = "client_upload" | "internal_evidence";

export interface DbUser {
  id: string; // UUID, mirrors auth.users.id
  email: string;
  role: UserRole;
  hierarchy_level: HierarchyLevel | null;
  team: string | null;
  created_at: string;
}

export interface Opportunity {
  id: string;
  company_name: string;
  industry: string;
  owner_id: string;
  status: string;
  created_at: string;
}

export interface IntakeProfile {
  opportunity_id: string;
  current_model: string | null;
  volume_band: string | null;
  parcel_profile: string | null;
  origin_destination_patterns: string | null;
  warehousing_needs: string | null;
  peak_seasonality: string | null;
  carrier_mix: string | null;
  integration_readiness: string | null;
  customer_goals: string | null;
  constraints: string | null;
}

export interface Assessment {
  opportunity_id: string;
  ascs_fit_band: "Strong" | "Moderate" | "Limited" | "Needs more data";
  amazon_shipping_role: "supporting" | "central" | "limited" | "not relevant";
}

export interface Recommendation {
  opportunity_id: string;
  band: string;
  rationale: string;
  ascs_configuration: string;
  generated_by_model: string;
}

export interface EvidenceDocument {
  id: string;
  opportunity_id: string;
  source_type: DocSourceType;
  file_path: string;
  uploaded_by: string;
}

export interface DecisionMemo {
  opportunity_id: string;
  memo_body: string;
  status: string;
  approved_by: string | null;
}

export interface AuditEvent {
  id: string;
  actor_id: string;
  opportunity_id: string | null;
  event_type: string;
  before_value: string | null;
  after_value: string | null;
}

export interface QnaThread {
  id: string;
  opportunity_id: string;
  category: string;
  question: string;
  answer: string | null;
  client_id: string;
  employee_id: string | null;
  status: QnaStatus;
}

// ---------------------------------------------------------------------
// Live schema (core/constraints schemas — see tender-analysis-schema.sql).
// The interfaces above (Opportunity, EvidenceDocument, IntakeProfile, ...)
// were written against a design that was never deployed; these mirror
// what's actually in the database and what tender_ingestion.ts /
// email_ingestion.ts / retrieval.py read and write. Prefixed Core* to
// avoid colliding with the legacy names above (different id conventions:
// opportunity_id vs id, customer_id vs owner_id).
// ---------------------------------------------------------------------

export type DocumentSourceType = "challenge_doc" | "market_intel" | "benchmark" | "internal_policy";

export interface CoreCustomer {
  customer_id: string;
  name: string;
  industry: string | null;
  region: string | null;
  crm_external_id: string | null;
  created_at: string;
}

export interface CoreOpportunity {
  opportunity_id: string;
  customer_id: string;
  title: string;
  status: string;
  estimated_value: number | null;
  created_at: string;
}

export interface CoreDocument {
  document_id: string;
  opportunity_id: string | null;
  filename: string;
  source_type: DocumentSourceType;
  blob_url: string;
  file_hash: string;
  ingested_at: string;
}

export interface CoreDocumentChunk {
  chunk_id: string;
  document_id: string;
  section_heading: string | null;
  page_number: number | null;
  raw_text: string;
  created_at: string;
}

export interface CoreEmailThread {
  thread_id: string;
  customer_id: string;
  opportunity_id: string | null;
  subject: string | null;
  started_at: string | null;
}

export interface CoreEmailMessage {
  message_id: string;
  thread_id: string;
  sent_at: string;
  sender: string;
  body_redacted: string;
  resolved: boolean;
}
