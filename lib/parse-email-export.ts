// Parses a plain-text email export into structured messages + whatever
// doesn't match the email-header shape (CRM notes, disclaimers, etc.).
// Pure function, no DB/server deps — shared by app/api/email-import/route.ts.

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Handles "Wednesday, 10 June 2026, 09:14" and similar. Returns null
// (never a guessed date) if it can't be parsed — the caller then treats
// that block as unparseable, not as an email with a made-up timestamp.
export function parseHumanDate(input: string): string | null {
  const cleaned = input.replace(/^\w+,\s*/, "").trim();
  const m = cleaned.match(/(\d{1,2})\s+(\w+)\s+(\d{4}),?\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, day, monthName, year, hour, minute] = m;
  const month = MONTHS[monthName.toLowerCase()];
  if (month === undefined) return null;
  const dt = new Date(Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute)));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

export interface ParsedEmailMessage {
  sender: string;
  sent_at: string;
  subject: string;
  body: string;
}

export function parseEmailBlocks(raw: string): {
  subject: string | null;
  messages: ParsedEmailMessage[];
  leftoverText: string;
} {
  const normalized = raw.replace(/\r\n/g, "\n");
  const parts = normalized.split(/\n(?=From:\s)/i);

  const messages: ParsedEmailMessage[] = [];
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
