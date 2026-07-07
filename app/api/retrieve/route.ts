import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { callRetrieve } from "@/lib/skills-bridge";

// Bridge between the frontend and the Python retrieval engine
// (skills/retrieval/retrieval.py). This is the "downstream process asks
// for a field, retrieval finds it and reports back — found or
// not_found, always" contract from RETRIEVAL_REQUIREMENTS.md /
// skills/retrieval/SKILL.md, made callable from Next.js.
//
// Spawns `python` as a subprocess rather than reimplementing retrieval
// in TypeScript — the Python side already owns the Ollama client
// (skills/_llm.py) and the DB read path (skills/_db.py); duplicating
// that here would be a second place for the same logic to drift.

export const runtime = "nodejs";
// See app/api/skill/route.ts's comment on maxDuration — Vercel's own
// function timeout is enforced before any timeout in our own code, and
// retrieval can involve real LLM calls.
export const maxDuration = 300;

// Must match skills/retrieval/retrieval.py's _TABLE_HANDLERS keys —
// checked here too so a bad request 400s immediately instead of paying
// for a Python process spin-up first.
const VALID_TABLES = ["opportunity_features", "tender_constraints", "client_highlights", "email_messages"];

export async function POST(request: NextRequest) {
  const supabase = createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  let body: { opportunity_id?: string; table?: string; field?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const { opportunity_id, table, field } = body;
  if (!opportunity_id || typeof opportunity_id !== "string") {
    return NextResponse.json({ ok: false, error: "opportunity_id is required." }, { status: 400 });
  }
  if (!table || !VALID_TABLES.includes(table)) {
    return NextResponse.json(
      { ok: false, error: `table must be one of: ${VALID_TABLES.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const result = await callRetrieve(opportunity_id, table, field ? String(field) : undefined);
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Retrieval failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
