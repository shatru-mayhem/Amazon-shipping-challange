"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { logAuditEvent } from "@/app/actions/audit";
import { validate, required, maxLen, oneOf } from "@/lib/validation";
import type { QnaThread, QnaStatus } from "@/lib/db-types";
import type { ActionResult } from "@/app/actions/auth";

// Feature 4 (webdev.md): categorized Q&A with routed answer bar and
// status tracking that feeds the client's Progress Tracker.

export const QNA_CATEGORIES = ["Services", "Logistics", "Management", "Pricing"] as const;

export async function askQuestion(input: {
  opportunity_id: string;
  category: string;
  question: string;
}): Promise<ActionResult<QnaThread>> {
  const v = validate([
    { field: "category", value: input.category, check: oneOf("Category", QNA_CATEGORIES) },
    { field: "question", value: input.question, check: required("Question") },
    { field: "question", value: input.question, check: maxLen("Question", 2000) },
  ]);
  if (!v.ok) return { ok: false, error: Object.values(v.errors)[0] };

  const supabase = createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data, error } = await supabase
    .from("qna_threads")
    .insert({
      opportunity_id: input.opportunity_id,
      category: input.category,
      question: input.question.trim(),
      client_id: user.id,
      status: "open",
    })
    .select()
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath("/client");
  return { ok: true, data: data as QnaThread };
}

// Employee answer bar: only questions in the employee's categories,
// so no single employee is flooded with everything (per landpage.md).
export async function listQuestionsForEmployee(
  categories: string[],
): Promise<ActionResult<QnaThread[]>> {
  const supabase = createSupabaseServer();
  const { data, error } = await supabase
    .from("qna_threads")
    .select("*")
    .in("category", categories)
    .neq("status", "answered")
    .order("id", { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as QnaThread[] };
}

export async function updateQuestionStatus(
  id: string,
  status: QnaStatus,
): Promise<ActionResult> {
  const supabase = createSupabaseServer();
  const { error } = await supabase
    .from("qna_threads")
    .update({ status })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/client");
  revalidatePath("/employee/dashboard");
  return { ok: true };
}

export async function answerQuestion(
  id: string,
  answer: string,
): Promise<ActionResult<QnaThread>> {
  const v = validate([
    { field: "answer", value: answer, check: required("Answer") },
    { field: "answer", value: answer, check: maxLen("Answer", 5000) },
  ]);
  if (!v.ok) return { ok: false, error: Object.values(v.errors)[0] };

  const supabase = createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const { data: before } = await supabase
    .from("qna_threads")
    .select("*")
    .eq("id", id)
    .single();

  const { data, error } = await supabase
    .from("qna_threads")
    .update({ answer: answer.trim(), employee_id: user.id, status: "answered" })
    .eq("id", id)
    .select()
    .single();
  if (error) return { ok: false, error: error.message };

  await logAuditEvent({
    eventType: "qna.answered",
    opportunityId: (data as QnaThread).opportunity_id,
    before,
    after: data,
  });
  revalidatePath("/client");
  revalidatePath("/employee/dashboard");
  return { ok: true, data: data as QnaThread };
}
