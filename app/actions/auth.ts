"use server";

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { validate, isEmail, required } from "@/lib/validation";
import type { DbUser } from "@/lib/db-types";

export interface ActionResult<T = undefined> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// Client flow (Feature 1, webdev.md + landpage.md):
// register/sign in with email -> 6-digit access code sent to that email ->
// verify code -> enter portal. New emails are auto-registered; the DB
// trigger (supabase/setup.sql) creates their profile as role Client.
// ---------------------------------------------------------------------------

export async function requestLoginCode(email: string): Promise<ActionResult> {
  const v = validate([{ field: "email", value: email, check: isEmail("Email") }]);
  if (!v.ok) return { ok: false, error: v.errors.email };

  const supabase = createSupabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { shouldCreateUser: true },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function verifyLoginCode(
  email: string,
  code: string,
): Promise<ActionResult<{ destination: string }>> {
  const v = validate([
    { field: "code", value: code, check: required("Access code") },
  ]);
  if (!v.ok) return { ok: false, error: v.errors.code };

  const supabase = createSupabaseServer();
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: code.trim(),
    type: "email",
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: { destination: await destinationForRole() } };
}

// ---------------------------------------------------------------------------
// Employee/head flow: email + standing access code (Supabase password).
// The head account is provisioned in the dashboard (see SETUP.md) and can
// then add employees + assign hierarchy from the Team panel.
// ---------------------------------------------------------------------------

export async function signInWithAccessCode(
  email: string,
  accessCode: string,
): Promise<ActionResult<{ destination: string }>> {
  const v = validate([
    { field: "email", value: email, check: isEmail("Email") },
    { field: "code", value: accessCode, check: required("Access code") },
  ]);
  if (!v.ok) return { ok: false, error: Object.values(v.errors)[0] };

  const supabase = createSupabaseServer();
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password: accessCode,
  });
  if (error) {
    return {
      ok: false,
      error:
        "Invalid email or access code. Employees without a standing code can use “Email me a code” instead.",
    };
  }
  return { ok: true, data: { destination: await destinationForRole() } };
}

export async function signOut(): Promise<void> {
  const supabase = createSupabaseServer();
  await supabase.auth.signOut();
  redirect("/");
}

export async function getCurrentProfile(): Promise<DbUser | null> {
  const supabase = createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("id", user.id)
    .single();
  return (data as DbUser) ?? null;
}

async function destinationForRole(): Promise<string> {
  const profile = await getCurrentProfile();
  return profile?.role === "Employee" || profile?.role === "Admin"
    ? "/employee"
    : "/client";
}
