export const TEAM_RECIPIENT_COUNT = 4;

const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function normalizeRecipients(value: unknown, legacy?: unknown) {
  const input = Array.isArray(value)
    ? value
    : typeof legacy === "string"
      ? [legacy]
      : [];
  const emails = input
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean);
  if (emails.length < 1 || emails.length > TEAM_RECIPIENT_COUNT) return null;
  if (
    emails.some(
      (email) =>
        email.length > 254 ||
        !EMAIL.test(email) ||
        /@example\.(com|net|org)$/i.test(email),
    ) ||
    new Set(emails).size !== emails.length
  )
    return null;
  return emails;
}

export function validTeamRecipients(value: string[]) {
  return Boolean(normalizeRecipients(value));
}
