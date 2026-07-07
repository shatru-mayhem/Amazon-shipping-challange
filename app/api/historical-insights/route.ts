import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { callHistoricalAnalysis } from "@/lib/skills-bridge";

// Bridge between the historical-insights page and
// skills/exploration/historical_archetypes.py: runs PCA + KMeans over
// core.historical_tenders and returns correlations, PCA loadings,
// archetype clusters, and actionable insights. Optionally also pickles
// the fitted pipeline (for /api/historical-insights/model to serve) and
// (re)writes the auto-generated findings section of
// RETRIEVAL_REQUIREMENTS.md.

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  let body: { clusters?: number; save_model?: boolean; update_requirements_doc?: boolean };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const result = await callHistoricalAnalysis({
      clusters: body.clusters,
      saveModel: body.save_model,
      updateRequirementsDoc: body.update_requirements_doc,
    });
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Historical analysis failed.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
