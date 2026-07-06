import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";
import { createSupabaseServer } from "@/lib/supabase/server";

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

// Must match skills/retrieval/retrieval.py's _TABLE_HANDLERS keys —
// checked here too so a bad request 400s immediately instead of paying
// for a Python process spin-up first.
const VALID_TABLES = ["opportunity_features", "tender_constraints", "client_highlights", "email_messages"];

const RETRIEVAL_SCRIPT = path.join(process.cwd(), "skills", "retrieval", "retrieval.py");
const TIMEOUT_MS = 120_000; // generous: a call can involve several sequential Ollama round-trips

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

  const args = [RETRIEVAL_SCRIPT, opportunity_id, table];
  if (field) args.push(String(field));

  try {
    const { stdout } = await runPython(args);
    const result = JSON.parse(stdout);
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Retrieval failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

function runPython(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile("python", args, { timeout: TIMEOUT_MS, cwd: process.cwd() }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
