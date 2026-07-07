import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createSupabaseServer } from "@/lib/supabase/server";
import { ingestionQuery, ingestionQueryOne } from "@/lib/ingestion-db";
import { logAuditEvent } from "@/app/actions/audit";
import { extractText, SUPPORTED_MIME_TYPES } from "@/lib/file-text-extraction";
import { chunkText } from "@/lib/chunk-text";
import type { CoreDocument } from "@/lib/db-types";

// Tender document upload — a plain API route, NOT a Server Action.
// pdf-parse crashes when bundled into Next's restricted "action-browser"
// runtime (TypeError: Object.defineProperty called on non-object, from
// lib/file-text-extraction.ts) — a known category of issue where certain
// packages don't bundle cleanly for Server Actions. Normal API routes use
// the standard Node.js serverless bundle, which doesn't have this
// restriction. See app/api/skill/route.ts / app/api/retrieve/route.ts for
// the same "plain route, not a server action" pattern already used for
// the Python bridges.

export const runtime = "nodejs";

const BUCKET = "tender_documents";
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_TYPES = SUPPORTED_MIME_TYPES;
const CHUNK_MAX_CHARS = 2000;

export async function POST(request: NextRequest) {
  try {
    return await handleUpload(request);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unexpected server error.";
    const hint = msg.includes("APP_INGESTION_DB_URL")
      ? " (Deployment config: add APP_INGESTION_DB_URL in Vercel -> Settings -> Environment Variables, then redeploy. See SETUP.md.)"
      : "";
    console.error("[tender-upload]", msg);
    return NextResponse.json({ ok: false, error: msg + hint }, { status: 500 });
  }
}

async function handleUpload(request: NextRequest) {
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

  const opp = await ingestionQueryOne<{ opportunity_id: string }>(
    "SELECT opportunity_id FROM opportunities WHERE opportunity_id = $1",
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

  const fileHash = createHash("sha256").update(text).digest("hex");
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const path = `${opportunityId}/${Date.now()}-${safeName}`;

  const { error: storageErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (storageErr) return NextResponse.json({ ok: false, error: storageErr.message }, { status: 500 });

  const document = await ingestionQueryOne<CoreDocument>(
    `INSERT INTO documents (opportunity_id, filename, source_type, blob_url, file_hash)
     VALUES ($1, $2, 'challenge_doc', $3, $4)
     RETURNING *`,
    [opportunityId, file.name, path, fileHash],
  );
  if (!document) return NextResponse.json({ ok: false, error: "Failed to record document." }, { status: 500 });

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

  return NextResponse.json({ ok: true, data: { document, chunk_count: chunks.length } });
}
