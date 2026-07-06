"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServer } from "@/lib/supabase/server";
import { logAuditEvent } from "@/app/actions/audit";
import type { EvidenceDocument, DocSourceType } from "@/lib/db-types";
import type { ActionResult } from "@/app/actions/auth";

// Feature 3 (webdev.md): secure document management via Supabase Storage.
// Buckets: client_uploads (client-facing), internal_evidence (employee-only).
// RLS on storage.objects + evidence_documents enforces per-project access.

const BUCKETS: Record<DocSourceType, string> = {
  client_upload: "client_uploads",
  internal_evidence: "internal_evidence",
};

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB
const ALLOWED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "image/png",
  "image/jpeg",
];

export async function uploadDocument(
  formData: FormData,
): Promise<ActionResult<EvidenceDocument>> {
  const file = formData.get("file");
  const opportunityId = String(formData.get("opportunity_id") ?? "");
  const sourceType = String(formData.get("source_type") ?? "client_upload") as DocSourceType;

  if (!(file instanceof File)) return { ok: false, error: "No file provided." };
  if (!opportunityId) return { ok: false, error: "opportunity_id is required." };
  if (!BUCKETS[sourceType]) return { ok: false, error: "Invalid source_type." };
  if (file.size > MAX_FILE_BYTES)
    return { ok: false, error: "File exceeds the 25 MB limit." };
  if (!ALLOWED_TYPES.includes(file.type))
    return { ok: false, error: "File type not allowed: " + file.type };

  const supabase = createSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated." };

  // Path scoped per opportunity: <opportunity_id>/<timestamp>-<name>
  const safeName = file.name.replace(/[^\w.\-]+/g, "_").slice(0, 120);
  const path = opportunityId + "/" + Date.now() + "-" + safeName;

  const { error: storageErr } = await supabase.storage
    .from(BUCKETS[sourceType])
    .upload(path, file, { contentType: file.type, upsert: false });
  if (storageErr) return { ok: false, error: storageErr.message };

  const { data, error } = await supabase
    .from("evidence_documents")
    .insert({
      opportunity_id: opportunityId,
      source_type: sourceType,
      file_path: path,
      uploaded_by: user.id,
    })
    .select()
    .single();
  if (error) return { ok: false, error: error.message };

  await logAuditEvent({
    eventType: "document.uploaded",
    opportunityId,
    after: { file_path: path, source_type: sourceType },
  });
  revalidatePath("/client");
  return { ok: true, data: data as EvidenceDocument };
}

export async function listDocuments(
  opportunityId: string,
): Promise<ActionResult<EvidenceDocument[]>> {
  const supabase = createSupabaseServer();
  const { data, error } = await supabase
    .from("evidence_documents")
    .select("*")
    .eq("opportunity_id", opportunityId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: (data ?? []) as EvidenceDocument[] };
}

// Time-limited signed URL so private files are never publicly exposed.
export async function getDocumentUrl(
  sourceType: DocSourceType,
  filePath: string,
): Promise<ActionResult<{ url: string }>> {
  const supabase = createSupabaseServer();
  const { data, error } = await supabase.storage
    .from(BUCKETS[sourceType])
    .createSignedUrl(filePath, 60 * 10);
  if (error || !data) return { ok: false, error: error?.message ?? "No URL." };
  return { ok: true, data: { url: data.signedUrl } };
}
