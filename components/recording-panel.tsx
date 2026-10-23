"use client";
import { useEffect, useRef, useState } from "react";
import { Video, Mail, Clock3, Square } from "lucide-react";
type Court = {
  id: string;
  name: string;
  location: string;
  camera_status: string;
  audio_enabled: boolean;
};
type Session = {
  id: string;
  court_id: string;
  status: string;
  started_at: string | null;
  created_at: string;
  stopped_at: string | null;
  stop_requested_at: string | null;
  duration_seconds: number;
  stop_reason: string | null;
  recorder_online: boolean;
  audio_enabled: boolean;
  playback_available: boolean;
  expires_at: string | null;
  failure_stage: string | null;
};
type Snapshot = { courts: Court[]; sessions: Session[]; maxSeconds: number };
const activeStates = ["requested", "starting", "recording", "finalizing"];
const labels: Record<string, string> = {
  requested: "Waiting for recorder",
  starting: "Opening camera",
  recording: "Recording",
  finalizing: "Saving your video",
  local_ready: "Saved locally",
  failed: "Recording interrupted",
  uploading: "Uploading",
  sharing: "Preparing access",
  ready: "Ready",
  deleting: "Expired — cleanup pending",
  deleted: "Expired — video deleted",
};
export default function RecordingPanel({ email }: { email: string }) {
  const [data, setData] = useState<Snapshot>();
  const [courtId, setCourtId] = useState("");
  const [message, setMessage] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const key = useRef<string | null>(null);
  async function refresh() {
    try {
      const response = await fetch("/api/recordings", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result);
      setConnectionError("");
    } catch {
      setConnectionError(
        "Cannot refresh recording status. The recorder still enforces the time limit.",
      );
    }
  }
  useEffect(() => {
    let ended = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await refresh();
      if (!ended) timer = setTimeout(poll, 2000);
    }
    poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      ended = true;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, []);
  const active = data?.sessions.find((s) => activeStates.includes(s.status));
  const selected = data?.courts.find((c) => c.id === courtId);
  async function act(action: "start" | "stop") {
    setBusy(true);
    setMessage("");
    try {
      if (action === "start" && !key.current) key.current = crypto.randomUUID();
      const response = await fetch("/api/recordings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "start"
            ? { action, court_id: courtId, key: key.current }
            : { action, id: active?.id },
        ),
      });
      const result = await response.json();
      if (!response.ok) {
        if (action === "start") key.current = null;
        throw new Error(result.error);
      }
      if (action === "start") key.current = null;
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Request failed. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  const elapsed = active?.started_at
    ? Math.max(0, Math.floor((now - Date.parse(active.started_at)) / 1000))
    : 0;
  const remaining = Math.max(
    0,
    (active?.duration_seconds || data?.maxSeconds || 900) - elapsed,
  );
  return (
    <>
      {connectionError && (
        <p role="alert" className="form-error">
          {connectionError}
        </p>
      )}
      <div className="record-grid">
        <div>
          <div className="subheading">
            <h3>Choose your court</h3>
            <span>{data?.courts.length ?? "…"} active courts</span>
          </div>
          <div className="court-list">
            {data?.courts.map((court) => (
              <button
                key={court.id}
                className="court-card"
                aria-pressed={courtId === court.id}
                disabled={!!active || court.camera_status !== "online"}
                onClick={() => {
                  setCourtId(court.id);
                  key.current = null;
                }}
              >
                <div className="court-thumb">
                  <Video size={27} />
                </div>
                <div className="court-info">
                  <h4>{court.name}</h4>
                  <p>{court.location || "Dink Vision"}</p>
                  <div className="camera-label">
                    {court.camera_status === "online"
                      ? "Last connection check passed"
                      : court.camera_status === "busy"
                        ? "Recording in progress"
                        : "Ask the admin to connect and test the camera"}
                  </div>
                </div>
                <span className="status-tag">
                  {court.camera_status === "online"
                    ? "Available"
                    : court.camera_status === "busy"
                      ? "In use"
                      : "Offline"}
                </span>
              </button>
            ))}
          </div>
          {data && !data.courts.length && (
            <p className="form-note">
              The administrator needs to add a court first.
            </p>
          )}
          <p className="form-note">
            Recordings continue if you close this page. Return here to stop your
            session.
          </p>
        </div>
        <aside className="session-panel">
          <div className="eyebrow">
            {active ? "YOUR MATCH" : "YOUR NEXT RECORDING"}
          </div>
          <h2>
            {active
              ? labels[active.status]
              : selected?.name || "Stay in the game."}
          </h2>
          <div className="session-facts">
            <div>
              <Clock3 size={17} />
              <span>{active ? "Time remaining" : "Recording limit"}</span>
              <strong>
                {active
                  ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
                  : `${(data?.maxSeconds || 900) / 60} minutes`}
              </strong>
            </div>
          </div>
          <div className="recipient">
            <Mail size={17} />
            <div>
              <span>Your verified recipient</span>
              <strong>{email}</strong>
            </div>
          </div>
          {active ? (
            <button
              className="primary record-button"
              disabled={
                busy ||
                !!active.stop_requested_at ||
                active.status === "finalizing"
              }
              onClick={() => act("stop")}
            >
              <Square size={16} />
              {active.stop_requested_at
                ? "Stop requested"
                : active.status === "finalizing"
                  ? "Saving video…"
                  : "Stop recording"}
            </button>
          ) : (
            <button
              className="primary record-button"
              disabled={
                busy ||
                !selected ||
                selected.camera_status !== "online" ||
                !!connectionError
              }
              onClick={() => act("start")}
            >
              {busy ? "Requesting recording…" : "Start recording"}
            </button>
          )}
          {message && (
            <p role="status" className="form-note">
              {message}
            </p>
          )}
          {active && !active.recorder_online && (
            <p role="alert" className="form-error">
              The venue recorder is disconnected. Capture may still be running
              locally. Stop requests will be delivered when it reconnects; the
              local time limit remains in force.
            </p>
          )}
          <p className="form-note">
            {(active ? active.audio_enabled : selected?.audio_enabled) ? "Microphone on — video and audio will be recorded." : "Video only — microphone off."} Clips are saved on the venue computer, then uploaded when Google Drive is connected. Private viewing links appear below and are emailed when the venue has enabled Gmail delivery.
          </p>
        </aside>
      </div>
      <div className="session-history">
        <h3>Your recent recordings</h3>
        {data?.sessions.length ? (
          <ul>
            {data.sessions.map((session) => (
              <li key={session.id}>
                <div>
                  <strong>{session.failure_stage === "short_recording" ? "Saved locally · under one minute" : session.failure_stage === "unsupported_format" ? "Saved locally · older WebM clip" : session.status === "failed" && ["upload","sharing"].includes(session.failure_stage || "") ? "Drive needs attention" : labels[session.status] || session.status}</strong>
                  {session.playback_available && <p><a className="sign-in" href={`/api/recordings/${session.id}/playback`} target="_blank" rel="noopener noreferrer">View on Google Drive</a></p>}
                  {session.status === "ready" && <p className="form-note">{session.playback_available ? "Sign into Google using your recipient email. Google may still be processing the video." : "This recording has expired and is awaiting cleanup."} Viewing deadline: {session.expires_at ? new Date(session.expires_at).toLocaleString() : "Not set"}. Videos are permanently deleted after expiry.</p>}
                  <p className="form-note">
                    {session.status === "local_ready"
                      ? "Saved safely at the venue. Waiting for Google Drive upload; staff can queue older recordings."
                      : session.status === "failed"
                        ? (session.failure_stage === "short_recording" ? "This clip was shorter than one minute, so it was kept only on the recording device and was not sent to Google Drive." : session.failure_stage === "unsupported_format" ? "This older WebM clip was kept on its recording device instead of being sent to Google Drive. New browser recordings use MP4." : ["upload","sharing"].includes(session.failure_stage || "") ? "Your video is saved locally, but Drive upload or sharing needs attention. Ask staff to retry." : "The capture did not finish normally. Any partial video is retained for admin review.")
                        : session.stop_requested_at &&
                            activeStates.includes(session.status)
                          ? "Stop requested; waiting for recorder."
                          : ""}
                  </p>
                </div>
                <time>{new Date(session.created_at).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        ) : (
          <p className="form-note">Your recordings will appear here.</p>
        )}
      </div>
    </>
  );
}
