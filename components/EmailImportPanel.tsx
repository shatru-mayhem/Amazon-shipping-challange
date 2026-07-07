"use client";

import { useEffect, useState, useTransition } from "react";
import StatusBadge from "@/components/StatusBadge";
import { listOpportunitiesForIngestion, type OpportunityOption } from "@/app/actions/tender_ingestion";
import { listEmailThreads } from "@/app/actions/email_ingestion";
import type { CoreEmailThread } from "@/lib/db-types";

// Entry point 2 of 2: email/CRM import, via file upload. Writes to
// core.email_threads + core.email_messages (real live schema).
export default function EmailImportPanel() {
  const [opps, setOpps] = useState<OpportunityOption[]>([]);
  const [oppsError, setOppsError] = useState("");
  const [opportunityId, setOpportunityId] = useState("");
  const [threads, setThreads] = useState<CoreEmailThread[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    listOpportunitiesForIngestion().then((res) => {
      if (res.ok && res.data && res.data.length > 0) {
        setOpps(res.data);
        setOpportunityId(res.data[0].opportunity_id);
        return;
      }
      // A failed query (e.g. bad ingestion-DB credentials) previously
      // looked identical to "no opportunities exist yet" — surface the
      // real reason instead of silently rendering the empty-state copy.
      if (!res.ok) setOppsError(res.error ?? "Could not load opportunities.");
    });
  }, []);

  useEffect(() => {
    if (!opportunityId) return;
    listEmailThreads(opportunityId).then((res) => {
      if (res.ok && res.data) setThreads(res.data);
    });
  }, [opportunityId]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !opportunityId) return;
    setError("");
    setMessage("");

    startTransition(async () => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("opportunity_id", opportunityId);

      const httpRes = await fetch("/api/email-import", { method: "POST", body: formData });
      const res = await httpRes.json();
      if (!res.ok || !res.data) {
        setError(res.error ?? "Import failed.");
        return;
      }
      const parts: string[] = [];
      if (res.data.messages_imported > 0) {
        parts.push(`${res.data.messages_imported} message(s) into thread "${res.data.thread?.subject}"`);
      }
      if (res.data.crm_notes_chunk_count > 0) {
        parts.push(`${res.data.crm_notes_chunk_count} CRM-notes chunk(s) stored for retrieval`);
      }
      setMessage(`Imported: ${parts.join(" + ")}.`);
      setFile(null);
      const list = await listEmailThreads(opportunityId);
      if (list.ok && list.data) setThreads(list.data);
    });
  }

  return (
    <section>
      <h2 className="mb-3 text-base font-bold">Email / CRM Import</h2>
      <div className="rounded-sm border border-border bg-surface p-4">
        {oppsError ? (
          <p className="mb-3 text-sm text-danger" role="alert">{oppsError}</p>
        ) : opps.length === 0 ? (
          <p className="mb-3 text-sm text-gray-500">No opportunities found.</p>
        ) : (
          <div className="mb-3">
            <label htmlFor="email-opp" className="mb-1 block text-sm font-medium">
              Opportunity
            </label>
            <select
              id="email-opp"
              value={opportunityId}
              onChange={(e) => setOpportunityId(e.target.value)}
              className="h-11 w-full rounded-sm border border-border bg-surface px-2 text-sm"
            >
              {opps.map((o) => (
                <option key={o.opportunity_id} value={o.opportunity_id}>
                  {o.customer_name} — {o.title}
                </option>
              ))}
            </select>
          </div>
        )}

        <form onSubmit={submit} className="grid gap-3" noValidate>
          <div>
            <label htmlFor="email-file" className="mb-1 block text-sm font-medium">
              Email/CRM export (.pdf, .docx, .txt, .csv, .md)
            </label>
            <input
              id="email-file"
              type="file"
              accept=".pdf,.docx,.txt,.csv,.md"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm"
            />
            <p className="mt-1 text-xs text-gray-500">
              Actual email correspondence (From:/To:/Date:/Subject: headers) is parsed into
              threaded messages automatically; any other CRM notes in the same file are stored
              alongside for retrieval, not discarded.
            </p>
          </div>
          <button
            type="submit"
            disabled={pending || !file || !opportunityId}
            className="h-11 w-fit rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark disabled:opacity-60"
          >
            {pending ? "Importing…" : "Import"}
          </button>
        </form>

        {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
        {message ? <p className="mt-3 text-sm text-success">{message}</p> : null}

        {threads.length > 0 ? (
          <ul className="mt-4 space-y-2 border-t border-border pt-4">
            {threads.map((t) => (
              <li
                key={t.thread_id}
                className="flex items-center justify-between rounded-sm border border-border p-2.5 text-sm"
              >
                <span className="truncate">{t.subject}</span>
                <StatusBadge tone="neutral" label={t.started_at ? new Date(t.started_at).toLocaleDateString() : "—"} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
