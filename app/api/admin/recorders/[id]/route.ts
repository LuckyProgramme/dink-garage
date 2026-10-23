import { randomBytes } from "node:crypto";
import { getAccount } from "@/lib/auth";
import { recorderDatabase } from "@/lib/recorder-server";
import { tokenHash } from "@/lib/recorder-protocol";
import { json, readBody, sameOrigin } from "@/lib/http";
import { InputError, text, uuid } from "@/lib/validation";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  if (!sameOrigin(request))
    return json({ error: "Request origin is not allowed." }, 403);
  try {
    const { account } = await getAccount();
    if (!account) return json({ error: "Please sign in." }, 401);
    if (account.role !== "admin")
      return json({ error: "Administrator access required." }, 403);
    const id = uuid((await context.params).id);
    const body = await readBody(request);
    const db = recorderDatabase();
    const recorder = await db
      .from("recorders")
      .select("id,paired_at")
      .eq("id", id)
      .maybeSingle();
    if (!recorder.data) return json({ error: "Recorder not found." }, 404);
    if (body.action === "pair") {
      const code = `cbpair_${randomBytes(32).toString("base64url")}`;
      const expires = new Date(Date.now() + 600000).toISOString();
      const result = await db.rpc("issue_recorder_pair", {
        p_recorder_id: id,
        p_hash: tokenHash(code),
        p_expires: expires,
      });
      if (result.error) throw result.error;
      return json({ code, expires });
    }
    if (body.action === "revoke") {
      const result = await db.rpc("revoke_recorder", {
        p_recorder_id: id,
        p_actor_id: account.id,
      });
      if (result.error) throw result.error;
      return json({ ok: true });
    }
    if (body.action !== "discover" && body.action !== "test")
      throw new InputError("Unknown action.");
    if (!recorder.data.paired_at)
      throw new InputError("Pair the recorder first.");
    const reference =
      body.action === "test"
        ? text(body.device_reference, "Device reference", 120)
        : "";
    if (reference) {
      const device = await db
        .from("recorder_devices")
        .select("id")
        .eq("recorder_id", id)
        .eq("device_reference", reference)
        .maybeSingle();
      if (!device.data)
        throw new InputError("Discover this device before testing it.");
    }
    const expired = await db
      .from("recorder_commands")
      .update({
        status: "failed",
        result_code: "expired",
        finished_at: new Date().toISOString(),
      })
      .eq("recorder_id", id)
      .in("status", ["pending", "running"])
      .lt("created_at", new Date(Date.now() - 600000).toISOString());
    if (expired.error) throw expired.error;
    const result = await db
      .from("recorder_commands")
      .insert({
        recorder_id: id,
        kind: body.action,
        device_reference: reference,
        requested_by: account.id,
      });
    if (result.error?.code === "23505")
      return json({ ok: true, message: "This check is already queued." });
    if (result.error) throw result.error;
    return json({
      ok: true,
      message: "Queued. The venue recorder will run this check when connected.",
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "Recorder action failed. Please retry.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}
