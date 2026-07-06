"use server";

import { createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { ingestionQuery, ingestionQueryOne } from "@/lib/ingestion-db";
import { logAuditEvent } from "@/app/actions/audit";
import { extractText, SUPPORTED_MIME_TYPES } from "@/lib/file-text-extraction";
import { chunkText } from "@/lib/chunk-text";
import type { ActionResult } from "@/app/actions/auth";
import type { CoreDocument } from "@/lib/db-types";

// Entry point 1 of 2 (see RETRIEVAL_REQUIREMENTS.md): tender document
// upload. Writes to the REAL live schema (core.documents,
// core.document_chunks — see tender-analysis-schema.sql), via the
// app_ingestion Postgres role (lib/ingestion-db.ts), not the legacy
// evidence_documents flow in documents.ts.

const BUCKET = "tender_documents";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_TYPES = SUPPORTED_MIME_TYPES;
const CHUNK_MAX_CHARS = 2000;

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

export async function uploadTenderDocument(
  formData: FormData,
): Promise<ActionResult<TenderUploadResult>> {
  const file = formData.get("file");
  const opportunityId = String(formData.get("opportunity_id") ?? "");

  if (!(file instanceof File)) return { ok: false, error: "No file provided." };
  if (!opportunityId) return { ok: false, error: "opportunity_id is required." };
  if (file.size > MAX_FILE_BYTES) return { ok: false, error: "File exceeds the 25 MB limit." };
  if (!ALLOWED_TYPES.includes(file.type)) {
    return {
      ok: false,
      error: `File type not supported: ${file.type || "unknown"}. Supported: .txt, .csv, .md, .pdf, .docx.`,
    };
  }

  const supabase = createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const opp = await ingestionQueryOne<{ opportunity_id: string }>(
    "SELECT opportunity_id FROM opportunities WHERE opportunity_id = $1",
    [opportunityId],
  );
  if (!opp) return { ok: false, error: "Opportunity not found." };

  let text: string;
  try {
    text = await extractText(file);
  } catch (e) {
    return { ok: false, error: `Could not extract text from file: ${e instanceof Error ? e.message : "unknown error"}` };
  }
  if (!text.trim()) return { ok: false, error: "File appears to be empty (or text extraction found nothing)." };

  const fileHash = createHash("sha256").update(text).digest("hex");
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const path = `${opportunityId}/${Date.now()}-${safeName}`;

  const { error: storageErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (storageErr) return { ok: false, error: storageErr.message };

  const document = await ingestionQueryOne<CoreDocument>(
    `INSERT INTO documents (opportunity_id, filename, source_type, blob_url, file_hash)
     VALUES ($1, $2, 'challenge_doc', $3, $4)
     RETURNING *`,
    [opportunityId, file.name, path, fileHash],
  );
  if (!document) return { ok: false, error: "Failed to record document." };

  const chunks = chunkText(text, CHUNK_MAX_CHARS);
  for (let i = 0; i < chunks.length; i++) {
    await ingestionQuery(
      `INSERT INTO document_chunks (document_id, section_heading, page_number, raw_text)
       VALUES ($1, NULL, $2, $3)`,
      [document.document_id, i + 1, chunks[i]],
    );
  }

  await logAuditEvent({
    eventType: "tender_document.uploaded",
    opportunityId,
    after: { document_id: document.document_id, filename: file.name, chunk_count: chunks.length },
  });
  revalidatePath("/employee");

  return { ok: true, data: { document, chunk_count: chunks.length } };
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
