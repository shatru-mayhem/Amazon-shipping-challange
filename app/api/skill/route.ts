import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { callSkillByName } from "@/lib/skills-bridge";

// Generic bridge from Next.js to the Python skills (skills/<name>/<name>.py)
// that make up the flow in flow.jpeg / RETRIEVAL_REQUIREMENTS.md. Same
// reasoning as app/api/retrieve/route.ts: the Python side already owns
// this logic (DB reads via skills/_db.py) — spawn it rather than
// reimplementing 8 scoring/synthesis scripts in TypeScript.

export const runtime = "nodejs";

// name -> script path, relative to skills/. Matches the 8 skills feeding
// the executive dashboard, in flow.jpeg reading order.
const SKILLS: Record<string, string> = {
  opportunity_score: "opportunity_score/opportunity_score.py",
  win_probability: "win_probability/win_probability.py",
  risk_assessment: "risk_assessment/risk_assessment.py",
  commercial_strategy: "commercial_strategy/commercial_strategy.py",
  pricing_recommendations: "pricing_recommendations/pricing_recommendations.py",
  client_proposal: "client_proposal/client_proposal.py",
  follow_up_actions: "follow_up_actions/follow_up_actions.py",
  executive_summary: "executive_summary/executive_summary.py",
  sources_used: "sources_used/sources_used.py",
  software_analytics: "software_analytics/software_analytics.py",
  capability_ingestion: "capability_ingestion/capability_ingestion.py",
};

// software_analytics reports on the pipeline's own LLM usage, not one
// opportunity's data — it takes no opportunity_id argument at all.
// capability_ingestion is the same shape: it updates Amazon's own
// ground-truth amazon_capability_profile, not one opportunity's data.
// Its CLI takes an action as extra_args[0] (run_demo / list_pending /
// approve <id> [reviewer] / reject <id> [reviewer] / reset_demo).
//
// follow_up_actions optionally takes extra_args ["send_draft", to_email?]
// to push its open actions to the Zapier webhook (skills/follow_up_actions/
// follow_up_actions.py's send_followup_draft()), which creates a Gmail
// draft — never auto-sent.
const GLOBAL_SKILLS = new Set(["software_analytics", "capability_ingestion"]);

export async function POST(request: NextRequest) {
  const supabase = createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  let body: { skill?: string; opportunity_id?: string; extra_args?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const { skill, opportunity_id, extra_args } = body;
  if (!skill || !SKILLS[skill]) {
    return NextResponse.json({ ok: false, error: `skill must be one of: ${Object.keys(SKILLS).join(", ")}` }, { status: 400 });
  }
  const isGlobal = GLOBAL_SKILLS.has(skill);
  if (!isGlobal && (!opportunity_id || typeof opportunity_id !== "string")) {
    return NextResponse.json({ ok: false, error: "opportunity_id is required." }, { status: 400 });
  }

  try {
    const result = await callSkillByName(
      skill,
      SKILLS[skill],
      isGlobal ? undefined : (opportunity_id as string),
      Array.isArray(extra_args) ? extra_args.map(String) : undefined,
    );
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Skill call failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
