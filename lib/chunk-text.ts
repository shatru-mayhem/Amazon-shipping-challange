// Shared paragraph-aware chunking for document_chunks.raw_text, used by
// both tender_ingestion.ts and email_ingestion.ts (for the CRM-notes /
// non-email portion of an import).

export function chunkText(text: string, maxChars: number): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current && current.length + para.length + 2 > maxChars) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text.trim()].filter(Boolean);
}
