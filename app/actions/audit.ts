"use server";

import { createSupabaseServer } from "@/lib/supabase/server";

// Feature 6 (webdev.md): audit trail interceptor.
// Wrap critical mutations so before/after states land in audit_events.
export async function logAuditEvent(params: {
  eventType: string;
  opportunityId?: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  const supabase = createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { error } = await supabase.from("audit_events").insert({
    actor_id: user.id,
    opportunity_id: params.opportunityId ?? null,
    event_type: params.eventType,
    before_value: params.before ? JSON.stringify(params.before) : null,
    after_value: params.after ? JSON.stringify(params.after) : null,
  });
  if (error) {
    // Audit failures must be visible in server logs but not crash the action.
    console.error("[audit] failed to record " + params.eventType, error.message);
  }
}

// Helper: run a mutation and audit it with before/after values.
export async function withAudit<T>(
  eventType: string,
  opportunityId: string | undefined,
  before: unknown,
  mutate: () => Promise<T>,
): Promise<T> {
  const result = await mutate();
  await logAuditEvent({ eventType, opportunityId, before, after: result });
  return result;
}
