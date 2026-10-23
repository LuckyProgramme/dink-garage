import { authenticateRecorder } from "@/lib/recorder-server";
import { json, readBody } from "@/lib/http";
import { bool, InputError, text } from "@/lib/validation";
export async function POST(request: Request) {
  try {
    const auth = await authenticateRecorder(request);
    if (!auth)
      return json({ error: "Recorder token is invalid or revoked." }, 401);
    const body = await readBody(request);
    if (!["win32", "linux", "darwin"].includes(String(body.platform)))
      throw new InputError("Unsupported platform.");
    const { error } = await auth.db
      .from("recorders")
      .update({
        last_seen_at: new Date().toISOString(),
        agent_version: text(body.version, "Agent version", 30),
        platform: body.platform,
        ffmpeg_available: bool(body.ffmpeg_available),
      })
      .eq("id", auth.recorderId);
    if (error) throw error;
    const active = await auth.db
      .from("capture_jobs")
      .select("session_id")
      .eq("recorder_id", auth.recorderId)
      .in("status", ["pending", "active"])
      .limit(1);
    if (active.error) throw active.error;
    if (active.data?.length) return json({ command: null });
    const result = await auth.db.rpc("claim_recorder_command", {
      p_recorder_id: auth.recorderId,
    });
    if (result.error) throw result.error;
    const job = result.data?.[0];
    let audioSource = "";
    if (job?.kind === "test") {
      const cameras = await auth.db.from("cameras").select("audio_source").eq("recorder_id", auth.recorderId).eq("device_reference", job.device_reference);
      if (cameras.error) throw cameras.error;
      const sources = [...new Set((cameras.data || []).map(c => c.audio_source))];
      if (sources.length > 1) throw new InputError("Camera registrations have different audio settings.");
      audioSource = sources[0] || "";
    }
    return json({
      command: job
        ? {
            id: job.id,
            kind: job.kind,
            audio_source: audioSource,
            device_reference: job.device_reference,
            lease_token: job.lease_token,
          }
        : null,
    });
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "Recorder polling is temporarily unavailable.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}
