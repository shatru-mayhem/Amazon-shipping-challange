"use server";

import { createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { ingestionQuery, ingestionQueryOne } from "@/lib/ingestion-db";
import { logAuditEvent } from "@/app/actions/audit";
import { extractText, SUPPORTED_MIME_TYPES } from "@/lib/file-text-extraction";
import { chunkText } from "@/lib/chunk-text";
import type { ActionResult } from "@/app/actions/auth";
import type { CoreEmailThread, CoreEmailMessage, CoreDocument } from "@/lib/db-types";

// Entry point 2 of 2 (see RETRIEVAL_REQUIREMENTS.md): email/CRM import,
// via file upload (PDF/DOCX/txt — same formats as tender_ingestion.ts).
// Real CRM/email exports mix two kinds of content in one file:
//   1. Actual email correspondence — From:/To:/Date:/Subject: headers
//      followed by a body, one after another. Parsed into structured
//      core.email_threads / core.email_messages.
//   2. Free-form CRM notes (account overview, running log entries) that
//      don't follow that header shape at all. Whatever doesn't parse as
//      an email is NOT discarded — it's chunked and stored as a document
//      (core.documents/document_chunks, source_type 'market_intel') the
//      same way tender_ingestion.ts stores challenge docs, so
//      client_highlights / opportunity_features retrieval can still read
//      it. Nothing in the file is silently dropped.
//
// NOTE: core.email_messages.body_redacted is documented in
// tender-analysis-schema.sql as "PII-redacted before storage". This MVP
// does NOT perform any redaction — it stores the body as extracted. Real
// PII scrubbing is a separate piece of work.

const BUCKET = "email_imports";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_TYPES = SUPPORTED_MIME_TYPES;
const CHUNK_MAX_CHARS = 2000;

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Handles "Wednesday, 10 June 2026, 09:14" and similar. Returns null
// (never a guessed date) if it can't be parsed — the caller then treats
// that block as unparseable, not as an email with a made-up timestamp.
function parseHumanDate(input: string): string | null {
  const cleaned = input.replace(/^\w+,\s*/, "").trim();
  const m = cleaned.match(/(\d{1,2})\s+(\w+)\s+(\d{4}),?\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, day, monthName, year, hour, minute] = m;
  const month = MONTHS[monthName.toLowerCase()];
  if (month === undefined) return null;
  const dt = new Date(Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute)));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

interface ParsedMessage {
  sender: string;
  sent_at: string;
  subject: string;
}

function parseEmailBlocks(raw: string): { subject: string | null; messages: (ParsedMessage & { body: string })[]; leftoverText: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const parts = normalized.split(/\n(?=From:\s)/i);

  const messages: (ParsedMessage & { body: string })[] = [];
  const leftover: string[] = [];

  for (const part of parts) {
    if (!/^From:\s/i.test(part.trim())) {
      leftover.push(part);
      continue;
    }

    const lines = part.split("\n");
    let sender = "";
    let sentAtRaw = "";
    let subject = "";
    let bodyStart = lines.length;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^from:/i.test(line)) sender = line.replace(/^from:/i, "").trim();
      else if (/^to:/i.test(line) || /^cc:/i.test(line)) continue;
      else if (/^date:/i.test(line)) sentAtRaw = line.replace(/^date:/i, "").trim();
      else if (/^subject:/i.test(line)) subject = line.replace(/^subject:/i, "").trim();
      else if (line === "") continue;
      else {
        bodyStart = i;
        break;
      }
    }

    const body = lines.slice(bodyStart).join("\n").trim();
    const sentAt = sentAtRaw ? parseHumanDate(sentAtRaw) : null;

    if (sender && sentAt && body) {
      messages.push({ sender, sent_at: sentAt, subject, body });
    } else {
      leftover.push(part);
    }
  }

  const subject = messages.find((m) => m.subject)?.subject.replace(/^RE:\s*/i, "").trim() ?? null;
  return { subject, messages, leftoverText: leftover.join("\n\n").trim() };
}

async function findOrCreateThread(
  opportunityId: string,
  customerId: string,
  subject: string,
  startedAt: string,
): Promise<CoreEmailThread | null> {
  const existing = await ingestionQueryOne<CoreEmailThread>(
    `SELECT * FROM email_threads WHERE opportunity_id = $1 AND subject = $2 LIMIT 1`,
    [opportunityId, subject],
  );
  if (existing) return existing;

  return ingestionQueryOne<CoreEmailThread>(
    `INSERT INTO email_threads (customer_id, opportunity_id, subject, started_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [customerId, opportunityId, subject, startedAt],
  );
}

export interface EmailImportResult {
  thread: CoreEmailThread | null;
  messages_imported: number;
  crm_notes_document: CoreDocument | null;
  crm_notes_chunk_count: number;
}

export async function importEmailExportFile(
  formData: FormData,
): Promise<ActionResult<EmailImportResult>> {
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

  const opp = await ingestionQueryOne<{ opportunity_id: string; customer_id: string }>(
    "SELECT opportunity_id, customer_id FROM opportunities WHERE opportunity_id = $1",
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

  const { subject, messages, leftoverText } = parseEmailBlocks(text);
  if (messages.length === 0 && !leftoverText) {
    return { ok: false, error: "No content found after text extraction." };
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const path = `${opportunityId}/${Date.now()}-${safeName}`;
  const { error: storageErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (storageErr) return { ok: false, error: storageErr.message };

  let thread: CoreEmailThread | null = null;
  if (messages.length > 0) {
    const resolvedSubject = subject || "General correspondence";
    thread = await findOrCreateThread(opportunityId, opp.customer_id, resolvedSubject, messages[0].sent_at);
    if (!thread) return { ok: false, error: "Failed to create or find email thread." };

    for (const m of messages) {
      await ingestionQuery(
        `INSERT INTO email_messages (thread_id, sent_at, sender, body_redacted, resolved)
         VALUES ($1, $2, $3, $4, false)`,
        [thread.thread_id, m.sent_at, m.sender, m.body],
      );
    }
  }

  let crmDoc: CoreDocument | null = null;
  let crmChunkCount = 0;
  if (leftoverText.length > 0) {
    const fileHash = createHash("sha256").update(leftoverText).digest("hex");
    crmDoc = await ingestionQueryOne<CoreDocument>(
      `INSERT INTO documents (opportunity_id, filename, source_type, blob_url, file_hash)
       VALUES ($1, $2, 'market_intel', $3, $4)
       RETURNING *`,
      [opportunityId, file.name, path, fileHash],
    );
    if (crmDoc) {
      const chunks = chunkText(leftoverText, CHUNK_MAX_CHARS);
      for (let i = 0; i < chunks.length; i++) {
        await ingestionQuery(
          `INSERT INTO document_chunks (document_id, section_heading, page_number, raw_text)
           VALUES ($1, NULL, $2, $3)`,
          [crmDoc.document_id, i + 1, chunks[i]],
        );
      }
      crmChunkCount = chunks.length;
    }
  }

  await logAuditEvent({
    eventType: "email_crm.imported",
    opportunityId,
    after: {
      filename: file.name,
      thread_id: thread?.thread_id ?? null,
      messages_imported: messages.length,
      crm_notes_chunks: crmChunkCount,
    },
  });
  revalidatePath("/employee");

  return {
    ok: true,
    data: { thread, messages_imported: messages.length, crm_notes_document: crmDoc, crm_notes_chunk_count: crmChunkCount },
  };
}

export async function listEmailThreads(
  opportunityId: string,
): Promise<ActionResult<CoreEmailThread[]>> {
  try {
    const rows = await ingestionQuery<CoreEmailThread>(
      `SELECT * FROM email_threads WHERE opportunity_id = $1 ORDER BY started_at DESC NULLS LAST`,
      [opportunityId],
    );
    return { ok: true, data: rows };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to list threads." };
  }
}

export async function listEmailMessages(
  threadId: string,
): Promise<ActionResult<CoreEmailMessage[]>> {
  try {
    const rows = await ingestionQuery<CoreEmailMessage>(
      `SELECT * FROM email_messages WHERE thread_id = $1 ORDER BY sent_at ASC`,
      [threadId],
    );
    return { ok: true, data: rows };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to list messages." };
  }
}
