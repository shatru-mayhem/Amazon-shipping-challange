"use server";

import { createSupabaseServer } from "@/lib/supabase/server";
import type { ActionResult } from "@/app/actions/auth";

// RAG retrieval over the knowledge base seeded by supabase/rag_knowledge_base.sql
// (historical opportunities, pricing matrix, pricing notes, service description).
// Full-text search today; pgvector semantic search is the marked upgrade path.
// RLS restricts all knowledge tables to Employee/Admin roles.

export interface KnowledgeChunk {
  id: number;
  source: string;
  title: string;
  content: string;
  metadata: Record<string, unknown>;
  rank: number;
}

export async function searchKnowledge(
  query: string,
  topK = 8,
): Promise<ActionResult<KnowledgeChunk[]>> {
  const q = query.trim();
  if (q.length < 2) return { ok: false, error: "Enter a search query." };
  if (q.length > 500) return { ok: false, error: "Query too long." };

  const supabase = createSupabaseServer();
  const { data, error } = await supabase.rpc("search_knowledge", {
    query: q,
    top_k: Math.min(Math.max(topK, 1), 25),
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as KnowledgeChunk[] };
}

// Convenience for the model / proposal generators: fetch similar historical
// deals for an industry to ground recommendations in prior outcomes.
export async function similarHistoricalDeals(
  industry: string,
  limit = 5,
): Promise<ActionResult<KnowledgeChunk[]>> {
  return searchKnowledge(industry + " outcome", limit);
}
