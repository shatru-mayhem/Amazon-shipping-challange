import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createSupabaseServer } from "@/lib/supabase/server";
import { ingestionQuery, ingestionQueryOne } from "@/lib/ingestion-db";
import { logAuditEvent } from "@/app/actions/audit";
import { extractText, SUPPORTED_MIME_TYPES } from "@/lib/file-text-extraction";
import { chunkText } from "@/lib/chunk-text";
import { parseEmailBlocks } from "@/lib/parse-email-export";
import type { CoreEmailThread, CoreDocument } from "@/lib/db-types";

// Email/CRM import — a plain API route, NOT a Server Action. Same reason
// as app/api/tender-upload/route.ts: pdf-parse (via lib/file-text-extraction.ts)
// crashes when bundled into Server Actions' restricted "action-browser"
// runtime.

export const runtime = "nodejs";

const BUCKET = "email_imports";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_TYPES = SUPPORTED_MIME_TYPES;
const CHUNK_MAX_CHARS = 2000;

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

export async function POST(request: NextRequest) {
  try {
    return await handleImport(request);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unexpected server error.";
    const hint = msg.includes("APP_INGESTION_DB_URL")
      ? " (Deployment config: add APP_INGESTION_DB_URL in Vercel -> Settings -> Environment Variables, then redeploy. See SETUP.md.)"
      : "";
    console.error("[email-import]", msg);
    return NextResponse.json({ ok: false, error: msg + hint }, { status: 500 });
  }
}

async function handleImport(request: NextRequest) {
  const formData = await request.formData();
  const file = formData.get("file");
  const opportunityId = String(formData.get("opportunity_id") ?? "");

  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "No file provided." }, { status: 400 });
  if (!opportunityId) return NextResponse.json({ ok: false, error: "opportunity_id is required." }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) return NextResponse.json({ ok: false, error: "File exceeds the 25 MB limit." }, { status: 400 });
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { ok: false, error: `File type not supported: ${file.type || "unknown"}. Supported: .txt, .csv, .md, .pdf, .docx.` },
      { status: 400 },
    );
  }

  const supabase = createSupabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });

  const opp = await ingestionQueryOne<{ opportunity_id: string; customer_id: string }>(
    "SELECT opportunity_id, customer_id FROM opportunities WHERE opportunity_id = $1",
    [opportunityId],
  );
  if (!opp) return NextResponse.json({ ok: false, error: "Opportunity not found." }, { status: 404 });

  let text: string;
  try {
    text = await extractText(file);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Could not extract text from file: ${e instanceof Error ? e.message : "unknown error"}` },
      { status: 422 },
    );
  }
  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: "File appears to be empty (or text extraction found nothing)." }, { status: 422 });
  }

  const { subject, messages, leftoverText } = parseEmailBlocks(text);
  if (messages.length === 0 && !leftoverText) {
    return NextResponse.json({ ok: false, error: "No content found after text extraction." }, { status: 422 });
  }

  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const path = `${opportunityId}/${Date.now()}-${safeName}`;
  const { error: storageErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (storageErr) return NextResponse.json({ ok: false, error: storageErr.message }, { status: 500 });

  let thread: CoreEmailThread | null = null;
  if (messages.length > 0) {
    const resolvedSubject = subject || "General correspondence";
    thread = await findOrCreateThread(opportunityId, opp.customer_id, resolvedSubject, messages[0].sent_at);
    if (!thread) return NextResponse.json({ ok: false, error: "Failed to create or find email thread." }, { status: 500 });

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

  return NextResponse.json({
    ok: true,
    data: { thread, messages_imported: messages.length, crm_notes_document: crmDoc, crm_notes_chunk_count: crmChunkCount },
  });
}
