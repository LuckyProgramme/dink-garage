import "server-only";
import { recorderDatabase } from "./recorder-server";
import { decryptSecret } from "./google-crypto";
import { DriveError, GoogleDrive } from "./google-drive";
import { inspectDrive, healthFailure, type DriveHealth } from "./drive-health";
import { googleRedirectUri } from "./google-redirect";

export function googleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const root = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  const owner = process.env.GOOGLE_SENDER_EMAIL;
  if (!clientId || !clientSecret || !root || !owner || !process.env.TOKEN_ENCRYPTION_KEY)
    throw new DriveError("google_configuration_missing");
  let redirect: string;
  try {
    redirect = googleRedirectUri();
  } catch {
    throw new DriveError("google_redirect_invalid");
  }
  return { clientId, clientSecret, redirect, root, owner };
}
export async function googleToken(fields: Record<string,string>) {
  const config = googleConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,...fields}),
  });
  if (!response.ok) throw new DriveError(response.status === 429 || response.status >= 500 ? "google_temporarily_unavailable" : "google_reconnect_required", response.status === 429 || response.status>=500);
  return response.json();
}
export async function connectedDrive() {
  const db = recorderDatabase();
  const {data,error} = await db.from("google_integration").select("*").eq("id",true).maybeSingle();
  if (error) throw new DriveError("database_unavailable",true);
  if (!data) throw new DriveError("google_not_connected");
  const config = googleConfig();
  if (data.owner_email.toLowerCase() !== config.owner.toLowerCase() || data.root_folder_id !== config.root)
    throw new DriveError("google_reconnect_required");
  try {
    const tokens = await googleToken({grant_type:"refresh_token",refresh_token:decryptSecret(data.refresh_token_encrypted)});
    if (data.safe_error) await db.from("google_integration").update({safe_error:null}).eq("id",true);
    return {db,integration:data,drive:new GoogleDrive(tokens.access_token),accessToken:tokens.access_token as string};
  } catch(e) {
    await db.from("google_integration").update({safe_error:e instanceof DriveError?e.code:"google_temporarily_unavailable"}).eq("id",true);
    throw e;
  }
}
export const driveMessages: Record<string,string> = {
  drive_storage_full:"Google Drive storage is full. Free space or upgrade storage before starting a new recording.",
  drive_file_missing:"The recording folder could not be found. Check the configured Drive folder.",
  google_configuration_missing:"Google credentials must be configured on the server.",
  google_redirect_invalid:"Configure APP_ORIGIN as the hosted HTTPS application origin.",
  google_not_connected:"Connect the owner's Google account in Admin Settings.",
  google_reconnect_required:"Reconnect the owner's Google account.",
  wrong_google_account:"Use the configured owner's Google account.",
  drive_folder_must_be_private:"The configured Drive folder must be private and owned by the connected account.",
  drive_file_not_private:"Unexpected Drive sharing was detected. Ask the administrator to check access.",
  real_player_email_required:"This recording needs a real Google-account recipient. The demo example.com address cannot receive access.",
  drive_access_or_quota:"Check Drive storage space and the owner's folder permissions.",
  google_temporarily_unavailable:"Google is temporarily unavailable. Upload will retry.",
  local_file_missing:"The recording file is missing from the venue computer.",
  upload_integrity_failed:"The uploaded file did not match the saved recording.",
  venue_timezone_required:"Set the venue time zone in Admin Settings.",
};

// A short per-instance cache bounds Google requests from dashboard polling.
// Cold instances check again; no persisted healthy state can become stale forever.
let health: DriveHealth | undefined;
let pendingHealth: Promise<DriveHealth> | undefined;
export function checkDriveHealth(force = false): Promise<DriveHealth> {
  if (pendingHealth) return pendingHealth;
  if (!force && health && Date.now() - Date.parse(health.checkedAt) < 30000) return Promise.resolve(health);
  pendingHealth = (async () => {
    try {
      const {drive, integration} = await connectedDrive();
      await inspectDrive(drive, integration.root_folder_id, integration.owner_email);
      health = {ready:true,code:"connected",checkedAt:new Date().toISOString()};
    } catch (error) { health = healthFailure(error); }
    return health;
  })().finally(() => { pendingHealth = undefined; });
  return pendingHealth;
}
