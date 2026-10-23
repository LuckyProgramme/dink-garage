import { randomBytes } from "node:crypto";
import { getAccount } from "@/lib/auth";
import { recorderDatabase } from "@/lib/recorder-server";
import { hashKiosk } from "@/lib/kiosk";
import { json, readBody, sameOrigin } from "@/lib/http";
import { uuid, InputError } from "@/lib/validation";
import { publicTablet } from "@/lib/browser-tablets";
export async function GET() {
  if ((await getAccount()).account?.role !== "admin")
    return json({ error: "Admin sign-in required." }, 403);
  const db = recorderDatabase();
  const [devices, courts, recordings, worker] = await Promise.all([
    db.from("browser_devices").select("*").order("created_at"),
    db.from("courts").select("id,name,active").order("created_at"),
    db
      .from("browser_recordings")
      .select(
        "session_id,device_id,job_id,safe_error,last_error,upload_state,uploaded_bytes,bytes,upload_queued_at,upload_updated_at,branding_state,branding_updated_at,client_created_at,duration_ms,retry_count,local_available,recording_sessions(id,court_id,status,created_at,failure_stage,recording_files(id,status,drive_file_id,email_jobs(status,safe_error)))",
      )
      .order("last_seen_at", { ascending: false })
      .limit(100),
    db
      .from("venue_settings")
      .select("browser_worker_at")
      .eq("id", true)
      .single(),
  ]);
  if (devices.error || courts.error || recordings.error)
    return json(
      { error: "Tablet setup needs the latest database migration." },
      503,
    );
  return json({
    devices: devices.data.map(publicTablet),
    courts: courts.data,
    recordings: recordings.data,
    workerAt: worker.data?.browser_worker_at,
  });
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  const { account } = await getAccount();
  if (account?.role !== "admin")
    return json({ error: "Admin sign-in required." }, 403);
  try {
    const b = await readBody(request),
      db = recorderDatabase();
    const id = b.id ? uuid(b.id) : null;
    if (b.action === "cancel-upload" && id) {
      const sessionId = uuid(b.session_id);
      const cancelled = await db.rpc("cancel_browser_upload", {
        p_session: sessionId,
        p_device: id,
      });
      if (cancelled.error) throw cancelled.error;
      if (!cancelled.data)
        return json(
          { error: "This upload is no longer waiting or uploading." },
          409,
        );
      const audit = await db.from("audit_events").insert({
        actor_id: account.id,
        session_id: sessionId,
        action: "tablet.upload_cancelled",
        safe_detail: { device_id: id },
      });
      if (audit.error) throw audit.error;
      return json({ ok: true, cancelled: true });
    }
    if (b.action === "retry-upload" && id) {
      const sessionId = uuid(b.session_id);
      const retried = await db.rpc("retry_browser_upload", {
        p_session: sessionId,
        p_device: id,
      });
      if (retried.error) throw retried.error;
      if (!retried.data)
        return json(
          { error: "This saved upload is no longer available to continue." },
          409,
        );
      const audit = await db.from("audit_events").insert({
        actor_id: account.id,
        session_id: sessionId,
        action: "tablet.upload_retry_requested",
        safe_detail: { device_id: id },
      });
      if (audit.error) throw audit.error;
      return json({ ok: true, retryRequested: true });
    }
    if (b.action === "remove" && id) {
      if (b.confirm !== true)
        throw new InputError("Confirm permanent device deletion.");
      const removed = await db.rpc("remove_browser_device", {
        p_device: id,
        p_actor: account.id,
      });
      if (removed.error) throw removed.error;
      if (!removed.data) return json({ error: "Device no longer exists." }, 404);
      return json({ ok: true, removed: true });
    }
    if (id) {
      const pending = await db
        .from("browser_recordings")
        .select("session_id,recording_sessions!inner(status)")
        .eq("device_id", id)
        .in("recording_sessions.status", [
          "requested",
          "starting",
          "recording",
          "finalizing",
        ])
        .limit(1);
      if (pending.error) throw pending.error;
      if (pending.data?.length)
        return json(
          {
            error:
              "Finish the active recording before changing this device.",
          },
          409,
        );
    }
    if (b.action === "test" && id) {
      const r = await db
        .from("browser_devices")
        .update({ test_requested: true, tested_at: null })
        .eq("id", id);
      if (r.error) throw r.error;
      return json({ ok: true });
    }
    if (b.action === "disable" && id) {
      const r = await db
        .from("browser_devices")
        .update({
          enabled: false,
          enrollment_hash: null,
          setup_hash: null,
          tested_at: null,
        })
        .eq("id", id)
        .select("kiosk_id")
        .single();
      if (r.error) throw r.error;
      if (r.data.kiosk_id)
        await db
          .from("kiosk_devices")
          .update({ active: false })
          .eq("id", r.data.kiosk_id);
      return json({ ok: true });
    }
    if (b.action !== "save" && b.action !== "enroll")
      throw new InputError("Unknown action.");
    const name = String(b.name || "").trim();
    if (!name || name.length > 100)
      throw new InputError("Enter a tablet name (up to 100 characters).");
    const court = b.court_id ? uuid(b.court_id) : null;
    const code = randomBytes(18).toString("base64url");
    const fields = {
      name,
      court_id: court,
      ...(b.action === "enroll" || !id
        ? {
            enrollment_hash: hashKiosk(code),
            enrollment_expires_at: new Date(Date.now() + 600000).toISOString(),
            enabled: true,
          }
        : {}),
    };
    const r = id
      ? await db
          .from("browser_devices")
          .update(fields)
          .eq("id", id)
          .select("id")
          .single()
      : await db.from("browser_devices").insert(fields).select("id").single();
    if (r.error) throw r.error;
    // The enrolling endpoint derives the administrator from this server-created record.
    if (b.action === "enroll" || !id) {
      const record = await db.from("audit_events").insert({
        actor_id: account.id,
        action: "tablet.enrollment_created",
        safe_detail: { device_id: r.data.id },
      });
      if (record.error) throw record.error;
    }
    return json({
      ok: true,
      id: r.data.id,
      ...(b.action === "enroll" || !id ? { code } : {}),
    });
  } catch (e) {
    return json(
      {
        error:
          e instanceof InputError
            ? e.message
            : "Tablet setup could not be saved.",
      },
      400,
    );
  }
}
