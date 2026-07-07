"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { logAuditEvent } from "@/app/actions/audit";
import { validate, isEmail, oneOf } from "@/lib/validation";
import { getCurrentProfile, type ActionResult } from "@/app/actions/auth";
import type { HierarchyLevel } from "@/lib/db-types";

// Head-account (Admin) team management: add employees to the roster and
// assign hierarchy. When a rostered email signs in, the DB trigger
// (supabase/setup.sql) creates their profile with role Employee.

export interface RosterEntry {
  email: string;
  hierarchy_level: HierarchyLevel;
  team: string | null;
  created_at: string;
}

const LEVELS = ["Executive", "Manager", "Associate"] as const;

async function requireAdmin(): Promise<string | null> {
  const profile = await getCurrentProfile();
  if (!profile || profile.role !== "Admin") {
    return "Only the head account (Admin) can manage the team.";
  }
  return null;
}

export async function addEmployee(input: {
  email: string;
  hierarchy_level: HierarchyLevel;
  team?: string;
}): Promise<ActionResult<RosterEntry>> {
  const denied = await requireAdmin();
  if (denied) return { ok: false, error: denied };

  const v = validate([
    { field: "email", value: input.email, check: isEmail("Email") },
    { field: "hierarchy_level", value: input.hierarchy_level, check: oneOf("Hierarchy level", LEVELS) },
  ]);
  if (!v.ok) return { ok: false, error: Object.values(v.errors)[0] };

  const supabase = createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data, error } = await supabase
    .from("employee_roster")
    .upsert({
      email: input.email.trim().toLowerCase(),
      hierarchy_level: input.hierarchy_level,
      team: input.team?.trim() || null,
      added_by: user?.id,
    })
    .select()
    .single();
  if (error) return { ok: false, error: error.message };

  await logAuditEvent({
    eventType: "team.employee_added",
    after: { email: input.email, hierarchy_level: input.hierarchy_level },
  });
  revalidatePath("/employee/dashboard");
  return { ok: true, data: data as RosterEntry };
}

export async function listRoster(): Promise<ActionResult<RosterEntry[]>> {
  const denied = await requireAdmin();
  if (denied) return { ok: false, error: denied };

  const supabase = createSupabaseServer();
  const { data, error } = await supabase
    .from("employee_roster")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as RosterEntry[] };
}

// Update hierarchy for an employee who has already signed in (users table).
export async function setHierarchy(
  email: string,
  level: HierarchyLevel,
): Promise<ActionResult> {
  const denied = await requireAdmin();
  if (denied) return { ok: false, error: denied };

  const supabase = createSupabaseServer();
  const { error: rosterErr } = await supabase
    .from("employee_roster")
    .update({ hierarchy_level: level })
    .eq("email", email.toLowerCase());
  const { error: userErr } = await supabase
    .from("users")
    .update({ hierarchy_level: level })
    .eq("email", email.toLowerCase());
  if (rosterErr && userErr)
    return { ok: false, error: userErr.message };

  await logAuditEvent({
    eventType: "team.hierarchy_changed",
    after: { email, hierarchy_level: level },
  });
  revalidatePath("/employee/dashboard");
  return { ok: true };
}
