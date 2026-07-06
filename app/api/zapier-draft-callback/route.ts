import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import path from "path";

// The other end of the Gmail-draft loop: send_client_reply_draft() /
// send_followup_draft() (skills/follow_up_actions/follow_up_actions.py)
// POST to Zapier and get back only "Zapier's Catch Hook received this" —
// not "the Gmail draft actually exists." To close that loop, add ONE more
// step to the end of the Zap (after Gmail's "Create Draft" action):
//
//   Webhooks by Zapier -> POST -> <this route's public URL>
//     Headers: { "x-zapier-callback-secret": <ZAPIER_CALLBACK_SECRET> }
//     Body (JSON): {
//       "draft_id": "{{draft_id}}",       <- from the original Catch Hook payload
//       "status": "completed",
//       "gmail_draft_id": "{{id}}"        <- optional, from Gmail step's output
//     }
//
// No Supabase session exists here (Zapier is an external caller, not a
// logged-in user) — a shared secret substitutes for the auth check every
// other /api route gets from createSupabaseServer().auth.getUser().
//
// Requires this app to be reachable from the public internet for Zapier
// to call back to it — on localhost that means a tunnel (e.g. ngrok)
// pointed at :3000; a deployed URL works with no extra setup.

export const runtime = "nodejs";

const SCRIPT_PATH = path.join(process.cwd(), "skills", "follow_up_actions", "follow_up_actions.py");
const TIMEOUT_MS = 30_000;

export async function POST(request: NextRequest) {
  const expectedSecret = process.env.ZAPIER_CALLBACK_SECRET;
  if (expectedSecret) {
    const provided = request.headers.get("x-zapier-callback-secret");
    if (provided !== expectedSecret) {
      return NextResponse.json({ ok: false, error: "Invalid callback secret." }, { status: 401 });
    }
  }

  let body: { draft_id?: string; status?: string; gmail_draft_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const { draft_id, status, gmail_draft_id } = body;
  if (!draft_id || (status !== "completed" && status !== "failed")) {
    return NextResponse.json(
      { ok: false, error: "draft_id and status ('completed' | 'failed') are required." },
      { status: 400 }
    );
  }

  const args = [SCRIPT_PATH, "_", "mark_completed", draft_id, status, ...(gmail_draft_id ? [gmail_draft_id] : [])];

  try {
    const stdout = await runPython(args);
    const result = JSON.parse(stdout);
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Callback handling failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

function runPython(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("python", args, { timeout: TIMEOUT_MS, cwd: process.cwd() }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}
