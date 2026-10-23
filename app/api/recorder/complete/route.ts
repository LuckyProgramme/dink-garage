import { authenticateRecorder } from "@/lib/recorder-server";
import { completionInput } from "@/lib/recorder-protocol";
import { json, readBody } from "@/lib/http";
import { InputError } from "@/lib/validation";
export async function POST(request: Request) {
  try {
    const auth = await authenticateRecorder(request);
    if (!auth)
      return json({ error: "Recorder token is invalid or revoked." }, 401);
    const body = completionInput(await readBody(request, 32768));
    const { data, error } = await auth.db.rpc("finish_recorder_command", {
      p_recorder_id: auth.recorderId,
      p_command_id: body.id,
      p_lease_token: body.lease,
      p_success: body.success,
      p_devices: body.devices,
    });
    if (error) return json({ error: "Result was rejected." }, 400);
    return data
      ? json({ ok: true })
      : json({ error: "Command lease is no longer valid." }, 409);
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "Could not accept the result.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}
