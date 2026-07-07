import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { callPersistOpportunity } from "@/lib/skills-bridge";

// Runs skills/retrieval/persist.py for one opportunity: retrieval on every
// opportunity_features field + every constraint catalog type +
// client_highlights + email resolutions, then writes what's found into
// the real tables (plus derived constraint_compliance_results /
// signal_check_results). Called after a successful tender/email upload so
// "upload a document" actually results in the pipeline running, instead
// of the file just landing with nothing downstream reading it until
// someone manually runs persist.py from the CLI.

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  let body: { opportunity_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const { opportunity_id } = body;
  if (!opportunity_id || typeof opportunity_id !== "string") {
    return NextResponse.json({ ok: false, error: "opportunity_id is required." }, { status: 400 });
  }

  try {
    const result = await callPersistOpportunity(opportunity_id);
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Pipeline run failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
