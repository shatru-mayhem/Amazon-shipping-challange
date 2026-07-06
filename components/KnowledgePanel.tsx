"use client";

import { useState, useTransition } from "react";
import StatusBadge from "@/components/StatusBadge";
import { searchKnowledge, type KnowledgeChunk } from "@/app/actions/knowledge";

// Employee-portal search over the RAG knowledge base (historical deals,
// pricing, service description). Same retrieval the model uses.
export default function KnowledgePanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeChunk[] | null>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await searchKnowledge(query);
      if (!res.ok || !res.data) return setError(res.error ?? "Search failed.");
      setError("");
      setResults(res.data);
    });
  }

  return (
    <section>
      <h2 className="mb-3 text-base font-bold">Knowledge Base (RAG)</h2>
      <div className="rounded-sm border border-border bg-surface p-4">
        <form onSubmit={submit} className="flex gap-2" noValidate>
          <input
            aria-label="Search the knowledge base"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. Fashion lost deals, weekend delivery, 5kg home delivery cost…"
            className="h-11 flex-1 rounded-sm border border-border px-3 text-sm"
          />
          <button
            type="submit"
            disabled={pending}
            className="h-11 rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark disabled:opacity-60"
          >
            {pending ? "Searching…" : "Search"}
          </button>
        </form>
        {error ? (
          <p className="mt-2 text-sm text-danger" role="alert">{error}</p>
        ) : null}
        {results !== null ? (
          <ul className="mt-3 space-y-2">
            {results.length === 0 ? (
              <li className="text-sm text-gray-500">
                No matches. The knowledge base covers historical opportunities,
                pricing, and the Amazon Shipping service description.
              </li>
            ) : (
              results.map((r) => (
                <li key={r.id} className="rounded-sm border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-bold">{r.title}</p>
                    <StatusBadge tone="neutral" label={r.source.replace(/_/g, " ")} />
                  </div>
                  <p className="mt-1 whitespace-pre-line text-xs text-gray-600">
                    {r.content.length > 400 ? r.content.slice(0, 400) + "…" : r.content}
                  </p>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
