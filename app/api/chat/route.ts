import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServer } from "@/lib/supabase/server";
import { callNlQuery } from "@/lib/skills-bridge";

// Bridge between the dashboard's ChatPanel (components/FigmaDashboard.tsx)
// and nl_query_gemini.py: question in, Gemini-generated SQL run read-only
// against Supabase, natural-language-ready answer back out. Same
// spawn-Python-rather-than-reimplement reasoning as app/api/skill/route.ts
// and app/api/retrieve/route.ts.

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  let body: { question?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const { question } = body;
  if (!question || typeof question !== "string" || !question.trim()) {
    return NextResponse.json({ ok: false, error: "question is required." }, { status: 400 });
  }

  try {
    const result = await callNlQuery(question);
    return NextResponse.json({ ok: true, data: result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Chat query failed.";
    // Fallback: answer from the Supabase knowledge base (full-text search
    // over historical deals, pricing, and the service description) so the
    // chat still works while the Python service is not deployed.
    try {
      const { data: chunks } = await supabase.rpc("search_knowledge", {
        query: question,
        top_k: 3,
      });
      if (chunks && chunks.length > 0) {
        const answer =
          "(Answering from the knowledge base — AI query service not configured: " +
          message +
          ")\n\n" +
          chunks
            .map(
              (c: { title: string; content: string }) =>
                "• " + c.title + "\n" + (c.content.length > 500 ? c.content.slice(0, 500) + "…" : c.content),
            )
            .join("\n\n");
        return NextResponse.json({ ok: true, data: { answer, mode: "knowledge-base-fallback" } });
      }
    } catch {
      // fall through to the original error
    }
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
