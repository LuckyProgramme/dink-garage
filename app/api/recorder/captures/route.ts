import { authenticateRecorder } from "@/lib/recorder-server";
import { json, readBody } from "@/lib/http";
import { uuid, InputError } from "@/lib/validation";
export async function POST(request: Request) {
  try {
    const auth = await authenticateRecorder(request);
    if (!auth)
      return json({ error: "Recorder token is invalid or revoked." }, 401);
    const body = await readBody(request);
    if (body.action === "sync") {
      const result = await auth.db.rpc("sync_captures", {
        p_recorder: auth.recorderId,
      });
      if (result.error) throw result.error;
      return json({ jobs: result.data });
    }
    if (
      body.action !== "report" ||
      !["recording", "finalizing", "local_ready", "failed"].includes(
        String(body.state),
      ) ||
      ![
        "running",
        "player_stop",
        "time_limit",
        "interrupted",
        "capture_error",
        "storage_full",
        "device_missing",
      ].includes(String(body.reason)) ||
      !Number.isSafeInteger(body.bytes) ||
      Number(body.bytes) < 0
    )
      throw new InputError("Invalid capture report.");
    const result = await auth.db.rpc("report_capture", {
      p_recorder: auth.recorderId,
      p_session: uuid(body.id),
      p_token: uuid(body.token),
      p_state: body.state,
      p_reason: body.reason,
      p_bytes: body.bytes,
    });
    if (result.error) throw result.error;
    return result.data
      ? json({ ok: true })
      : json({ error: "Capture lease is invalid." }, 409);
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "Capture service is temporarily unavailable.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}
