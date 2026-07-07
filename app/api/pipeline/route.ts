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
// See app/api/skill/route.ts's comment on maxDuration. 300s is the
// Vercel Pro-plan ceiling (Hobby caps lower regardless of what's
// declared) — note this is LESS than PERSIST_TIMEOUT_MS (600s) in
// lib/skills-bridge.ts / service/app.py's PERSIST_TIMEOUT_SECONDS,
// which assume persist.py may legitimately need up to 10 minutes for a
// large document. Vercel will still kill this route at 300s even though
// our own code would wait longer — a persist run past that genuinely
// needs Vercel Enterprise (fluid compute, up to 800s) or triggering
// persist.py out-of-band instead of through this route.
export const maxDuration = 300;

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
