import { NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { getHistoricalModelFile } from "@/lib/skills-bridge";

// Serves the joblib-pickled (scaler, pca, kmeans) pipeline that
// /api/historical-insights produces with save_model=true, as a download.

export const runtime = "nodejs";

export async function GET() {
  const supabase = createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  try {
    const file = await getHistoricalModelFile();
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="historical_archetypes_model.joblib"',
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Model file not available.";
    return NextResponse.json({ ok: false, error: message }, { status: 404 });
  }
}
