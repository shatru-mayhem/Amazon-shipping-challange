// Minimal input validation helpers (no external deps).
// Every server action validates input before touching the database.

export interface ValidationResult {
  ok: boolean;
  errors: Record<string, string>;
}

export function validate(
  rules: Array<{ field: string; value: unknown; check: (v: unknown) => string | null }>,
): ValidationResult {
  const errors: Record<string, string> = {};
  for (const r of rules) {
    const msg = r.check(r.value);
    if (msg) errors[r.field] = msg;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export const required = (label: string) => (v: unknown) =>
  typeof v === "string" && v.trim().length > 0 ? null : label + " is required.";

export const maxLen = (label: string, n: number) => (v: unknown) =>
  typeof v !== "string" || v.length <= n
    ? null
    : label + " must be " + n + " characters or fewer.";

export const isEmail = (label: string) => (v: unknown) =>
  typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
    ? null
    : label + " must be a valid email.";

export const oneOf =
  (label: string, allowed: readonly string[]) => (v: unknown) =>
    typeof v === "string" && allowed.includes(v)
      ? null
      : label + " must be one of: " + allowed.join(", ") + ".";
