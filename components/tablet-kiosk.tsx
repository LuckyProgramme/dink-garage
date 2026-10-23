"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Pointer, Square, X, Plus } from "lucide-react";
import CourtArt from "./court-art";
import { localPlayerRecording, hideQueuedSession } from "@/lib/player-session";
import { BrowserCapture, tabletRequest } from "@/lib/browser-recorder";
import { getMeta, listMeta, savedVideo, removeVideo, type LocalRecording } from "@/lib/browser-storage";
import { normalizeRecipients, validTeamRecipients } from "@/lib/team-recipients";
type Court = {
  id: string;
  name: string;
  camera_status: string;
  audio_enabled: boolean;
};
type Session = {
  id: string;
  court_id: string;
  status: string;
  started_at: string | null;
  duration_seconds: number;
  stop_requested_at: string | null;
  email_status: string;
  failure_stage: string | null;
};
type UploadQueue = {
  state:
    | "idle"
    | "queued"
    | "uploading"
    | "failed"
    | "cancelled"
    | "local_only"
    | "complete";
  position: number;
  total: number;
  activeDevice: string | null;
  activeCourt: string | null;
  percent: number;
  blocked: boolean;
};
type State = {
  browser?: boolean;
  device?: any;
  enabled: boolean;
  courts?: Court[];
  session?: Session | null;
  maxSeconds?: number;
  uploadQueue?: UploadQueue | null;
  queue?: Array<{ session_id: string; upload_state: string }>;
};
const active = (s: Session) =>
  ["requested", "starting", "recording", "finalizing"].includes(s.status);
export default function TabletKiosk({
  preview = false,
}: {
  preview?: boolean;
}) {
  const [state, setState] = useState<State | null>(null),
    [screen, setScreen] = useState<"welcome" | "form" | "confirm">("welcome"),
    [court, setCourt] = useState(""),
    [emails, setEmails] = useState<string[]>([]),
    [emailDraft, setEmailDraft] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [countIn, setCountIn] = useState(0),
    [now, setNow] = useState(Date.now()),
    [localQueue, setLocalQueue] = useState<LocalRecording[]>([]),
    [completionNotice, setCompletionNotice] = useState("");
  const key = useRef(""),
    lastTouch = useRef(Date.now()),
    operation = useRef(false),
    refreshing = useRef(false),
    connectionError = useRef<string | null>(null),
    browserMode = useRef(false);
  const capture = useRef<BrowserCapture | null>(null);
  const [progress, setProgress] = useState("");
  const refresh = useCallback(async () => {
    if (preview) {
      setState({
        enabled: true,
        courts: [
          {
            id: "preview-court",
            name: "Court 1",
            camera_status: "online",
            audio_enabled: true,
          },
        ],
        maxSeconds: 900,
        session: null,
      });
      return;
    }
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const r = await fetch(browserMode.current ? "/api/tablet" : "/api/kiosk", {
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d) throw Error(d?.error || "Cannot reach the venue. Please retry.");
      if (d.browser) browserMode.current = true;
      if (d.browser && d.device?.id) {
        const records = await listMeta();
        setLocalQueue(records);
        const current = capture.current;
        const saved = localPlayerRecording(records, d.device.id, current?.activeId);
        if (current?.activeId || (saved && !d.session)) {
          const id = current?.activeId || saved!.id;
          d.session = {
            ...d.session,
            id,
            court_id: saved?.courtId || d.device.court_id,
            status: current?.activeId ? (current.startedAt ? "recording" : "requested") : "failed",
            started_at: current?.startedAt ? new Date(current.startedAt).toISOString() : null,
            duration_seconds: d.maxSeconds || 900,
            stop_requested_at: null,
            email_status: "pending",
            failure_stage: current?.activeId ? null : "browser_capture",
          };
          if (!current?.activeId && saved?.lastError) setProgress(saved.lastError);
        }
      }
      setState(d);
      const recoveredError = connectionError.current;
      if (recoveredError) setError(current => current === recoveredError ? "" : current);
      connectionError.current = null;
      if (d.courts?.length) setCourt(d.courts[0].id);
    } catch (e) {
      const message = e instanceof Error && e.name !== "TimeoutError"
        ? e.message : "Cannot reach the venue. Please retry.";
      connectionError.current = message;
      setError(message);
    } finally {
      refreshing.current = false;
    }
  }, [preview]);
  const refreshLocalQueue = useCallback(async () => {
    if (preview || typeof indexedDB === "undefined") return;
    setLocalQueue((await listMeta()).sort((a, b) => b.createdAt - a.createdAt));
  }, [preview]);
  useEffect(() => {
    const recorder = new BrowserCapture(setProgress, (event) => {
      void refreshLocalQueue();
      if ((event === "queued" || event === "short") && !recorder.activeId) {
        setState((current) => current ? { ...current, session: null } : current);
        setScreen("welcome");
        setCompletionNotice(
          event === "short"
            ? "Recording saved locally. Clips under 1 minute are not uploaded or emailed."
            : "Video complete. Check your Gmail later for the replay link.",
        );
      }
      void refresh();
    });
    capture.current = recorder;
    return () => {
      if (capture.current === recorder) capture.current = null;
      recorder.dispose();
    };
  }, [refresh, refreshLocalQueue]);
  useEffect(() => {
    if (!completionNotice) return;
    const timer = setTimeout(() => setCompletionNotice(""), 8000);
    return () => clearTimeout(timer);
  }, [completionNotice]);
  useEffect(() => {
    if (!state?.browser || !state.device?.id) return;
    const run = () => {
      void refreshLocalQueue();
      if (navigator.onLine) {
        const requestedRetries = (state.queue || [])
          .filter((item) =>
            ["pending", "retrying"].includes(item.upload_state),
          )
          .map((item) => item.session_id);
        void capture.current?.processQueue(
          state.device.id,
          requestedRetries,
        );
      }
    };
    run();
    const timer = setInterval(run, 15000);
    const visible = () => document.visibilityState === "visible" && run();
    window.addEventListener("online", run);
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", run);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [state?.browser, state?.device?.id, state?.queue, refreshLocalQueue]);
  useEffect(() => {
    if (!state?.browser) return;
    void tabletRequest("heartbeat").catch(() => {});
    const t = setInterval(
      () => void tabletRequest("heartbeat").catch(() => {}),
      15000,
    );
    return () => clearInterval(t);
  }, [state?.browser]);
  useEffect(() => {
    if (preview) setCourt("preview-court");
  }, [preview]);
  useEffect(() => {
    void refresh();
    const polling = setInterval(
      () => {
        if (!operation.current) void refresh();
      },
      state?.session ? 5000 : 15000,
    );
    return () => clearInterval(polling);
  }, [refresh, state?.session?.id]);
  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(clock);
  }, []);
  function clearForm() {
    setEmails([]);
    setEmailDraft("");
    key.current = "";
    setScreen("welcome");
    setError("");
  }
  async function downloadLocalBackup() {
    if (!state?.session) throw Error("No saved recording is available.");
    const meta = await getMeta(state.session.id);
    if (!meta) throw Error("No saved recording was found in this browser.");
    const blob = await savedVideo(meta.id, meta.mime);
    if (!blob.size) throw Error("The locally saved recording is empty.");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `wpc-local-backup-${meta.id.slice(0, 8)}.${
      meta.mime === "video/webm" ? "webm" : "mp4"
    }`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setProgress("Local backup downloaded. The protected browser copy is still kept here.");
  }
  useEffect(() => {
    if (
      !state?.session &&
      !capture.current?.activeId &&
      screen !== "welcome" &&
      !busy &&
      now - lastTouch.current > 120000
    )
      clearForm();
  }, [now, state?.session, screen, busy]);
  async function countDownToRecording() {
    for (const value of [3, 2, 1]) {
      setCountIn(value);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    setCountIn(0);
  }
  async function action(action: string) {
    if (preview) {
      setError("Design preview only. Use the enabled venue tablet to record.");
      return;
    }
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError("");
    try {
      const recipients = normalizeRecipients(emails);
      if (action === "start" && !recipients)
        throw Error("Enter at least one valid email address on either team.");
      if (action === "start" && !key.current) key.current = crypto.randomUUID();
      if (state?.browser) {
        if (action === "start") {
          setCompletionNotice("");
          await capture.current!.start(
            state.device,
            recipients!,
            key.current,
            state.maxSeconds || 900,
            countDownToRecording,
          );
          setEmails([]);
          setEmailDraft("");
          setScreen("welcome");
        } else if (action === "stop") {
          if (capture.current?.activeId) {
            capture.current.stop();
            // Clear session data after stop to prevent interruption on next recording
            await tabletRequest("reset", { id: state.session?.id }).catch(() => {});
          } else
            setError(
              "Recording was interrupted. Recover the saved footage below.",
            );
        } else if (action === "recover") {
          await capture.current!.upload(
            state.session!.id,
            state.device.id,
            true,
          );
        } else if (action === "download") {
          await downloadLocalBackup();
        } else if (action === "failed") {
          await tabletRequest("failed", { id: state.session!.id });
        } else {
          if (action === "reset" && state.session) {
            await removeVideo(state.session.id);
          }
          await tabletRequest(action, { id: state.session?.id });
          if (action === "reset") {
            clearForm();
            setProgress("");
          }
        }
        await refresh();
        return;
      }
      if (action === "start") await countDownToRecording();
      const r = await fetch("/api/kiosk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          key: key.current,
          court_id: court,
          email: recipients?.[0],
          emails: recipients,
          id: state?.session?.id,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error);
      if (action === "reset") {
        setState((s) => (s ? { ...s, session: null } : s));
        clearForm();
      } else if (action === "start") {
        setState((s) =>
          s
            ? {
                ...s,
                session: {
                  id: d.id,
                  court_id: court,
                  status: "requested",
                  started_at: null,
                  duration_seconds: s.maxSeconds || 900,
                  stop_requested_at: null,
                  email_status: "pending",
                  failure_stage: null,
                },
              }
            : s,
        );
        setEmails([]);
        setEmailDraft("");
        setScreen("welcome");
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Please retry.");
    } finally {
      setCountIn(0);
      operation.current = false;
      setBusy(false);
    }
  }
  function addEmail() {
    if (emails.length >= 4) {
      setError("You can add a maximum of 4 Gmail accounts.");
      return false;
    }
    const normalized = normalizeRecipients([emailDraft]);
    if (!normalized) {
      setError("Enter a valid Gmail address.");
      return false;
    }
    if (emails.includes(normalized[0])) {
      setError("That Gmail address is already added.");
      return false;
    }
    setEmails((current) => [...current, normalized[0]].slice(0, 4));
    setEmailDraft("");
    setError("");
    return true;
  }
  const locallyQueuedSession = state?.browser && hideQueuedSession(
    localQueue.find(item => item.id === state.session?.id), capture.current?.activeId,
  );
  const session = capture.current?.activeId
    ? state?.session
    : locallyQueuedSession
      ? null
      : state?.session,
    selected = state?.courts?.find((c) => c.id === court),
    minutes = Math.round((state?.maxSeconds || 900) / 60);
  useEffect(() => {
    if (
      !session ||
      active(session) ||
      (state?.browser &&
        session.status !== "ready" &&
        session.status !== "deleted")
    )
      return;
    const t = setTimeout(() => void action("reset"), 45000);
    return () => clearTimeout(t);
  }, [session?.id, session?.status]);
  const currentCapture = capture.current;
  const localStartedAt =
    state?.browser &&
    session &&
    currentCapture &&
    currentCapture.activeId === session.id
      ? currentCapture.startedAt
      : 0;
  const elapsed = session?.started_at || localStartedAt
    ? Math.max(
        0,
        Math.floor(
          (now -
            (localStartedAt || Date.parse(session?.started_at || ""))) /
            1000,
        ),
      )
    : 0;
  const remaining = Math.max(0, (session?.duration_seconds || 900) - elapsed);
  const clock = `${Math.floor(remaining / 60)
    .toString()
    .padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}`;
  const shortLocal = session?.failure_stage === "short_recording";
  const formatLocal = session?.failure_stage === "unsupported_format";
  const localOnly = shortLocal || formatLocal;
  return (
    <main
      className={`tablet${!session && screen === "welcome" ? " tablet--welcome" : !session && screen === "form" ? " tablet--form" : ""}`}
      onPointerDown={() => (lastTouch.current = Date.now())}
      onKeyDown={() => (lastTouch.current = Date.now())}
    >
      {preview && (
        <span className="tablet-preview-label">
          Design preview · Recording disabled
        </span>
      )}
      {countIn > 0 && (
        <div
          className="tablet-count-in"
          role="status"
          aria-live="assertive"
          aria-label={`Recording starts in ${countIn}`}
        >
          <div>
            <span>Recording starts in</span>
            <strong key={countIn} aria-hidden="true">
              {countIn}
            </strong>
            <small>Get ready</small>
          </div>
        </div>
      )}
      <header className="tablet-header">
        <div className="tablet-brand">
          <img src="/dink-vision-logo.png" alt="Dink Vision" />
        </div>
        {!session && screen !== "welcome" && (
          <button
            className="tablet-back"
            onClick={() => {
              if (screen === "confirm") setScreen("form");
              else clearForm();
            }}
          >
            <ArrowLeft />
            Back
          </button>
        )}
      </header>
      <img
        className="tablet-watermark"
        src="/dink-vision-logo.png"
        alt=""
        aria-hidden="true"
      />
      {!session && screen === "welcome" && (
        <>
        {completionNotice && (
          <p className="tablet-saved-toast" role="status">{completionNotice}</p>
        )}
        <button
          className="tablet-welcome"
          aria-label="Tap to start recording your match"
          onClick={() => {
            setScreen("form");
            setError("");
            setCompletionNotice("");
            lastTouch.current = Date.now();
          }}
        >
          <div className="tablet-hero">
            <div className="tablet-copy">
              <p className="tablet-eyebrow">
                <i />
                GOOD GAMES DESERVE A REPLAY
              </p>
              <h1>
                Your court.
                <br />
                Your <em>moment.</em>
              </h1>
              <p className="tablet-tagline">
                The rallies. The close calls. That winning shot.
                <br />
                Record your match and take a little of the court home.
              </p>
            </div>
            <div className="tablet-art">
              <div className="tablet-orbit" />
              <CourtArt />
            </div>
          </div>
          <div className="tablet-tap">
            <div className="tap-hand">
              <span />
              <Pointer strokeWidth={1.7} />
            </div>
            <span>Tap to start</span>
          </div>
        </button>
        </>
      )}
      {!session && screen === "form" && (
        <section className="tablet-form-screen">
          <h1>Record your match</h1>
          <p className="tablet-subtitle">
            Add one Gmail account at a time. You can register up to 4 recipients.
          </p>
          {!state ? (
            <p role="status">Connecting to the venue…</p>
          ) : !state.enabled ? (
            <div className="tablet-setup">
              <p>
                This tablet needs a one-time setup by the venue administrator.
              </p>
              <a href="/tablet/setup">Register this tablet</a>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (selected?.camera_status === "online") setScreen("confirm");
              }}
            >
              {state.device?.test_requested && (
                <p className="tablet-helper">
                  A camera test was requested.{" "}
                  <a href="/tablet/setup">Open tablet setup</a>.
                </p>
              )}
              <div className="tablet-assigned-entry">
                <label>Assigned court</label>
                <div className="tablet-assigned-court">
                  {selected?.name || "Court assignment needed"}
                  {selected?.camera_status !== "online" && (
                    <small>
                      Ask the administrator to check this tablet and camera.
                    </small>
                  )}
                </div>
              </div>
              <div className="tablet-email-entry">
                <label htmlFor="player-email">Player Gmail</label>
                <div className="tablet-email-add-row">
                  <input
                    id="player-email"
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={254}
                    placeholder="player@gmail.com"
                    value={emailDraft}
                    onChange={(e) => {
                      setEmailDraft(e.target.value);
                      setError("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addEmail();
                    }}
                  />
                  <button
                    type="button"
                    className="tablet-email-add"
                    disabled={emails.length >= 4 || !emailDraft.trim()}
                    onClick={addEmail}
                  >
                    <Plus size={17} /> Add Gmail
                  </button>
                </div>
                <p className="tablet-email-hint">Registered emails ({emails.length}/4) · At least 1 is required.</p>
                {emails.length > 0 && (
                  <div className="tablet-email-list" aria-label="Added Gmail accounts">
                    {emails.map((address) => (
                      <div className="tablet-email-chip" key={address}>
                        <span>{address}</span>
                        <button
                          type="button"
                          aria-label={`Remove ${address}`}
                          onClick={() => {
                            setEmails((current) => current.filter((item) => item !== address));
                            setError("");
                          }}
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button
                className="tablet-record"
                disabled={
                  busy ||
                  !validTeamRecipients(emails) ||
                  selected?.camera_status !== "online"
                }
              >
                <i />
                <span>
                  Start
                  <br />
                  Recording
                </span>
              </button>
              <p className="tablet-helper">
                At least one valid Gmail address is required. Added players receive the same replay.
                <br />
                Recording limit: {minutes} minutes
              </p>
            </form>
          )}
          {!preview && (
            <a className="tablet-reenroll" href="/tablet/setup?reenroll=1">
              Re-enroll device
            </a>
          )}
        </section>
      )}
      {!session && screen === "confirm" && (
        <section className="tablet-session tablet-confirm-screen">
          <p className="tablet-eyebrow">ONE LAST CHECK</p>
          <h1>Ready to play?</h1>
          <p className="tablet-subtitle">
            {selected?.name} · Up to {minutes} minutes
          </p>
          <div className="tablet-confirm-summary">
            <div className="tablet-confirm-recipients">
              <div className="tablet-confirm-title">
                <strong>Replay recipients</strong>
                <span>{emails.length} of 4 added</span>
              </div>
              <ul>
                {emails.length ? (
                  emails.map((address) => <li key={address}>{address}</li>)
                ) : (
                  <li>No email added</li>
                )}
              </ul>
            </div>
            <p className="tablet-confirm-delivery">
              One Google Drive replay will be emailed to every address above.
              Please check each address before recording.
            </p>
          </div>
          <p className="tablet-confirm-note">
            Anyone holding the emailed link can watch your video.
            <br />
            {selected?.audio_enabled
              ? "Video and microphone audio will be recorded."
              : "This court records video without audio."}
          </p>
          <button
            className="tablet-solid"
            disabled={busy}
            onClick={() => void action("start")}
          >
            {busy ? "Starting…" : "Confirm & start recording"}
          </button>
          <button
            className="tablet-text"
            disabled={busy}
            onClick={() => setScreen("form")}
          >
            Edit details
          </button>
        </section>
      )}
      {session && (
        <section className="tablet-session" aria-live="polite">
          <p className="tablet-eyebrow">
            {state?.courts?.find((c) => c.id === session.court_id)?.name ||
              "YOUR MATCH"}
          </p>
          <h1>
            {["deleted", "deleting"].includes(session.status)
              ? "This replay has expired."
              : session.status === "recording"
                ? "Stay in the game."
                : session.status === "requested" ||
                    session.status === "starting"
                  ? "Getting ready…"
                  : session.status === "failed"
                    ? shortLocal
                      ? "Short clip saved locally."
                      : formatLocal
                        ? "Older WebM clip saved locally."
                      : "Your recording needs help. Return to welcome and try again."
                    : session.status === "ready"
                      ? "Your replay is ready."
                      : active(session)
                        ? "Saving your match…"
                        : "Your match is saved."}
          </h1>
          {session.status === "recording" ? (
            <>
              <p className="tablet-countdown">{clock}</p>
              <p>
                {state?.browser
                  ? "Keep this recording tab open and the device awake. You can switch tabs; return here to stop recording."
                  : "Time remaining · Recording continues if this page closes."}
              </p>
            </>
          ) : (
            <p className="tablet-subtitle">
              {["deleted", "deleting"].includes(session.status)
                ? "The retention period has ended. You can start a new match."
                : session.status === "ready"
                  ? session.email_status === "sent"
                    ? "Your replay link has been sent. Check your inbox."
                    : session.email_status === "failed" ||
                        session.email_status === "unknown"
                      ? "Email delivery needs attention. Please ask the administrator."
                      : "Preparing your email…"
                  : session.status === "failed"
                    ? shortLocal
                      ? "Clips under one minute are not uploaded to Google Drive."
                      : formatLocal
                        ? "This older WebM clip stays on this device. New recordings use MP4."
                        : "Please ask the venue administrator to check this session."
                    : active(session)
                      ? state?.browser
                        ? "Preparing this tablet’s camera…"
                        : "Please wait while the venue recorder responds."
                      : "We’ll email your replay once the upload is complete."}
            </p>
          )}
          {localOnly && (
            <div className="tablet-upload-status is-paused" role="status">
              <div className="tablet-progress">
                <strong>Local backup only</strong>
              </div>
              <small>
                {formatLocal
                  ? "This older WebM clip was not sent to Google Drive. It is stored in this browser’s protected IndexedDB site storage named casa-browser-recordings."
                  : "Stored in this browser’s protected IndexedDB site storage named casa-browser-recordings."}{" "}
                It is not a normal folder; use Download local backup to save a
                regular video file in the browser’s Downloads folder or your
                selected download location.
              </small>
            </div>
          )}
          {state?.browser &&
          !capture.current?.activeId &&
          !["ready", "deleted", "deleting"].includes(session.status) ? (
            <>
              {!localOnly && (
                <button
                  className="tablet-solid"
                  disabled={busy}
                  onClick={() => void action("recover")}
                >
                  {busy ? "Recovering…" : "Recover / retry upload"}
                </button>
              )}
              <button
                className={localOnly ? "tablet-solid" : "tablet-text"}
                disabled={busy}
                onClick={() => void action("download")}
              >
                Download local backup
              </button>
              <p>
                Browser recordings are kept in this site’s protected IndexedDB
                storage, not a normal folder. They stay there while offline or
                until this webpage or APK verifies that the upload completed.
                Clearing browser data removes them; interrupted recordings may
                be partial.
              </p>
              {["requested", "recording"].includes(session.status) && (
                <button
                  className="tablet-text"
                  disabled={busy}
                  onClick={() => void action("failed")}
                >
                  Mark interrupted recording as failed
                </button>
              )}
              {session.status === "failed" && (
                <button
                  className="tablet-text"
                  disabled={busy}
                  onClick={() => void action("reset")}
                >
                  {localOnly
                    ? "Delete local clip and return to welcome"
                    : "Leave failed recording and return to welcome"}
                </button>
              )}
            </>
          ) : active(session) ? (
            <button
              className="tablet-solid"
              disabled={busy || !!session.stop_requested_at}
              onClick={() => void action("stop")}
            >
              <Square size={18} />
              {session.stop_requested_at ? "Stopping…" : "Stop recording"}
            </button>
          ) : (
            <button
              className="tablet-solid"
              disabled={busy}
              onClick={() => void action("reset")}
            >
              Done · Back to welcome
            </button>
          )}
        </section>
      )}
      {error && (
        <div className="tablet-error" role="alert">
          {error}
          <button
            onClick={() => {
              setError("");
              void refresh();
            }}
          >
            Retry connection
          </button>
        </div>
      )}
    </main>
  );
}
