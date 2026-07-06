"use server";

import { ingestionQuery } from "@/lib/ingestion-db";
import type { ActionResult } from "@/app/actions/auth";
import type { CoreEmailThread, CoreEmailMessage } from "@/lib/db-types";

// Entry point 2 of 2 (see RETRIEVAL_REQUIREMENTS.md): email/CRM import.
// The actual import (importEmailExportFile) lives in
// app/api/email-import/route.ts, NOT here — same reason as
// tender_ingestion.ts: pdf-parse crashes when bundled into Server
// Actions' restricted "action-browser" runtime. This file keeps the
// two read-only helpers that don't touch file extraction.

export interface EmailImportResult {
  thread: CoreEmailThread | null;
  messages_imported: number;
  crm_notes_document: unknown;
  crm_notes_chunk_count: number;
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
