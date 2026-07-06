import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

// Shared text extraction for the two ingestion entry points
// (tender_ingestion.ts, email_ingestion.ts). One place so PDF/DOCX
// support doesn't drift between them.

export const SUPPORTED_MIME_TYPES = [
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
];

export async function extractText(file: File): Promise<string> {
  if (file.type === "application/pdf") {
    const buffer = Buffer.from(await file.arrayBuffer());
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  if (file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // text/plain, text/csv, text/markdown
  return file.text();
}
