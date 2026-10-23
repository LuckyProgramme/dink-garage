import { getAccount } from "@/lib/auth";
import { serverSupabase } from "@/lib/supabase-server";
import { recorderDatabase } from "@/lib/recorder-server";
import { json, readBody, sameOrigin } from "@/lib/http";
import { uuid, InputError } from "@/lib/validation";
import { checkDriveHealth } from "@/lib/google-server";
export async function GET() {
  const { account } = await getAccount();
  if (!account) return json({ error: "Please sign in." }, 401);
  const db = await serverSupabase();
  const [courts, sessions, settings] = await Promise.all([
    db.rpc("player_court_status"),
    db
      .from("recording_sessions")
      .select(
        "id,court_id,status,started_at,created_at,stopped_at,stop_requested_at,duration_seconds,stop_reason,failure_stage,configuration_snapshot,recording_files(status,expires_at)",
      )
      .eq("player_id", account.id)
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("venue_settings")
      .select("max_duration_seconds")
      .eq("id", true)
      .single(),
  ]);
  if (courts.error || sessions.error || settings.error)
    return json({ error: "Recording status is unavailable." }, 503);
  const ids = sessions.data
    .filter((s) =>
      ["requested", "starting", "recording", "finalizing"].includes(s.status),
    )
    .map((s) => s.id);
  const recorderStates = ids.length
    ? await recorderDatabase()
        .from("capture_jobs")
        .select("session_id,recorders(last_seen_at)")
        .in("session_id", ids)
    : { data: [], error: null };
  if (recorderStates.error)
    return json({ error: "Recorder status is unavailable." }, 503);
  const online = new Map(
    (recorderStates.data || []).map((value) => {
      const item = value as unknown as {
        session_id: string;
        recorders: { last_seen_at: string | null };
      };
      return [
        item.session_id,
        !!item.recorders?.last_seen_at &&
          Date.now() - Date.parse(item.recorders.last_seen_at) < 45000,
      ];
    }),
  );
  return json({
    courts: courts.data,
    sessions: sessions.data.map(({ configuration_snapshot, recording_files, ...s }) => ({
      ...s,
      audio_enabled: configuration_snapshot?.audio_enabled === true,
      expires_at: recording_files?.[0]?.expires_at || null,
      playback_available: s.status === "ready" && recording_files?.[0]?.status === "ready" && Date.parse(recording_files[0].expires_at || "") > Date.now(),
      recorder_online: online.get(s.id) ?? false,
    })),
    maxSeconds: settings.data.max_duration_seconds,
  });
}
export async function POST(request: Request) {
  if (!sameOrigin(request))
    return json({ error: "Request origin is not allowed." }, 403);
  try {
    const { account } = await getAccount();
    if (!account) return json({ error: "Please sign in." }, 401);
    const body = await readBody(request);
    const db = recorderDatabase();
    if (body.action === "start") {
      const key = uuid(body.key);
      const court = uuid(body.court_id);
      // A lost start response must remain recoverable even if Drive goes down.
      const existing = await db.from("recording_sessions").select("id").eq("player_id",account.id).eq("idempotency_key",key).maybeSingle();
      if (existing.error) throw existing.error;
      if (existing.data) return json({id:existing.data.id});
      const health = await checkDriveHealth();
      if (!health.ready) return json({error:"Recording cannot start until Google Drive is ready. Ask the administrator to check the Drive connection and storage. Existing recordings continue saving locally."},503);
      const result = await db.rpc("start_capture", {
        p_player: account.id,
        p_email: account.email,
        p_court: court,
        p_key: key,
      });
      if (result.error)
        return json(
          {
            error:
              result.error.code === "P0001"
                ? result.error.message
                : "The court is busy or could not start. Please refresh and retry.",
          },
          409,
        );
      return json({ id: result.data });
    }
    if (body.action === "stop") {
      const result = await db.rpc("stop_capture", {
        p_player: account.id,
        p_session: uuid(body.id),
      });
      if (result.error) throw result.error;
      return result.data
        ? json({ ok: true })
        : json({ error: "Recording is unavailable or already finished." }, 409);
    }
    throw new InputError("Unknown recording action.");
  } catch (error) {
    return json(
      {
        error:
          error instanceof InputError
            ? error.message
            : "Recording request failed.",
      },
      error instanceof InputError ? 400 : 503,
    );
  }
}
