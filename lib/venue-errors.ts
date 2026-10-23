// Report schema rollout failures without treating missing hardware as an outage.
export function venueStateError(error: unknown, fallback: string) {
  const value = error as {code?: string; message?: string} | null;
  if (value && ["PGRST205", "PGRST200", "42703"].includes(value.code || "")
      && /\btenants\b|\btenant_id\b/.test(value.message || ""))
    return "Venue configuration needs a database update. Ask the administrator to finish the update. A connected tablet is not required to browse these pages.";
  if (value && ["PGRST205", "PGRST200", "PGRST202", "42703", "42P01"].includes(value.code || ""))
    return "Venue configuration needs a database update. Ask the administrator to check the database setup.";
  return fallback;
}
