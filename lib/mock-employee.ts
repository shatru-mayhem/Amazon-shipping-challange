// MOCK DATA - TO BE REPLACED BY DB FETCH

export type HierarchyLevel = "Executive" | "Manager" | "Associate";

export interface ReviewFolder {
  id: string;
  name: string;
  files: number;
  minLevel: HierarchyLevel;
}

export interface EmployeeQA {
  id: string;
  client: string;
  area: string;
  question: string;
  due: string;
}

export interface ProposalSignal {
  kind: "Risk" | "Opportunity" | "Cost";
  text: string;
}

export const reviewFolders: ReviewFolder[] = [
  { id: "f1", name: "Commercial agreements", files: 12, minLevel: "Executive" },
  { id: "f2", name: "Client financial summaries", files: 6, minLevel: "Executive" },
  { id: "f3", name: "Operational SOPs", files: 18, minLevel: "Manager" },
  { id: "f4", name: "Lane and volume data", files: 9, minLevel: "Associate" },
  { id: "f5", name: "Integration specs", files: 7, minLevel: "Associate" },
];

export const employeeQA: EmployeeQA[] = [
  { id: "e1", client: "EU Cross-Border Fulfilment", area: "Logistics", question: "What is the cut-off time for same-day induction?", due: "Today" },
  { id: "e2", client: "US Parcel Onboarding", area: "Logistics", question: "Are multi-origin pickups supported in phase 1?", due: "Tomorrow" },
];

export const proposalSignals: ProposalSignal[] = [
  { kind: "Risk", text: "Peak-season warehousing capacity in target region is unconfirmed." },
  { kind: "Risk", text: "SKU mapping mismatch may delay inventory sync by 2 weeks." },
  { kind: "Opportunity", text: "Client parcel profile fits Amazon Shipping last-mile coverage in 4 of 5 lanes." },
  { kind: "Opportunity", text: "Existing API integration readiness shortens onboarding." },
  { kind: "Cost", text: "Cross-dock handling adds a per-unit cost above standard flow. Pricing review required." },
];

export const evaluationChecklist: { id: string; item: string; done: boolean }[] = [
  { id: "c1", item: "Challenge brief requirements captured", done: true },
  { id: "c2", item: "Constraints identified and documented", done: true },
  { id: "c3", item: "Logistical approach formalized", done: false },
  { id: "c4", item: "Specialist review routed", done: false },
];
