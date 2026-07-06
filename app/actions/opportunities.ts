"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { validate, required, maxLen } from "@/lib/validation";
import { withAudit } from "@/app/actions/audit";
import type { Opportunity, IntakeProfile, Assessment } from "@/lib/db-types";
import type { ActionResult } from "@/app/actions/auth";

// Feature 2 (webdev.md): opportunity + intake CRUD.

export async function createOpportunity(input: {
  company_name: string;
  industry: string;
}): Promise<ActionResult<Opportunity>> {
  const v = validate([
    { field: "company_name", value: input.company_name, check: required("Company name") },
    { field: "company_name", value: input.company_name, check: maxLen("Company name", 200) },
    { field: "industry", value: input.industry, check: required("Industry") },
  ]);
  if (!v.ok) return { ok: false, error: Object.values(v.errors)[0] };

  const supabase = createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data, error } = await supabase
    .from("opportunities")
    .insert({
      company_name: input.company_name.trim(),
      industry: input.industry.trim(),
      owner_id: user.id,
      status: "In evaluation",
    })
    .select()
    .single();
  if (error) return { ok: false, error: error.message };

  const opp = data as Opportunity;

  // Initialize the connected intake profile (empty shell).
  const { error: intakeErr } = await supabase
    .from("intake_profiles")
    .insert({ opportunity_id: opp.id });
  if (intakeErr) return { ok: false, error: intakeErr.message };

  await withAudit("opportunity.created", opp.id, null, async () => opp);
  revalidatePath("/employee");
  return { ok: true, data: opp };
}

export async function updateIntake(
  opportunityId: string,
  patch: Partial<Omit<IntakeProfile, "opportunity_id">>,
): Promise<ActionResult<IntakeProfile>> {
  const supabase = createSupabaseServer();

  const { data: before } = await supabase
    .from("intake_profiles")
    .select("*")
    .eq("opportunity_id", opportunityId)
    .single();
  if (!before) return { ok: false, error: "Intake profile not found." };

  const result = await withAudit(
    "intake.updated",
    opportunityId,
    before,
    async () => {
      const { data, error } = await supabase
        .from("intake_profiles")
        .update(patch)
        .eq("opportunity_id", opportunityId)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data as IntakeProfile;
    },
  ).catch((e: Error) => e);

  if (result instanceof Error) return { ok: false, error: result.message };
  revalidatePath("/employee");
  return { ok: true, data: result };
}

// Digital Twin data fetcher: aggregates the joined view that feeds the
// pipeline visualization on both portals.
export interface DigitalTwinData {
  opportunity: Opportunity;
  intake: IntakeProfile | null;
  assessment: Assessment | null;
  missingFields: string[];
}

const INTAKE_REQUIRED: Array<keyof IntakeProfile> = [
  "current_model",
  "volume_band",
  "warehousing_needs",
  "carrier_mix",
  "integration_readiness",
];

export async function getDigitalTwin(
  opportunityId: string,
): Promise<ActionResult<DigitalTwinData>> {
  const supabase = createSupabaseServer();
  const { data, error } = await supabase
    .from("opportunities")
    .select("*, intake_profiles(*), assessments(*)")
    .eq("id", opportunityId)
    .single();
  if (error) return { ok: false, error: error.message };

  const intake = (data.intake_profiles?.[0] ?? data.intake_profiles ?? null) as IntakeProfile | null;
  const assessment = (data.assessments?.[0] ?? data.assessments ?? null) as Assessment | null;
  const missingFields = INTAKE_REQUIRED.filter(
    (f) => !intake || !intake[f] || String(intake[f]).trim() === "",
  ).map(String);

  return {
    ok: true,
    data: { opportunity: data as Opportunity, intake, assessment, missingFields },
  };
}

export async function listOpportunities(): Promise<ActionResult<Opportunity[]>> {
  const supabase = createSupabaseServer();
  const { data, error } = await supabase
    .from("opportunities")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as Opportunity[] };
}
