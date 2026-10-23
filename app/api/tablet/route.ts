import { browserTablet, canSetup, publicTablet } from "@/lib/browser-tablets";
import { recorderDatabase } from "@/lib/recorder-server";
import { json, readBody, sameOrigin } from "@/lib/http";
import { uuid, InputError } from "@/lib/validation";
import {
  browserUpload,
  browserUploadQueue,
  browserUploadStatus,
} from "@/lib/browser-upload";
import { after } from "next/server";
import { deliverNextEmail } from "@/lib/email-server";
import {
  cameraTransform,
  validCameraTransform,
} from "@/lib/camera-transform";
import { normalizeRecipients } from "@/lib/team-recipients";
import { venueStateError } from "@/lib/venue-errors";
export const maxDuration = 60;
const activeCaptureStatuses = [
  "requested",
  "starting",
  "recording",
  "finalizing",
];
type EnrolledBrowserTablet = NonNullable<
  Awaited<ReturnType<typeof browserTablet>>
>;
export async function browserTabletState(
  t: EnrolledBrowserTablet,
  includeSetupAccess = false,
) {
  const db = recorderDatabase();
    const [court, settings, session, queue] = await Promise.all([
      db
        .from("courts")
        .select("id,name,active")
        .eq("id", t.device.court_id || "00000000-0000-0000-0000-000000000000")
        .maybeSingle(),
      db
        .from("venue_settings")
        .select("max_duration_seconds")
        .eq("id", true)
        .single(),
      t.kiosk.current_session_id
        ? db
            .from("recording_sessions")
            .select(
              "id,court_id,status,started_at,duration_seconds,stop_requested_at,failure_stage,recording_files(id,email_jobs(status))",
            )
            .eq("id", t.kiosk.current_session_id)
            .eq("kiosk_id", t.kiosk.id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      db
        .from("browser_recordings")
        .select("session_id,job_id,upload_state,uploaded_bytes,bytes,retry_count,last_error,client_created_at,duration_ms,local_available,recording_sessions(court_id,status,created_at)")
        .eq("device_id", t.device.id)
        .order("client_created_at", { ascending: false })
        .limit(100),
    ]);
    if (court.error || settings.error || session.error || queue.error)
      throw court.error || settings.error || session.error || queue.error;
    const s = session.data as any;
    const mail = s?.recording_files?.[0]?.email_jobs;
    const uploadQueue =
      s && ["uploading", "sharing"].includes(s.status)
        ? await browserUploadQueue(s.id, t.device.id)
        : null;
    return json({
      enabled: true,
      browser: true,
      device: publicTablet(t.device),
      canSetup: includeSetupAccess ? await canSetup(t.device) : false,
      maxSeconds: settings.data.max_duration_seconds,
      courts: court.data
        ? [
            {
              ...court.data,
              camera_status:
                court.data.active && t.device.tested_at ? "online" : "offline",
              audio_enabled: !!t.device.audio_device,
            },
          ]
        : [],
      session: s
        ? {
            ...s,
            recording_files: undefined,
            email_status:
              (Array.isArray(mail) ? mail[0]?.status : mail?.status) ||
              "pending",
          }
        : null,
      uploadQueue,
      queue: queue.data || [],
    });
}
export async function GET(request: Request) {
  try {
    const t = await browserTablet();
    if (!t) return json({ enabled: false });
    return await browserTabletState(
      t,
      new URL(request.url).searchParams.get("setup") === "1",
    );
  } catch (error) {
    console.error("Tablet state unavailable", { code: (error as {code?: string})?.code || "unexpected" });
    return json({ error: venueStateError(error, "Tablet connection unavailable. Please retry.") }, 503);
  }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    const t = await browserTablet();
    if (!t) return json({ error: "Enroll this browser first." }, 401);
    const b = await readBody(request),
      db = recorderDatabase();
    if (b.action === "heartbeat") {
      await db
        .from("browser_devices")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", t.device.id);
      if (t.kiosk.current_session_id) {
        const current = await db
          .from("recording_sessions")
          .select("status")
          .eq("id", t.kiosk.current_session_id)
          .eq("kiosk_id", t.kiosk.id)
          .maybeSingle();
        if (current.error) throw current.error;
        if (current.data && activeCaptureStatuses.includes(current.data.status))
          await db.rpc("browser_event", {
            p_kiosk: t.kiosk.id,
            p_session: t.kiosk.current_session_id,
            p_action: "heartbeat",
          });
        else {
          const released = await db
            .from("kiosk_devices")
            .update({ current_session_id: null })
            .eq("id", t.kiosk.id)
            .eq("current_session_id", t.kiosk.current_session_id);
          if (released.error) throw released.error;
        }
      }
      return json({ ok: true });
    }
    if (b.action === "configure" || b.action === "tested") {
      if (t.device.recorder_mode === "android_rtsp")
        return json(
          { error: "Camera settings are managed in Device setup in the Android recorder." },
          403,
        );
      if (!(await canSetup(t.device)))
        return json(
          {
            error:
              "Admin setup permission expired. Sign in as admin on this tablet.",
          },
          403,
        );
      const current = t.kiosk.current_session_id
        ? await db
            .from("recording_sessions")
            .select("status")
            .eq("id", t.kiosk.current_session_id)
            .single()
        : null;
      if (
        current?.data &&
        activeCaptureStatuses.includes(current.data.status)
      )
        return json(
          { error: "Finish the recording before changing camera settings." },
          409,
        );
      if (b.action === "tested") {
        const r = await db
          .from("browser_devices")
          .update({
            tested_at: b.passed ? new Date().toISOString() : null,
            diagnostic: b.passed
              ? "Video/audio recording test passed."
              : "Camera test failed. Check permissions and connection.",
            test_requested: false,
          })
          .eq("id", t.device.id);
        if (r.error) throw r.error;
      } else {
        const source = String(b.source_type),
          video = String(b.video_device || ""),
          audio = String(b.audio_device || "");
        if (
          source !== "local" ||
          video.length > 512 ||
          audio.length > 512 ||
          !validCameraTransform(b)
        )
          throw new InputError("Invalid camera configuration.");
        if (!video)
          throw new InputError("Choose a camera detected by this browser.");
        const transform = cameraTransform(b);
        const r = await db
          .from("browser_devices")
          .update({
            source_type: "local",
            video_device: video,
            audio_device: audio,
            stream_url: "",
            camera_name: String(b.camera_name || "Camera").slice(0, 100),
            ...transform,
            tested_at: null,
          })
          .eq("id", t.device.id);
        if (r.error)
          throw new Error(
            r.error.code === "42703" || r.error.code === "PGRST204"
              ? "Camera setup is waiting for the latest database migration. Ask the administrator to update it."
              : "Camera settings could not be saved. Please retry.",
          );
      }
      return json({ ok: true });
    }
    if (b.action === "start") {
      const key = uuid(b.key),
        emails = normalizeRecipients(b.emails, b.email);
      if (!emails)
        throw new InputError(
          "Enter at least one valid email address on either team.",
        );
      const r = await db.rpc("browser_start", {
        p_kiosk: t.kiosk.id,
        p_email: emails[0],
        p_key: key,
        p_revision: b.revision ? uuid(b.revision) : null,
        p_recipients: emails,
      });
      if (r.error)
        return json(
          {
            error:
              r.error.code === "P0001"
                ? r.error.message
                : "This court is unavailable.",
          },
          409,
        );
      return json({ id: r.data });
    }
    const id = uuid(b.id);
    const owned = await db
      .from("browser_recordings")
      .select("session_id")
      .eq("session_id", id)
      .eq("device_id", t.device.id)
      .maybeSingle();
    if (owned.error || !owned.data)
      return json(
        { error: "This recording does not belong to this tablet." },
        403,
      );
    if (b.action === "queue-report") {
      const status = String(b.status || "");
      if (!["saved_locally", "pending", "uploading", "retrying", "uploaded", "failed"].includes(status))
        throw new InputError("Invalid local queue status.");
      const progress = Number(b.progress || 0), retries = Number(b.retry_count || 0);
      if (!Number.isInteger(progress) || progress < 0 || progress > 100 || !Number.isInteger(retries) || retries < 0 || retries > 100)
        throw new InputError("Invalid local queue report.");
      const brandingState =
        b.branding_state === undefined
          ? undefined
          : b.branding_state === null || b.branding_state === ""
            ? null
            : String(b.branding_state);
      if (brandingState !== undefined && brandingState !== null &&
        !["processing", "complete", "failed"].includes(brandingState))
        throw new InputError("Invalid logo status.");
      const updated = await db.from("browser_recordings").update({
        upload_state: status,
        uploaded_bytes: b.bytes ? Math.min(Number(b.bytes), Math.max(0, Number(b.uploaded_bytes || 0))) : 0,
        retry_count: retries,
        last_error: b.last_error ? String(b.last_error).slice(0, 300) : null,
        local_available: b.local_available !== false,
        client_created_at: b.created_at ? new Date(Number(b.created_at)).toISOString() : undefined,
        duration_ms: b.duration_ms == null ? null : Number(b.duration_ms),
        upload_updated_at: new Date().toISOString(),
        ...(brandingState === undefined
          ? {}
          : { branding_state: brandingState, branding_updated_at: new Date().toISOString() }),
      }).eq("session_id", id).eq("device_id", t.device.id);
      if (updated.error) throw updated.error;
      return json({ ok: true });
    }
    if (b.action === "upload-status")
      return json(await browserUploadStatus(id, t.device.id));
    if (b.action === "upload-failed") {
      const retries = Number(b.retry_count || 0);
      if (!Number.isInteger(retries) || retries < 0 || retries > 100)
        throw new InputError("Invalid upload retry count.");
      if (b.validation_failed === true) {
        // Reuse the guarded capture transition to release a pre-upload session.
        // It cannot downgrade an uploading or completed recording on a late report.
        const validation = await db.rpc("browser_event", {
          p_kiosk: t.kiosk.id,
          p_session: id,
          p_action: "failed",
        });
        if (validation.error) throw validation.error;
      }
      const failed = await db.rpc("report_browser_upload", {
        p_session: id,
        p_device: t.device.id,
        p_state: "failed",
        p_uploaded_bytes: 0,
      });
      if (failed.error || !failed.data)
        return json({ error: "Upload queue state changed. Refresh and retry." }, 409);
      const updated = await db.from("browser_recordings").update({
        ...(b.retrying === true && b.validation_failed !== true ? { upload_state: "retrying" } : {}),
        ...(b.branding_state === undefined
          ? {}
          : {
              branding_state: ["processing", "complete", "failed"].includes(
                String(b.branding_state),
              )
                ? String(b.branding_state)
                : null,
              branding_updated_at: new Date().toISOString(),
            }),
        retry_count: retries,
        last_error: b.last_error
          ? String(b.last_error).slice(0, 300)
          : "Upload paused on this device.",
        safe_error: b.validation_failed === true
          ? "Video validation failed. Check the saved video on the original device."
          : b.retrying === true
          ? "Connection interrupted. Automatic retry scheduled."
          : "Upload paused on this device.",
      }).eq("session_id", id).eq("device_id", t.device.id).eq("upload_state", "failed");
      if (updated.error) throw updated.error;
      return json({ ok: true });
    }
    if (
      ["upload", "finish", "restart-upload", "retry-upload"].includes(
        String(b.action),
      )
    ) {
      if (b.action === "retry-upload") {
        const retried = await db.rpc("retry_browser_upload", {
          p_session: id,
          p_device: t.device.id,
        });
        if (retried.error || !retried.data)
          return json(
            { error: "This cancelled upload could not be retried." },
            409,
          );
      }
      if (b.action === "restart-upload") {
        await db
          .from("browser_recordings")
          .update({ upload_uri_encrypted: null })
          .eq("session_id", id)
          .or(`lease_until.is.null,lease_until.lt.${new Date().toISOString()}`);
      }
      const r = await browserUpload(
        id,
        t.device.id,
        b.action === "finish",
      );
      if (r.ready)
        after(async () => {
          await deliverNextEmail();
        });
      return json(r);
    }
    if (
      !["started", "stopped", "captured", "saved", "failed", "reset"].includes(
        String(b.action),
      )
    )
      throw new InputError("Unknown action.");
    const durationMs = b.action === "saved" && b.duration_ms != null
      ? Number(b.duration_ms)
      : null;
    if (durationMs !== null &&
      (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 7200000))
      throw new InputError("Invalid recording duration.");
    const r = await db.rpc("browser_event", {
      p_kiosk: t.kiosk.id,
      p_session: id,
      p_action: b.action,
      p_bytes: b.bytes ?? null,
      p_mime: b.mime ?? null,
    });
    if (r.error) throw r.error;
    if (b.action === "saved" && b.branding_state !== undefined) {
      const brandingState = String(b.branding_state);
      if (!["processing", "complete", "failed"].includes(brandingState))
        throw new InputError("Invalid logo status.");
      const branded = await db
        .from("browser_recordings")
        .update({
          branding_state: brandingState,
          branding_updated_at: new Date().toISOString(),
        })
        .eq("session_id", id)
        .eq("device_id", t.device.id);
      if (branded.error) throw branded.error;
    }
    if (b.action === "saved") {
      const localOnly = await db.rpc("hold_short_browser_recording", {
        p_session: id,
        p_device: t.device.id,
        p_duration_ms: durationMs,
      });
      if (localOnly.error) throw localOnly.error;
      if (localOnly.data)
        return json({
          ok: true,
          localOnly: true,
          reason: "under_one_minute",
        });
      const unsupported = await db.rpc("hold_unsupported_browser_recording", {
        p_session: id,
        p_device: t.device.id,
      });
      if (unsupported.error) throw unsupported.error;
      if (unsupported.data)
        return json({
          ok: true,
          localOnly: true,
          reason: "unsupported_format",
        });
      const queued = await db.rpc("queue_browser_upload", {
        p_session: id,
        p_device: t.device.id,
      });
      if (queued.error || !queued.data)
        throw new Error("Could not add this saved video to the upload queue.");
    }
    if (!r.data) {
      const current = await db
        .from("recording_sessions")
        .select("status")
        .eq("id", id)
        .eq("kiosk_id", t.kiosk.id)
        .maybeSingle();
      if (current.error) throw current.error;
      const currentStatus = current.data?.status;
      let alreadyApplied =
        (b.action === "failed" && currentStatus === "failed") ||
        (b.action === "stopped" &&
          ["finalizing", "uploading", "sharing", "ready"].includes(
            currentStatus || "",
          )) ||
        (b.action === "captured" &&
          ["uploading", "sharing", "ready"].includes(currentStatus || "")) ||
        (b.action === "started" &&
          ["recording", "finalizing", "uploading", "sharing", "ready"].includes(
            currentStatus || "",
          ));
      if (
        b.action === "saved" &&
        ["uploading", "sharing", "ready"].includes(currentStatus || "")
      ) {
        const recording = await db
          .from("browser_recordings")
          .select("file_id,bytes,mime_type")
          .eq("session_id", id)
          .maybeSingle();
        if (recording.error) throw recording.error;
        alreadyApplied =
          !!recording.data?.file_id &&
          Number(recording.data.bytes) === Number(b.bytes) &&
          recording.data.mime_type === b.mime;
      }
      if (alreadyApplied) return json({ ok: true });
      return json(
        {
          error: "Recording status changed. The tablet is syncing now.",
          code: "recording_state_changed",
        },
        409,
      );
    }
    return json({ ok: true });
  } catch (e) {
    return json(
      {
        error:
          e instanceof InputError
            ? e.message
            : e instanceof Error && !("code" in e)
              ? e.message
              : "Recording request failed. Please retry.",
      },
      503,
    );
  }
}
