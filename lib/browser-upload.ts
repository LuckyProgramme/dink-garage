import "server-only";
import { randomUUID } from "node:crypto";
import { recorderDatabase } from "./recorder-server";
import { connectedDrive } from "./google-server";
import { DriveError, localDay, recordingFileName } from "./google-drive";
import { encryptSecret, decryptSecret } from "./google-crypto";

export type BrowserUploadQueue = {
  allowed: boolean;
  state:
    | "idle"
    | "queued"
    | "saved_locally"
    | "pending"
    | "uploading"
    | "retrying"
    | "uploaded"
    | "failed"
    | "cancelled"
    | "local_only"
    | "complete";
  position: number;
  total: number;
  activeSession: string | null;
  activeDevice: string | null;
  activeCourt: string | null;
  uploadedBytes: number;
  totalBytes: number;
  percent: number;
  blocked: boolean;
};

function publicQueue(row: any): BrowserUploadQueue {
  return {
    allowed: !!row.allowed,
    state: row.upload_state,
    position: Number(row.queue_position || 0),
    total: Number(row.queue_total || 0),
    activeSession: row.active_session || null,
    activeDevice: row.active_device_name || null,
    activeCourt: row.active_court_name || null,
    uploadedBytes: Number(row.active_uploaded_bytes || 0),
    totalBytes: Number(row.active_total_bytes || 0),
    percent: Number(row.active_percent || 0),
    blocked: !!row.blocked_by_failure,
  };
}

export async function browserUploadQueue(
  sessionId: string,
  deviceId: string,
  claim = false,
) {
  const db = recorderDatabase();
  const result = await db.rpc("browser_upload_turn", {
    p_session: sessionId,
    p_device: deviceId,
    p_claim: claim,
  });
  if (result.error)
    throw new Error("Apply the latest database migration for upload queuing.");
  const row = result.data?.[0];
  if (!row) throw new Error("This recording is not available in the upload queue.");
  return publicQueue(row);
}

async function reportUpload(
  sessionId: string,
  deviceId: string,
  state: "uploading" | "failed" | "complete",
  uploadedBytes: number,
) {
  const db = recorderDatabase();
  const result = await db.rpc("report_browser_upload", {
    p_session: sessionId,
    p_device: deviceId,
    p_state: state,
    p_uploaded_bytes: uploadedBytes,
  });
  if (result.error || !result.data)
    throw new Error("Upload queue state changed. Retry the saved video.");
}

// Google's resumable Range header is not reliably exposed through CORS.
// Probe on the server; return only the acknowledged offset, never Google tokens.
export async function browserUploadStatus(sessionId: string, deviceId: string) {
  const db = recorderDatabase();
  const b = await db
    .from("browser_recordings")
    .select("upload_uri_encrypted,bytes,upload_state")
    .eq("session_id", sessionId)
    .eq("device_id", deviceId)
    .single();
  if (
    b.error ||
    b.data.upload_state !== "uploading" ||
    !b.data.upload_uri_encrypted
  )
    throw new Error("Prepare the upload before checking progress.");
  const bytes = Number(b.data.bytes);
  const r = await fetch(decryptSecret(b.data.upload_uri_encrypted), {
    method: "PUT",
    redirect: "manual",
    headers: { "Content-Range": `bytes */${bytes}` },
    body: new Uint8Array(),
    signal: AbortSignal.timeout(15000),
  });
  if (r.ok) {
    await reportUpload(sessionId, deviceId, "uploading", bytes);
    return { uploaded: true };
  }
  if (r.status === 404 || r.status === 410) return { expired: true };
  if (r.status !== 308)
    throw new Error("Google upload progress is temporarily unavailable.");
  const range = r.headers.get("Range");
  if (range && !/^bytes=0-\d+$/.test(range))
    throw new Error("Invalid Google upload progress.");
  const offset = range ? Number(range.split("-")[1]) + 1 : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes)
    throw new Error("Invalid Google upload progress.");
  await reportUpload(sessionId, deviceId, "uploading", offset);
  return { offset };
}

export async function browserUploadChunk(
  sessionId: string,
  deviceId: string,
  contentRange: string,
  mimeType: string,
  chunk: Uint8Array,
) {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
  if (!match) throw new Error("Invalid upload range.");
  const start = Number(match[1]),
    end = Number(match[2]),
    total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    end >= total ||
    chunk.byteLength !== end - start + 1 ||
    chunk.byteLength > 4 * 1024 * 1024
  )
    throw new Error("Invalid upload chunk.");
  const db = recorderDatabase();
  const b = await db
    .from("browser_recordings")
    .select("upload_uri_encrypted,bytes,mime_type,upload_state")
    .eq("session_id", sessionId)
    .eq("device_id", deviceId)
    .single();
  if (
    b.error ||
    b.data.upload_state !== "uploading" ||
    !b.data.upload_uri_encrypted ||
    Number(b.data.bytes) !== total ||
    b.data.mime_type !== mimeType
  )
    throw new Error("Upload session does not match this recording.");
  const r = await fetch(decryptSecret(b.data.upload_uri_encrypted), {
    method: "PUT",
    redirect: "manual",
    headers: {
      "Content-Type": mimeType,
      "Content-Range": contentRange,
    },
    body: chunk.buffer.slice(
      chunk.byteOffset,
      chunk.byteOffset + chunk.byteLength,
    ) as ArrayBuffer,
    signal: AbortSignal.timeout(60000),
  });
  if (r.status === 404 || r.status === 410) return { expired: true };
  if (!r.ok && r.status !== 308)
    throw new Error("Google temporarily rejected the upload chunk.");
  await reportUpload(sessionId, deviceId, "uploading", end + 1);
  return { accepted: true, complete: r.ok };
}

// Only server-verified Google metadata can complete a browser recording.
export async function browserUpload(
  sessionId: string,
  deviceId: string,
  finish = false,
) {
  const queue = await browserUploadQueue(sessionId, deviceId, true);
  if (["complete", "uploaded"].includes(queue.state)) return { ready: true, queued: false, queue };
  if (!queue.allowed) return { ready: false, queued: true, queue };
  const db = recorderDatabase(),
    token = randomUUID();
  const claimed = await db
    .from("browser_recordings")
    .update({
      lease_token: token,
      lease_until: new Date(Date.now() + 60000).toISOString(),
    })
    .eq("session_id", sessionId)
    .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`)
    .select("*")
    .maybeSingle();
  if (claimed.error || !claimed.data)
    throw new Error("Upload is busy. Retry shortly.");
  const b = claimed.data;
  try {
    const s = await db
      .from("recording_sessions")
      .select("*")
      .eq("id", sessionId)
      .single();
    if (s.error || !b.file_id || !b.bytes)
      throw new Error("Save the recording before uploading.");
    if (s.data.status === "ready") {
      await reportUpload(sessionId, deviceId, "complete", Number(b.bytes));
      return { ready: true, queued: false, queue };
    }
    if (!["uploading", "sharing"].includes(s.data.status))
      throw new Error("Recording is not uploadable.");
    const { drive, integration } = await connectedDrive();
    if (b.root_id && b.root_id !== integration.root_folder_id)
      throw new Error("The owner's Drive configuration has changed.");
    b.root_id = integration.root_folder_id;
    await drive.privateFolder(b.root_id, integration.owner_email);
    if (!b.folder_id) {
      const day = localDay(
        s.data.started_at || s.data.created_at,
        s.data.configuration_snapshot.venue_time_zone || "Asia/Manila",
      );
      const candidate = await drive.newId();
      const saved = await db
        .from("drive_folders")
        .upsert(
          { root_id: b.root_id, day, drive_id: candidate },
          { onConflict: "root_id,day", ignoreDuplicates: true },
        );
      if (saved.error) throw saved.error;
      const f = await db
        .from("drive_folders")
        .select("drive_id")
        .eq("root_id", b.root_id)
        .eq("day", day)
        .single();
      if (f.error) throw f.error;
      b.folder_id = f.data.drive_id;
      await drive.createFolder(b.folder_id, b.root_id, day);
    }
    await drive.privateFolder(b.folder_id, integration.owner_email);
    if (!b.drive_id) b.drive_id = await drive.newId();
    const saved = await db
      .from("browser_recordings")
      .update({
        drive_id: b.drive_id,
        folder_id: b.folder_id,
        root_id: b.root_id,
      })
      .eq("session_id", sessionId)
      .eq("lease_token", token);
    if (saved.error) throw saved.error;
    let remote;
    try {
      remote = await drive.file(b.drive_id);
    } catch (e) {
      if (!(e instanceof DriveError) || e.code !== "drive_file_missing")
        throw e;
    }
    if (remote) {
      if (
        remote.trashed ||
        remote.mimeType !== b.mime_type ||
        Number(remote.size) !== Number(b.bytes) ||
        !remote.parents?.includes(b.folder_id)
      )
        throw new Error("Uploaded video did not match this recording.");
      const permission = await drive.shareLink(
        b.drive_id,
        integration.owner_email,
      );
      const result = await db.rpc("finish_browser_upload", {
        p_session: sessionId,
        p_permission: permission,
      });
      if (result.error || !result.data)
        throw new Error("Could not confirm upload.");
      await reportUpload(sessionId, deviceId, "complete", Number(b.bytes));
      return {
        ready: true,
        queued: false,
        queue: { ...queue, state: "uploaded", percent: 100 },
      };
    }
    if (finish)
      throw new Error(
        "Upload is not complete yet. Retry uploading from the tablet.",
      );
    if (!b.upload_uri_encrypted) {
      let courtName = String(
        s.data.configuration_snapshot?.court_name || "",
      ).trim();
      if (s.data.court_id) {
        const court = await db
          .from("courts")
          .select("name")
          .eq("id", s.data.court_id)
          .maybeSingle();
        if (court.error)
          throw new Error("Could not identify the recording court.");
        courtName = court.data?.name || courtName;
      }
      if (!courtName)
        throw new Error("Could not identify the recording court.");
      const extension = b.mime_type === "video/webm" ? "webm" : "mp4";
      const uri = await drive.beginUpload(
        b.drive_id,
        b.folder_id,
        recordingFileName(
          s.data.started_at || s.data.created_at,
          s.data.configuration_snapshot.venue_time_zone || "Asia/Manila",
          courtName,
          s.data.recipient_email,
          extension,
        ),
        Number(b.bytes),
        b.mime_type,
      );
      const r = await db
        .from("browser_recordings")
        .update({ upload_uri_encrypted: encryptSecret(uri) })
        .eq("session_id", sessionId)
        .eq("lease_token", token);
      if (r.error) throw r.error;
      return { ready: false, queued: false, queue };
    }
    return { ready: false, queued: false, queue };
  } finally {
    await db
      .from("browser_recordings")
      .update({ lease_until: null })
      .eq("session_id", sessionId)
      .eq("lease_token", token);
  }
}
