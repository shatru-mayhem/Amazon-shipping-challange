"use client";

import { useEffect, useState, useTransition } from "react";
import StatusBadge from "@/components/StatusBadge";
import {
  listOpportunitiesForIngestion,
  listTenderDocuments,
  type OpportunityOption,
} from "@/app/actions/tender_ingestion";
import type { CoreDocument } from "@/lib/db-types";

// Entry point 1 of 2: tender document upload. Writes to core.documents +
// core.document_chunks (the real live schema — see RETRIEVAL_REQUIREMENTS.md).
export default function TenderUploadPanel() {
  const [opps, setOpps] = useState<OpportunityOption[]>([]);
  const [opportunityId, setOpportunityId] = useState("");
  const [docs, setDocs] = useState<CoreDocument[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    listOpportunitiesForIngestion().then((res) => {
      if (res.ok && res.data && res.data.length > 0) {
        setOpps(res.data);
        setOpportunityId(res.data[0].opportunity_id);
      }
    });
  }, []);

  useEffect(() => {
    if (!opportunityId) return;
    listTenderDocuments(opportunityId).then((res) => {
      if (res.ok && res.data) setDocs(res.data);
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

      // Vercel serverless caps request bodies at ~4.5 MB — reject early
      // with a clear message instead of an opaque 413.
      if (file.size > 4.4 * 1024 * 1024) {
        setError(
          "File is larger than the deployment's 4.5 MB upload limit (Vercel serverless). Split the document or compress the PDF.",
        );
        return;
      }
      const httpRes = await fetch("/api/tender-upload", { method: "POST", body: formData });
      let res: { ok?: boolean; error?: string; data?: { chunk_count?: number } };
      try {
        res = await httpRes.json();
      } catch {
        res = { ok: false, error: "Server returned " + httpRes.status + " " + httpRes.statusText + " (no details). Check Vercel function logs." };
      }
      if (!res.ok || !res.data) {
        setError(res.error ?? "Upload failed.");
        return;
      }
      setMessage(`Uploaded — ${res.data.chunk_count} chunk(s) ready for retrieval.`);
      setFile(null);
      const list = await listTenderDocuments(opportunityId);
      if (list.ok && list.data) setDocs(list.data);
    });
  }

  return (
    <section>
      <h2 className="mb-3 text-base font-bold">Tender Document Upload</h2>
      <div className="rounded-sm border border-border bg-surface p-4">
        {opps.length === 0 ? (
          <p className="mb-3 text-sm text-gray-500">No opportunities found.</p>
        ) : (
          <div className="mb-3">
            <label htmlFor="tender-opp" className="mb-1 block text-sm font-medium">
              Opportunity
            </label>
            <select
              id="tender-opp"
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
            <label htmlFor="tender-file" className="mb-1 block text-sm font-medium">
              Tender document (.pdf, .docx, .txt, .csv, .md)
            </label>
            <input
              id="tender-file"
              type="file"
              accept=".pdf,.docx,.txt,.csv,.md"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm"
            />
          </div>
          <button
            type="submit"
            disabled={pending || !file || !opportunityId}
            className="h-11 w-fit rounded-sm bg-orange px-4 text-sm font-medium text-ink hover:bg-orange-dark disabled:opacity-60"
          >
            {pending ? "Uploading…" : "Upload"}
          </button>
        </form>

        {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
        {message ? <p className="mt-3 text-sm text-success">{message}</p> : null}

        {docs.length > 0 ? (
          <ul className="mt-4 space-y-2 border-t border-border pt-4">
            {docs.map((d) => (
              <li
                key={d.document_id}
                className="flex items-center justify-between rounded-sm border border-border p-2.5 text-sm"
              >
                <span className="truncate">{d.filename}</span>
                <StatusBadge tone="info" label={d.source_type} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
