"use server";

import { ingestionQuery, ingestionQueryOne } from "@/lib/ingestion-db";
import type { ActionResult } from "@/app/actions/auth";
import type { CoreDocument } from "@/lib/db-types";

// Entry point 1 of 2 (see RETRIEVAL_REQUIREMENTS.md): tender document
// upload. Writes to the REAL live schema (core.documents,
// core.document_chunks — see tender-analysis-schema.sql), via the
// app_ingestion Postgres role (lib/ingestion-db.ts), not the legacy
// evidence_documents flow in documents.ts.
//
// The actual upload (uploadTenderDocument) lives in
// app/api/tender-upload/route.ts, NOT here — pdf-parse crashes when
// bundled into Server Actions' restricted "action-browser" runtime, so
// anything importing lib/file-text-extraction.ts must be a plain API
// route instead. This file keeps the two read-only helpers that don't
// touch file extraction.

export interface OpportunityOption {
  opportunity_id: string;
  title: string;
  customer_name: string;
}

export async function listOpportunitiesForIngestion(): Promise<ActionResult<OpportunityOption[]>> {
  try {
    const rows = await ingestionQuery<OpportunityOption>(
      `SELECT o.opportunity_id, o.title, c.name AS customer_name
       FROM opportunities o
       JOIN customers c ON c.customer_id = o.customer_id
       ORDER BY o.created_at DESC
       LIMIT 200`,
    );
    return { ok: true, data: rows };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to list opportunities." };
  }
}

export interface TenderUploadResult {
  document: CoreDocument;
  chunk_count: number;
}

export async function listTenderDocuments(
  opportunityId: string,
): Promise<ActionResult<CoreDocument[]>> {
  try {
    const rows = await ingestionQuery<CoreDocument>(
      `SELECT * FROM documents WHERE opportunity_id = $1 ORDER BY ingested_at DESC`,
      [opportunityId],
    );
    return { ok: true, data: rows };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to list documents." };
  }
}
