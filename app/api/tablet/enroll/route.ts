import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { json, readBody, sameOrigin } from "@/lib/http";
import { hashKiosk, kioskCookie, kioskDevice } from "@/lib/kiosk";
import { recorderDatabase } from "@/lib/recorder-server";
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "Invalid origin." }, 403);
  try {
    const b = await readBody(request),
      code = String(b.code || "").trim();
    if (!/^[A-Za-z0-9_-]{24}$/.test(code))
      return json(
        { error: "Enter the full enrollment code from your administrator." },
        400,
      );
    const db = recorderDatabase();
    const old = await kioskDevice();
    if (old) {
      const existing = await db
        .from("browser_devices")
        .select("id")
        .eq("kiosk_id", old.id)
        .maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data && b.replace !== true)
        return json(
          {
            error:
              "This browser is already registered. Choose Re-enroll device to replace its current registration.",
          },
          409,
        );
      if (old.current_session_id) {
        const session = await db
          .from("recording_sessions")
          .select("status")
          .eq("id", old.current_session_id)
          .single();
        if (
          session.error ||
          ["requested", "starting", "recording", "finalizing"].includes(
            session.data.status,
          )
        )
          return json(
            { error: "Finish the current recording before enrolling." },
            409,
          );
      }
    }
    const d = await db
      .from("browser_devices")
      .select("id")
      .eq("enrollment_hash", hashKiosk(code))
      .maybeSingle();
    if (!d.data)
      return json({ error: "Enrollment code is invalid or expired." }, 400);
    const audit = await db
      .from("audit_events")
      .select("actor_id")
      .eq("action", "tablet.enrollment_created")
      .contains("safe_detail", { device_id: d.data.id })
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (!audit.data?.actor_id) throw new Error();
    const token = randomBytes(32).toString("base64url"),
      setup = randomBytes(32).toString("base64url");
    const r = await db.rpc("enroll_browser", {
      p_hash: hashKiosk(code),
      p_token: hashKiosk(token),
      p_setup: hashKiosk(setup),
      p_admin: audit.data.actor_id,
    });
    if (r.error)
      return json(
        {
          error:
            "Code expired, already used, or this tablet has an unfinished recording.",
        },
        409,
      );
    if (old)
      await db.from("kiosk_devices").update({ active: false }).eq("id", old.id);
    const store = await cookies(),
      options = {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict" as const,
        path: "/",
      };
    store.set(kioskCookie, token, { ...options, maxAge: 180 * 86400 });
    store.set("cb-tablet-setup", setup, { ...options, maxAge: 900 });
    return json({ ok: true });
  } catch {
    return json({ error: "Could not enroll. Please retry." }, 503);
  }
}
