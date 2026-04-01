/**
 * Redact PII for structured logs (never log full email/phone at info level).
 */

export const redactEmail = (email: string): string => {
  const at = email.indexOf("@");
  if (at <= 0) return "[redacted]";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length <= 2) return `***@${domain}`;
  return `${local[0]}***${local.slice(-1)}@${domain}`;
};

/** E.164 or national digits — keep country/area prefix, hide middle. */
export const redactPhone = (e164: string): string => {
  const s = e164.trim();
  if (s.length <= 6) return "***";
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
};
