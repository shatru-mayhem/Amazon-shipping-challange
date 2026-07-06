"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { ingestionQuery, ingestionQueryOne } from "@/lib/ingestion-db";
import { logAuditEvent } from "@/app/actions/audit";
import { validate, required } from "@/lib/validation";
import type { ActionResult } from "@/app/actions/auth";
import type { CoreEmailThread, CoreEmailMessage } from "@/lib/db-types";

// Entry point 2 of 2 (see RETRIEVAL_REQUIREMENTS.md): email/CRM import,
// via file upload — same shape as tender_ingestion.ts, not a manual
// per-message form. Writes to core.email_threads / core.email_messages
// (real live schema) via the app_ingestion Postgres role.
//
// NOTE: core.email_messages.body_redacted is documented in
// tender-analysis-schema.sql as "PII-redacted before storage". This MVP
// does NOT perform any redaction — it stores the body as given. Real PII
// scrubbing is a separate piece of work; the column name is not a
// guarantee until that exists.
//
// Expected file format (plain text export — .txt/.csv/.md, same
// text-only constraint as tender_ingestion.ts, for the same reason: no
// PDF/DOCX parser wired up, so no binary formats):
//
//   Subject: <optional, defaults to "General correspondence">
//   ===
//   From: alice@client.com
//   Date: 2026-01-05T10:00:00Z
//   Body text for this message...
//   ===
//   From: bob@amazon.com
//   Date: 2026-01-06T09:00:00Z
//   Reply text...
//
// Each "===" line starts a new message block; each block needs a
// From: line, a Date: line, then the body. Blocks missing sender/date/
// body are skipped, not guessed at.

const BUCKET = "email_imports";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_TYPES = ["text/plain", "text/csv", "text/markdown"];

interface ParsedMessage {
  sender: string;
  sent_at: string;
  body: string;
}

function parseEmailExport(raw: string): { subject: string | null; messages: ParsedMessage[] } {
  const lines = raw.split(/\r?\n/);

  let subject: string | null = null;
  let startIdx = 0;
  if (lines[0]?.trim().toLowerCase().startsWith("subject:")) {
    subject = lines[0].split(":").slice(1).join(":").trim();
    startIdx = 1;
  }

  const blocks = lines
    .slice(startIdx)
    .join("\n")
    .split(/^\s*===\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const messages: ParsedMessage[] = blocks
    .map((block) => {
      const blockLines = block.split(/\r?\n/);
      let sender = "";
      let sentAt = "";
      let bodyStart = blockLines.length;

      for (let i = 0; i < blockLines.length; i++) {
        const line = blockLines[i].trim();
        if (/^from:/i.test(line)) {
          sender = line.split(":").slice(1).join(":").trim();
        } else if (/^date:/i.test(line)) {
          sentAt = line.split(":").slice(1).join(":").trim();
        } else {
          bodyStart = line === "" ? i + 1 : i;
          break;
        }
      }

      return {
        sender,
        sent_at: sentAt,
        body: blockLines.slice(bodyStart).join("\n").trim(),
      };
    })
    .filter((m) => m.sender && m.sent_at && m.body);

  return { subject, messages };
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
  thread: CoreEmailThread;
  messages_imported: number;
  messages_skipped: number;
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
      error: `File type not supported yet: ${file.type || "unknown"}. Supported: .txt, .csv, .md.`,
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

  const text = await file.text();
  const { subject, messages } = parseEmailExport(text);
  const totalBlocks = text.split(/^\s*===\s*$/m).length;

  if (messages.length === 0) {
    return {
      ok: false,
      error: "No valid messages found (each needs a From:, Date:, and body — see expected format in email_ingestion.ts).",
    };
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const path = `${opportunityId}/${Date.now()}-${safeName}`;
  const { error: storageErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (storageErr) return { ok: false, error: storageErr.message };

  const resolvedSubject = subject?.trim() || "General correspondence";
  const thread = await findOrCreateThread(opportunityId, opp.customer_id, resolvedSubject, messages[0].sent_at);
  if (!thread) return { ok: false, error: "Failed to create or find email thread." };

  let imported = 0;
  for (const m of messages) {
    await ingestionQuery(
      `INSERT INTO email_messages (thread_id, sent_at, sender, body_redacted, resolved)
       VALUES ($1, $2, $3, $4, false)`,
      [thread.thread_id, m.sent_at, m.sender, m.body],
    );
    imported++;
  }

  await logAuditEvent({
    eventType: "email_thread.imported",
    opportunityId,
    after: { thread_id: thread.thread_id, filename: file.name, messages_imported: imported },
  });
  revalidatePath("/employee");

  return {
    ok: true,
    data: { thread, messages_imported: imported, messages_skipped: totalBlocks - messages.length },
  };
}

export async function importEmailMessage(input: {
  opportunity_id: string;
  subject: string;
  sender: string;
  sent_at: string;
  body: string;
}): Promise<ActionResult<{ thread: CoreEmailThread; message: CoreEmailMessage }>> {
  const v = validate([
    { field: "opportunity_id", value: input.opportunity_id, check: required("Opportunity") },
    { field: "sender", value: input.sender, check: required("Sender") },
    { field: "sent_at", value: input.sent_at, check: required("Sent at") },
    { field: "body", value: input.body, check: required("Message body") },
  ]);
  if (!v.ok) return { ok: false, error: Object.values(v.errors)[0] };

  const supabase = createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  const opp = await ingestionQueryOne<{ opportunity_id: string; customer_id: string }>(
    "SELECT opportunity_id, customer_id FROM opportunities WHERE opportunity_id = $1",
    [input.opportunity_id],
  );
  if (!opp) return { ok: false, error: "Opportunity not found." };

  const subject = input.subject.trim() || "General correspondence";
  const thread = await findOrCreateThread(input.opportunity_id, opp.customer_id, subject, input.sent_at);
  if (!thread) return { ok: false, error: "Failed to create or find email thread." };

  const message = await ingestionQueryOne<CoreEmailMessage>(
    `INSERT INTO email_messages (thread_id, sent_at, sender, body_redacted, resolved)
     VALUES ($1, $2, $3, $4, false)
     RETURNING *`,
    [thread.thread_id, input.sent_at, input.sender.trim(), input.body],
  );
  if (!message) return { ok: false, error: "Failed to record message." };

  await logAuditEvent({
    eventType: "email_message.imported",
    opportunityId: input.opportunity_id,
    after: { thread_id: thread.thread_id, message_id: message.message_id, sender: input.sender },
  });
  revalidatePath("/employee");

  return { ok: true, data: { thread, message } };
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
