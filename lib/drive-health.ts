import { DriveError, GoogleDrive } from "./google-drive";

export type DriveHealth = { ready: boolean; code: string; checkedAt: string };

// Read-only checks: never create a test file or alter folder permissions.
export async function inspectDrive(drive: GoogleDrive, root: string, owner: string) {
  await drive.privateFolder(root, owner);
  const about = await drive.call("about?fields=storageQuota(limit,usage)");
  const { limit, usage } = about.storageQuota || {};
  if (limit != null && usage != null && BigInt(usage) >= BigInt(limit))
    throw new DriveError("drive_storage_full");
}

export function healthFailure(error: unknown): DriveHealth {
  return { ready: false, code: error instanceof DriveError ? error.code : "google_temporarily_unavailable", checkedAt: new Date().toISOString() };
}
