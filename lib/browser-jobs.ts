import "server-only";
import { randomUUID } from "node:crypto";
import { recorderDatabase } from "./recorder-server";
import { connectedDrive } from "./google-server";
import { deleteExpiredVideo } from "./retention";
import { deliverNextEmail } from "./email-server";
import { browserUpload } from "./browser-upload";
export async function runBrowserJobs() {
  const db = recorderDatabase();
  const began = Date.now();
  // Bound each run. Further items remain queued for the next scheduled invocation.
  const stale = await db
    .from("browser_recordings")
    .select("session_id,recording_sessions!inner(status)")
    .in("recording_sessions.status", ["requested", "recording"])
    .lt("last_seen_at", new Date(Date.now() - 120000).toISOString())
    .limit(100);
  if (stale.error) throw stale.error;
  if (stale.data.length)
    await db
      .from("recording_sessions")
      .update({
        status: "failed",
        failure_stage: "browser_interrupted",
        stopped_at: new Date().toISOString(),
      })
      .in(
        "id",
        stale.data.map((x) => x.session_id),
      )
      .in("status", ["requested", "recording"]);
  const pending = await db
    .from("browser_recordings")
    .select("session_id,device_id,upload_state,recording_sessions!inner(status)")
    .not("drive_id", "is", null)
    .not("device_id", "is", null)
    .eq("upload_state", "uploading")
    .in("recording_sessions.status", ["uploading", "sharing"])
    .limit(2);
  for (const row of pending.data || []) {
    try {
      await browserUpload(row.session_id, row.device_id!, true);
    } catch {
      /* Tablet may still be uploading. Reconcile on the next run. */
    }
  }
  await deliverNextEmail();
  const expired = await db
    .from("browser_recordings")
    .select(
      "session_id,file_id,drive_id,folder_id,root_id,recording_files!inner(drive_file_id,expires_at,status,deleted_at)",
    )
    .lte("recording_files.expires_at", new Date().toISOString())
    .is("recording_files.deleted_at", null)
    .in("recording_files.status", ["ready", "deleting"])
    .limit(3);
  if (expired.error) throw expired.error;
  for (const row of expired.data || []) {
    if (Date.now() - began > 40000) break;
    const token = randomUUID();
    const claim = await db
      .from("browser_recordings")
      .update({
        lease_token: token,
        lease_until: new Date(Date.now() + 90000).toISOString(),
      })
      .eq("session_id", row.session_id)
      .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`)
      .select("session_id")
      .maybeSingle();
    if (!claim.data) continue;
    try {
      const f = row.recording_files as unknown as {
        drive_file_id: string;
        expires_at: string;
      };
      if (f.drive_file_id !== row.drive_id || !row.folder_id)
        throw Error("cleanup_identity_mismatch");
      const { drive, integration } = await connectedDrive();
      if (integration.root_folder_id !== row.root_id)
        throw Error("cleanup_connection_changed");
      await db
        .from("recording_sessions")
        .update({ status: "deleting" })
        .eq("id", row.session_id);
      await deleteExpiredVideo(
        drive,
        f,
        row.folder_id,
        integration.owner_email,
      );
      const deleted = await db
        .from("recording_files")
        .update({ status: "deleted", deleted_at: new Date().toISOString() })
        .eq("id", row.file_id);
      if (deleted.error) throw deleted.error;
      await db
        .from("recording_sessions")
        .update({ status: "deleted" })
        .eq("id", row.session_id);
      await db
        .from("browser_recordings")
        .update({ safe_error: null })
        .eq("session_id", row.session_id);
      await db
        .from("audit_events")
        .insert({
          session_id: row.session_id,
          action: "retention.browser_cloud_deleted",
        });
    } catch {
      await db
        .from("browser_recordings")
        .update({
          safe_error: "Cloud cleanup needs attention; retry scheduled.",
        })
        .eq("session_id", row.session_id);
    } finally {
      await db
        .from("browser_recordings")
        .update({ lease_until: null })
        .eq("session_id", row.session_id)
        .eq("lease_token", token);
    }
  }
  const health = await db
    .from("venue_settings")
    .update({ browser_worker_at: new Date().toISOString() })
    .eq("id", true);
  if (health.error) throw health.error;
  return { ok: true };
}
