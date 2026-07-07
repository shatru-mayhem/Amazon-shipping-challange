// Shared shape of the /api/skill responses that ExecutiveDashboard fetches
// (skills/*.py output) and that build-pitch-deck.ts consumes. Centralized
// here so both can import the same types without a component-to-component
// import.

export interface OpportunityScore {
  score: number;
  band: "hot" | "warm" | "cold";
  rationale: string;
  has_hard_blocker?: boolean;
}

export interface WinProbability {
  win_probability: number;
  base_rate: number;
  top_drivers: { factor: string; effect: number }[];
  rationale: string;
}

export interface Risk {
  category: string;
  severity: "low" | "medium" | "high";
  title: string;
  detail: string;
  hard_blocker?: boolean;
}

export interface RiskAssessment {
  overall_risk: "none" | "low" | "medium" | "high";
  risk_count: number;
  risks: Risk[];
  has_hard_blocker: boolean;
  hard_blockers: Risk[];
}

export interface CapabilityGap {
  constraint_name: string;
  result: "unsatisfied" | "unclear_needs_verification";
  severity: "low" | "medium" | "high";
  gap_description: string;
  is_hard_blocker: boolean;
}

export interface CommercialStrategy {
  positioning_statement: string;
  lead_with_strengths: string[];
  address_client_pains: string[];
  align_to_priorities: string[];
  objections_to_preempt: string[];
  negotiation_approach: string;
  capability_gaps_to_flag: CapabilityGap[];
  has_hard_blocker: boolean;
}

export interface CalculationStep {
  label: string;
  expression: string;
  result: number;
  unit?: string;
}

export interface PricingScenario {
  name: "aggressive" | "balanced" | "premium";
  target_margin_pct: number;
  price_per_package_eur: number;
  discount_pct_vs_list: number;
  daily_revenue_eur: number;
  contract_value_eur: number | null;
  rationale: string;
  tradeoffs: string;
  negotiation_strategy: string;
  guardrail_result?: string;
  // Step-by-step arithmetic behind this scenario's numbers — shown as a
  // collapsible "show the data behind this" section, not inline.
  calculation?: CalculationStep[];
}

export interface CostMatrixRow {
  mile_type: string;
  daily_volume_band: string;
  avg_cost_eur: number;
  weight_band_samples: number;
}

export interface PricingEvidence {
  cost_matrix_rows: CostMatrixRow[];
  region_multiplier_rows_matched: { region_name: string; cost_multiplier: number }[];
  guardrails_row: {
    effective_date: string | null;
    min_contribution_margin_pct: number;
    target_contribution_margin_pct: number;
    vp_approval_required_below_pct: number;
    auto_no_go_below_pct: number;
  };
}

export interface PricingRecommendations {
  recommended_scenario: string;
  scenarios: PricingScenario[];
  // Omitted entirely by pricing_recommendations.py on an early-exit error
  // (no volume captured, or no priced region for the stated geography) —
  // not just an empty array, so callers must not assume it's always present.
  guardrails?: string[];
  volume_packages_per_day: number | null;
  total_cost_per_package_eur?: number;
  region_multiplier_applied?: number;
  regions_priced?: string[];
  regions_without_cost_data?: string[];
  error?: string;
  financial_guardrails: {
    min_contribution_margin_pct: number;
    target_contribution_margin_pct: number;
    vp_approval_required_below_pct: number;
    auto_no_go_below_pct: number;
  } | null;
  // The raw cost_matrix/region_multiplier/pricing_guardrails rows and the
  // blended-cost arithmetic that total_cost_per_package_eur came from.
  cost_calculation?: CalculationStep[];
  evidence?: PricingEvidence;
}

export interface FollowUpAction {
  priority: "high" | "medium" | "low";
  action: string;
  detail: string;
  type?: string;
}

export interface FollowUpActions {
  open_action_count: number;
  actions: FollowUpAction[];
}

export interface ExecutiveSummary {
  headline: string;
  decision_prompt: string;
  has_hard_blocker?: boolean;
  hard_blockers?: Risk[];
}

export interface ClientProposal {
  sections: {
    cover: { title: string; subtitle: string };
    understanding_your_needs: { points: string[] };
    why_amazon_shipping: { positioning: string; differentiators: string[]; proof_points: string[] };
    commercial_proposal: { selected_scenario: string; scenario: PricingScenario | null };
    next_steps: { points: string[] };
  };
  internal_flags: {
    has_hard_blocker: boolean;
    hard_blockers: CapabilityGap[];
  };
}

export interface SourcesUsed {
  challenge_documents: { filename: string; source_type: string }[];
  email_correspondence: { threads: number; messages: number };
  extracted_evidence: { tender_constraints_extracted: number; client_highlights_by_source: Record<string, number> };
  internal_reference_data: Record<string, { total: number; used_by: string[] } | string | null>;
}

export interface Dashboard {
  executive_summary: ExecutiveSummary;
  opportunity_score: OpportunityScore;
  win_probability: WinProbability;
  risk_assessment: RiskAssessment;
  commercial_strategy: CommercialStrategy;
  pricing_recommendations: PricingRecommendations;
  follow_up_actions: FollowUpActions;
  client_proposal: ClientProposal;
  sources_used: SourcesUsed;
}
