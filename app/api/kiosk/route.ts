import { kioskDevice } from "@/lib/kiosk";
import { recorderDatabase } from "@/lib/recorder-server";
import { json, readBody, sameOrigin } from "@/lib/http";
import { uuid, InputError } from "@/lib/validation";
import { checkDriveHealth } from "@/lib/google-server";
import { browserTablet } from "@/lib/browser-tablets";
import { browserTabletState, POST as browserAction } from "../tablet/route";
import { normalizeRecipients } from "@/lib/team-recipients";
import { venueStateError } from "@/lib/venue-errors";
export async function GET() {
  try {
    const tablet = await browserTablet();
    if (tablet) return await browserTabletState(tablet);
    const kiosk = await kioskDevice();
    if (!kiosk) return json({ enabled: false });
    const db = recorderDatabase();
    const [courts, settings, session] = await Promise.all([
      db.rpc("kiosk_court_status"),
      db
        .from("venue_settings")
        .select("max_duration_seconds")
        .eq("id", true)
        .single(),
      kiosk.current_session_id
        ? db
            .from("recording_sessions")
            .select(
              "id,court_id,status,started_at,duration_seconds,stop_requested_at,failure_stage,recording_files(id)",
            )
            .eq("id", kiosk.current_session_id)
            .eq("kiosk_id", kiosk.id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    if (courts.error || settings.error || session.error)
      throw courts.error || settings.error || session.error;
    const file = session.data?.recording_files?.[0];
    const mail = file
      ? await db
          .from("email_jobs")
          .select("status")
          .eq("file_id", file.id)
          .maybeSingle()
      : null;
    return json({
      enabled: true,
      courts: courts.data,
      maxSeconds: settings.data.max_duration_seconds,
      session: session.data
        ? {
            ...session.data,
            recording_files: undefined,
            email_status: mail?.data?.status || "pending",
          }
        : null,
    });
  } catch (error) {
    console.error("Venue state unavailable", { code: (error as {code?: string})?.code || "unexpected" });
    return json({ error: venueStateError(error, "Cannot reach the venue. Please retry.") }, 503);
  }
}
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    if (await browserTablet()) return browserAction(request);
    const kiosk = await kioskDevice();
    if (!kiosk)
      return json(
        { error: "Ask the administrator to enable this tablet." },
        401,
      );
    const body = await readBody(request),
      db = recorderDatabase();
    if (body.action === "start") {
      const key = uuid(body.key),
        court = uuid(body.court_id);
      const emails = normalizeRecipients(body.emails, body.email);
      if (!emails)
        throw new InputError(
          "Enter at least one valid email address on either team.",
        );
      const existing = await db
        .from("recording_sessions")
        .select("id")
        .eq("kiosk_id", kiosk.id)
        .eq("idempotency_key", key)
        .maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) return json({ id: existing.data.id });
      const health = await checkDriveHealth();
      if (!health.ready)
        return json(
          {
            error:
              "Google Drive needs attention. Please ask the administrator before recording.",
          },
          503,
        );
      const google = await db
        .from("google_integration")
        .select("gmail_authorized_at")
        .maybeSingle();
      if (google.error || !google.data?.gmail_authorized_at)
        return json(
          {
            error: "Email delivery needs to be connected by the administrator.",
          },
          503,
        );
      const result = await db.rpc("start_guest_capture", {
        p_kiosk: kiosk.id,
        p_email: emails[0],
        p_court: court,
        p_key: key,
        p_recipients: emails,
      });
      if (result.error)
        return json(
          {
            error:
              result.error.code === "P0001"
                ? result.error.message
                : "Court unavailable. Please retry.",
          },
          409,
        );
      return json({ id: result.data });
    }
    if (body.action === "stop" || body.action === "reset") {
      const result = await db.rpc("kiosk_session_action", {
        p_kiosk: kiosk.id,
        p_session: uuid(body.id),
        p_reset: body.action === "reset",
      });
      if (result.error) throw result.error;
      return result.data
        ? json({ ok: true })
        : json(
            { error: "This session is unavailable or still recording." },
            409,
          );
    }
    throw new InputError("Unknown action.");
  } catch (e) {
    return json(
      {
        error:
          e instanceof InputError ? e.message : "Request failed. Please retry.",
      },
      e instanceof InputError ? 400 : 503,
    );
  }
}
