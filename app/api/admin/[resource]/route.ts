import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import { recorderDatabase } from "@/lib/recorder-server";
import { json, sameOrigin, readBody } from "@/lib/http";
import {
  bool,
  cameraInput,
  InputError,
  settingsInput,
  text,
  uuid,
} from "@/lib/validation";

export async function POST(
  request: Request,
  context: { params: Promise<{ resource: string }> },
) {
  if (!sameOrigin(request))
    return json({ error: "Request origin is not allowed." }, 403);
  try {
    const { account } = await getAccount();
    if (!account) return json({ error: "Please sign in again." }, 401);
    if (account.role !== "admin")
      return json({ error: "Administrator access is required." }, 403);
    const { resource } = await context.params;
    if (!["courts", "cameras", "recorders", "settings"].includes(resource))
      return json({ error: "Not found." }, 404);
    const body = await readBody(request);
    const db = await serverSupabase();
    let result;
    if (resource === "settings") {
      result = await db
        .from("venue_settings")
        .update(settingsInput(body))
        .eq("id", true)
        .select("id")
        .single();
    } else {
      let values: Record<string, unknown>;
      if (resource === "courts") {
        if (typeof body.location !== "string")
          throw new InputError("Enter a location or description.");
        if (body.location.trim().length > 150)
          throw new InputError("Location must be 150 characters or less.");
        values = {
          name: text(body.name, "Court name"),
          location: body.location.trim(),
          active: bool(body.active),
        };
      } else if (resource === "cameras") values = cameraInput(body);
      else values = { name: text(body.name, "Recorder name") };
      result = body.id
        ? await db
            .from(resource)
            .update(values)
            .eq("id", uuid(body.id))
            .select("id")
            .single()
        : await db.from(resource).insert(values).select("id").single();
    }
    if (result.error) {
      const code = result.error.code;
      const detail = result.error.message || "";
      console.error(`Admin ${resource} save failed`, {
        code,
        message: detail,
        details: result.error.details,
        hint: result.error.hint,
      });
      let message: string;
      if (code === "23505")
        message =
          resource === "courts"
            ? "A court with this name already exists in this venue."
            : "That name or device already exists, or the court already has a primary camera. Edit the existing entry first.";
      else if (code === "23514")
        message =
          "This change is invalid or a recording is active. Check the settings and try again.";
      else if (code === "23503")
        message = "The selected court or recorder no longer exists.";
      else if (code === "23502")
        message =
          "Some required information is missing. Check the form and try again.";
      else if (code === "42501")
        message =
          "Your account does not have permission to make this change. Check that your venue administrator access is active.";
      else if (code === "P0001")
        message = /court limit/i.test(detail)
          ? "This venue has reached its court limit. Remove an unused court or ask a system administrator to raise the limit."
          : /location unavailable/i.test(detail)
            ? "That location is unavailable. Choose an active location or use a new description."
            : /tenant unavailable/i.test(detail)
              ? "This venue is not available. Contact a system administrator."
              : "This change is not allowed by the current venue rules.";
      else if (
        ["PGRST202", "PGRST204", "PGRST205", "42P01", "42703"].includes(
          code || "",
        )
      )
        message =
          "Venue configuration needs a database update. Ask a system administrator to apply the latest migration.";
      else message = "Could not save this change. Please try again.";
      return json({ error: message }, 400);
    }
    return json({ ok: true, id: result.data.id });
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "The service is temporarily unavailable.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ resource: string }> },
) {
  if (!sameOrigin(request))
    return json({ error: "Request origin is not allowed." }, 403);
  try {
    const { account } = await getAccount();
    if (!account) return json({ error: "Please sign in again." }, 401);
    if (account.role !== "admin")
      return json({ error: "Administrator access is required." }, 403);
    const { resource } = await context.params;
    if (resource !== "courts") return json({ error: "Not found." }, 404);
    const body = await readBody(request);
    const id = uuid(body.id);
    const db = await serverSupabase();
    const court = await db
      .from("courts")
      .select("id,name")
      .eq("id", id)
      .maybeSingle();
    if (court.error) throw court.error;
    if (!court.data) return json({ error: "This court no longer exists." }, 404);
    const removed = await db.from("courts").delete().eq("id", id);
    if (removed.error) {
      return json(
        {
          error:
            removed.error.code === "P0001"
              ? removed.error.message
              : removed.error.code === "23503"
                ? "Apply the latest database migration before removing courts."
                : "Could not permanently remove this court.",
        },
        409,
      );
    }
    await recorderDatabase().from("audit_events").insert({
      actor_id: account.id,
      action: "court.removed",
      safe_detail: { court_id: id, court_name: court.data.name },
    });
    return json({ ok: true, removed: true });
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "The service is temporarily unavailable.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}
