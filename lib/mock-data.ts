// MOCK DATA - TO BE REPLACED BY DB FETCH

export type DocStatus = "Uploaded" | "Viewed" | "Reviewed" | "Answered";
export type PipelineState = "complete" | "active" | "approval" | "issue" | "pending";

export interface Project {
  id: string;
  name: string;
  status: string;
}

export interface PipelineStage {
  id: string;
  label: string;
  state: PipelineState;
  note?: string;
}

export interface QAItem {
  id: string;
  category: "Services" | "Logistics" | "Management";
  question: string;
  status: DocStatus;
  routedTo: string;
}

export interface DocItem {
  id: string;
  category: string;
  name: string;
  status: DocStatus;
  updated: string;
}

export const projects: Project[] = [
  { id: "p1", name: "EU Cross-Border Fulfilment", status: "In execution" },
  { id: "p2", name: "US Parcel Onboarding", status: "In evaluation" },
  { id: "p3", name: "Peak Season Warehousing", status: "Proposal review" },
];

export const pipelineByProject: Record<string, PipelineStage[]> = {
  p1: [
    { id: "s1", label: "Intake", state: "complete" },
    { id: "s2", label: "Upstream transport", state: "complete" },
    { id: "s3", label: "Warehousing", state: "active" },
    { id: "s4", label: "Inventory sync", state: "issue", note: "SKU mapping mismatch flagged" },
    { id: "s5", label: "Last-mile (Amazon Shipping)", state: "approval", note: "Client approval required" },
    { id: "s6", label: "Go live", state: "pending" },
  ],
  p2: [
    { id: "s1", label: "Intake", state: "complete" },
    { id: "s2", label: "Upstream transport", state: "active" },
    { id: "s3", label: "Warehousing", state: "approval", note: "Client approval required" },
    { id: "s4", label: "Inventory sync", state: "pending" },
    { id: "s5", label: "Last-mile (Amazon Shipping)", state: "pending" },
    { id: "s6", label: "Go live", state: "pending" },
  ],
  p3: [
    { id: "s1", label: "Intake", state: "complete" },
    { id: "s2", label: "Upstream transport", state: "pending" },
    { id: "s3", label: "Warehousing", state: "issue", note: "Capacity confirmation pending" },
    { id: "s4", label: "Inventory sync", state: "pending" },
    { id: "s5", label: "Last-mile (Amazon Shipping)", state: "pending" },
    { id: "s6", label: "Go live", state: "pending" },
  ],
};

export const qaItems: QAItem[] = [
  { id: "q1", category: "Logistics", question: "Which lanes are covered for the Iberia routes?", status: "Answered", routedTo: "Lane Planning" },
  { id: "q2", category: "Services", question: "Can inventory management include lot tracking?", status: "Reviewed", routedTo: "Solutions Architecture" },
  { id: "q3", category: "Management", question: "Who is the escalation owner during peak season?", status: "Viewed", routedTo: "Account Management" },
  { id: "q4", category: "Logistics", question: "What is the cut-off time for same-day induction?", status: "Uploaded", routedTo: "Operations" },
];

export const docItems: DocItem[] = [
  { id: "d1", category: "Commercial", name: "Signed NDA.pdf", status: "Reviewed", updated: "2026-07-01" },
  { id: "d2", category: "Operations", name: "SKU master export.xlsx", status: "Viewed", updated: "2026-07-03" },
  { id: "d3", category: "Compliance", name: "Customs registration.pdf", status: "Uploaded", updated: "2026-07-05" },
  { id: "d4", category: "Integration", name: "API credentials request.docx", status: "Answered", updated: "2026-06-28" },
];

export const docCategories = ["Commercial", "Operations", "Compliance", "Integration"] as const;
