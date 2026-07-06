"use server";

import { redirect } from "next/navigation";
import { createSupabaseServer } from "@/lib/supabase/server";
import { validate, isEmail } from "@/lib/validation";
import type { DbUser } from "@/lib/db-types";

export interface ActionResult<T = undefined> {
  ok: boolean;
  data?: T;
  error?: string;
}

// Feature 1 (webdev.md): email-confirmation login via Supabase OTP.
// The code-access UX on the landing page maps to a 6-digit email OTP.
export async function requestLoginCode(email: string): Promise<ActionResult> {
  const v = validate([{ field: "email", value: email, check: isEmail("Email") }]);
  if (!v.ok) return { ok: false, error: v.errors.email };

  const supabase = createSupabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function verifyLoginCode(
  email: string,
  code: string,
): Promise<ActionResult<{ destination: string }>> {
  const supabase = createSupabaseServer();
  const { error } = await supabase.auth.verifyOtp({
    email,
    token: code.trim(),
    type: "email",
  });
  if (error) return { ok: false, error: error.message };

  const profile = await getCurrentProfile();
  const destination =
    profile?.role === "Employee" || profile?.role === "Admin"
      ? "/employee"
      : "/client";
  return { ok: true, data: { destination } };
}

export async function signOut(): Promise<void> {
  const supabase = createSupabaseServer();
  await supabase.auth.signOut();
  redirect("/");
}

// Reads the caller's row from the users table (RLS-scoped).
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
