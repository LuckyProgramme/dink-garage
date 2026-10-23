"use client";
import BrowserTabletsAdmin from "./browser-tablets-admin";
import GoogleDriveControls, { DriveRetry } from "./google-drive-controls";
import DriveHealthBanner from "./drive-health-banner";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Camera as CameraIcon,
  LayoutGrid,
  Settings2,
  List,
  Monitor,
  Plus,
  CheckCircle2,
  Trash2,
} from "lucide-react";
import type {
  AdminData,
  Camera,
  Court,
  Recorder,
  Device,
} from "@/lib/admin-types";

import { cameraOnline } from "@/lib/recorder-status";

type Tab = "overview" | "courts" | "cameras" | "settings" | "logs";
function SaveForm({
  resource,
  children,
  convert,
  onSaved,
  secondaryAction,
}: {
  resource: string;
  children: ReactNode;
  convert: (form: FormData) => object;
  onSaved?: (id?: string) => void;
  secondaryAction?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    setFailed(false);
    const body = convert(new FormData(e.currentTarget));
    try {
      const response = await fetch(`/api/admin/${resource}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(result.error || "Unable to save.");
        setFailed(true);
      } else {
        setMessage("Saved successfully.");
        router.refresh();
        onSaved?.(typeof result.id === "string" ? result.id : undefined);
      }
    } catch {
      setMessage(
        "Could not reach the server. Your changes have not been saved.",
      );
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack-form" onSubmit={submit}>
      <fieldset disabled={busy}>{children}</fieldset>
      <div className="save-row">
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {secondaryAction}
        {message && (
          <p
            role={failed ? "alert" : "status"}
            className={failed ? "form-error" : "save-success"}
          >
            {message}
          </p>
        )}
      </div>
    </form>
  );
}

function CourtForm({
  court,
  onRemoved,
}: {
  court?: Court;
  onRemoved: () => void;
}) {
  const [updating, setUpdating] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [statusFailed, setStatusFailed] = useState(false);
  const router = useRouter();

  async function removeCourt() {
    if (!court) return;
    setUpdating(true);
    setStatusMessage("");
    setStatusFailed(false);
    try {
      const response = await fetch("/api/admin/courts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: court.id }),
      });
      const result = await response.json();
      if (!response.ok) {
        setStatusMessage(
          result.error || "Unable to permanently remove this court.",
        );
        setStatusFailed(true);
        return;
      }
      setConfirmingRemove(false);
      setStatusMessage("Court permanently removed.");
      onRemoved();
      router.refresh();
    } catch {
      setStatusMessage(
        "Could not reach the server. This court was not removed.",
      );
      setStatusFailed(true);
    } finally {
      setUpdating(false);
    }
  }

  return (
    <>
      <SaveForm
        resource="courts"
        convert={(f) => ({
          id: court?.id,
          name: f.get("name"),
          location: f.get("location"),
          active: true,
        })}
        secondaryAction={
          court ? (
            <button
              type="button"
              className="remove-court-button"
              disabled={updating}
              onClick={() => {
                setStatusMessage("");
                setConfirmingRemove(true);
              }}
            >
              <Trash2 size={15} /> Remove court
            </button>
          ) : undefined
        }
      >
        <label>
          Court name
          <input
            name="name"
            defaultValue={court?.name}
            placeholder="Court 01"
            required
            maxLength={100}
          />
        </label>
        <label>
          Location or description
          <input
            name="location"
            defaultValue={court?.location}
            placeholder="Garden side"
            maxLength={150}
          />
        </label>
        <p className="form-note">
          Removing a court permanently deletes only the court. Existing videos
          and recording logs remain available.
        </p>
        {statusMessage && (
          <p
            role={statusFailed ? "alert" : "status"}
            className={statusFailed ? "form-error" : "save-success"}
          >
            {statusMessage}
          </p>
        )}
      </SaveForm>
      {confirmingRemove && court && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !updating)
              setConfirmingRemove(false);
          }}
        >
          <section
            className="confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-court-title"
            aria-describedby="remove-court-description"
          >
            <div className="confirm-modal-icon" aria-hidden="true">
              <Trash2 size={20} />
            </div>
            <h2 id="remove-court-title">Remove {court.name}?</h2>
            <p id="remove-court-description">
              This permanently deletes the court and removes it from assigned
              devices. Existing videos and recording logs are kept. This cannot
              be undone.
            </p>
            {statusFailed && statusMessage && (
              <p role="alert" className="form-error">
                {statusMessage}
              </p>
            )}
            <div className="confirm-modal-actions">
              <button
                type="button"
                className="sign-in"
                disabled={updating}
                autoFocus
                onClick={() => setConfirmingRemove(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="remove-court-button remove-court-button-solid"
                disabled={updating}
                onClick={() => void removeCourt()}
              >
                <Trash2 size={15} />
                {updating ? "Removing…" : "Remove court"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export default function AdminDashboard({ data }: { data: AdminData }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [courtId, setCourtId] = useState("");
  const [newCourtVersion, setNewCourtVersion] = useState(0);
  const courtEditor = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!newCourtVersion) return;
    courtEditor.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    courtEditor.current?.querySelector<HTMLInputElement>('input[name="name"]')?.focus({ preventScroll: true });
  }, [newCourtVersion]);
  const [tablets, setTablets] = useState<any[]>([]);
  useEffect(() => {
    const load = () =>
      fetch("/api/admin/tablets")
        .then((r) => r.json())
        .then((d) => setTablets(d.devices || []))
        .catch(() => {});
    void load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, []);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [date, setDate] = useState("");
  const [logPage, setLogPage] = useState(1);
  const logScroll = useRef<HTMLDivElement>(null);
  const router = useRouter();
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(refreshWhenVisible, 3000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [router]);
  const zone = data.settings.venue_time_zone || "UTC";
  function timestamp(value: string) {
    return new Intl.DateTimeFormat("en", {
      timeZone: zone,
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  }
  function localDate(value: string) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(value));
  }
  function recordingCourtName(session: AdminData["sessions"][number]) {
    return (
      data.courts.find((court) => court.id === session.court_id)?.name ||
      session.configuration_snapshot?.court_name ||
      "Deleted court"
    );
  }
  function recordingRecipients(session: AdminData["sessions"][number]) {
    const recipients = session.configuration_snapshot?.recipient_emails;
    return Array.isArray(recipients) && recipients.length
      ? recipients.join(", ")
      : session.recipient_email;
  }
  const filtered = data.sessions.filter(
    (session) =>
      (!status || session.status === status) &&
      (!date || localDate(session.created_at) === date) &&
      `${recordingRecipients(session)} ${recordingCourtName(session)} ${session.id}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(logPage, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const pageSessions = filtered.slice(pageStart, pageStart + pageSize);
  useEffect(() => {
    setLogPage((page) => Math.min(page, pageCount));
  }, [pageCount]);
  useEffect(() => {
    logScroll.current?.scrollTo({ top: 0, left: 0 });
  }, [currentPage, search, status, date]);
  const activeCourts = data.courts.filter((court) => court.active);
  const recordingCourtIds = new Set(
    data.sessions
      .filter((session) => session.status === "recording")
      .map((session) => session.court_id),
  );
  const recordingCourts = activeCourts.filter((court) =>
    recordingCourtIds.has(court.id),
  );
  const selectedCourt = data.courts.find((court) => court.id === courtId);
  const nav = [
    { id: "overview", label: "Overview", icon: LayoutGrid },
    { id: "courts", label: "Courts", icon: LayoutGrid },
    { id: "cameras", label: "Devices & cameras", icon: CameraIcon },
    { id: "settings", label: "Settings", icon: Settings2 },
    { id: "logs", label: "Recording logs", icon: List },
  ] as const;
  return (
    <main className="shell admin-main">
      <div className="admin-title">
        <div>
          <div className="eyebrow">A LITTLE ORDER. MORE GOOD GAMES.</div>
          <h1>Your club, at a glance.</h1>
          <p>Manage the spaces and settings behind every match.</p>
        </div>
        <a className="sign-in" href="/">
          View player page →
        </a>
      </div>
      <nav className="admin-tabs" aria-label="Admin sections">
        {nav.map((item) => (
          <button
            key={item.id}
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => setTab(item.id)}
          >
            <item.icon size={16} />
            {item.label}
          </button>
        ))}
      </nav>

      <div
        className={`live-recording-indicator ${recordingCourts.length ? "is-recording" : ""}`}
        role="status"
        aria-live="polite"
      >
        <span className="live-recording-dot" aria-hidden="true" />
        <div>
          <strong>
            {recordingCourts.length ? "Recording now" : "No live recordings"}
          </strong>
          <span>
            {recordingCourts.length
              ? recordingCourts.map((court) => court.name).join(", ")
              : "All courts are currently idle."}
          </span>
        </div>
      </div>

      {tab === "overview" && (
        <>
          <DriveHealthBanner />
          <div className="admin-stats">
            <article>
              <LayoutGrid size={22} />
              <strong>{data.courts.filter((c) => c.active).length}</strong>
              <span>Active courts</span>
            </article>
            <article>
              <CameraIcon size={22} />
              <strong>
                {tablets.filter((t) => t.tested_at && t.enabled).length}
              </strong>
              <span>Tested tablet cameras</span>
            </article>
            <article>
              <Monitor size={22} />
              <strong>{tablets.filter((t) => t.enabled).length}</strong>
              <span>Enrolled tablet entries</span>
            </article>
            <article>
              <CheckCircle2 size={22} />
              <strong>{data.sessions.length}</strong>
              <span>Recent sessions (up to 100)</span>
            </article>
          </div>
          <div className="admin-columns">
            <section className="admin-card" style={{ gridColumn: "1 / -1" }}>
              <div className="eyebrow">SETUP CHECKLIST</div>
              <h2>Ready for your next stage.</h2>
              <ul className="setup-list">
                <li>
                  <span>Admin access</span>
                  <b className="status-tag connected">Connected</b>
                </li>
                <li>
                  <span>Court configuration</span>
                  <b className="status-tag">
                    {data.courts.length ? "Configured" : "Add your first court"}
                  </b>
                </li>
                <li>
                  <span>Venue time zone</span>
                  <b className="status-tag">
                    {data.settings.venue_time_zone || "Needs configuration"}
                  </b>
                </li>
                <li>
                  <span>Browser tablet setup</span>
                  <b className="status-tag">
                    {tablets.some((t) => t.enabled && t.tested_at)
                      ? "Configured"
                      : "Enroll a tablet"}
                  </b>
                </li>
                <li>
                  <span>Google Drive</span>
                  <button
                    className="sign-in"
                    onClick={() => setTab("settings")}
                  >
                    Manage connection
                  </button>
                </li>
              </ul>
              <p className="form-note">
                Completed matches upload to Google Drive with emailed link
                access. Enable Gmail delivery in Settings to email playback
                links automatically.
              </p>
            </section>
          </div>
        </>
      )}

      {tab === "courts" && (
        <div className="admin-columns">
          <section className="admin-card">
            <div className="card-title">
              <h2>Your courts</h2>
              <button type="button" className="sign-in" onClick={() => { setCourtId(""); setNewCourtVersion((v) => v + 1); }}>
                <Plus size={15} /> Add court
              </button>
            </div>
            {activeCourts.length ? (
              <div className="admin-items">
                {activeCourts.map((court) => {
                  const recording = recordingCourtIds.has(court.id);
                  return (
                    <button
                      className={recording ? "court-recording" : undefined}
                      key={court.id}
                      aria-pressed={courtId === court.id}
                      onClick={() => setCourtId(court.id)}
                    >
                      <span>
                        <strong>{court.name}</strong>
                        <small>{court.location || "No location set"}</small>
                        <small>
                          {tablets.find(
                            (t) => t.enabled && t.court_id === court.id,
                          )?.name || "No browser tablet assigned"}
                        </small>
                      </span>
                      <span className={`status-tag ${recording ? "recording" : ""}`}>
                        {recording ? "Recording now" : "Active"}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="form-note">
                No courts yet. Add your first court.
              </p>
            )}
          </section>
          <section className="admin-card" ref={courtEditor}>
            <h2>{selectedCourt ? "Edit court" : "Add court"}</h2>
            <CourtForm
              key={`${courtId}-${newCourtVersion}-${selectedCourt?.active ?? "new"}`}
              court={selectedCourt}
              onRemoved={() => setCourtId("")}
            />
          </section>
        </div>
      )}

      {tab === "cameras" && <BrowserTabletsAdmin />}

      {tab === "settings" && <GoogleDriveControls />}
      {tab === "settings" && (
        <section className="admin-card settings-card">
          <div className="eyebrow">YOUR VENUE, YOUR DEFAULTS</div>
          <h2>A little room to play.</h2>
          <SaveForm
            resource="settings"
            convert={(f) => ({
              duration_minutes: Number(f.get("duration_minutes")),
              retention_hours: Number(f.get("retention_hours")),
              venue_time_zone: f.get("venue_time_zone"),
            })}
          >
            <div className="form-columns">
              <label>
                Maximum recording duration (minutes)
                <input
                  type="number"
                  name="duration_minutes"
                  min={1}
                  max={120}
                  step={1}
                  defaultValue={data.settings.max_duration_seconds / 60}
                  required
                />
              </label>
              <label>
                Video retention after upload (hours)
                <input
                  type="number"
                  name="retention_hours"
                  min={1}
                  max={720}
                  step={1}
                  defaultValue={data.settings.retention_seconds / 3600}
                  required
                />
              </label>
            </div>
            <label>
              Venue time zone
              <input
                name="venue_time_zone"
                defaultValue={data.settings.venue_time_zone || ""}
                list="time-zones"
                placeholder="Choose your venue’s time zone"
                required
              />
              <datalist id="time-zones">
                <option value="Asia/Manila" />
                <option value="Asia/Taipei" />
                <option value="Asia/Singapore" />
                <option value="UTC" />
              </datalist>
            </label>
            <div className="admin-callout">
              <p>
                Duration changes apply to new sessions. Retention changes apply
                to newly uploaded videos. Existing recordings keep their saved
                limits and expiry.
              </p>
            </div>
            <label className="check-label">
              <input type="checkbox" required /> I confirm these settings for
              future recordings.
            </label>
          </SaveForm>
        </section>
      )}

      {tab === "logs" && (
        <section className="admin-card">
          <h2>Every match has a story.</h2>
          <p className="form-note">
            Latest 100 sessions, newest first. Times in {zone}.
          </p>
          <div className="log-filters">
            <label>
              Find a recording
              <input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setLogPage(1); }}
                placeholder="Player email, court, or session ID"
              />
            </label>
            <label>
              Status
              <select
                value={status}
                onChange={(e) => { setStatus(e.target.value); setLogPage(1); }}
              >
                <option value="">All statuses</option>
                {[
                  "requested",
                  "starting",
                  "recording",
                  "finalizing",
                  "local_ready",
                  "uploading",
                  "sharing",
                  "ready",
                  "failed",
                  "deleting",
                  "deleted",
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Venue date
              <input
                type="date"
                value={date}
                onChange={(e) => { setDate(e.target.value); setLogPage(1); }}
              />
            </label>
          </div>
          {filtered.length ? (
            <div className="table-scroll recording-log-scroll" ref={logScroll} tabIndex={0} role="region" aria-label="Recording logs">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Court</th>
                    <th>Recipients</th>
                    <th>Status</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {pageSessions.map((session) => (
                    <tr key={session.id}>
                      <td>{timestamp(session.created_at)}</td>
                      <td>
                        {recordingCourtName(session)}
                      </td>
                      <td>{recordingRecipients(session)}</td>
                      <td>
                        <span className="status-tag">
                          {session.status === "local_ready"
                            ? "Saved locally"
                            : session.status}
                        </span>
                      </td>
                      <td>
                        <details>
                          <summary>View</summary>
                          <p>ID: {session.id}</p>
                          {session.configuration_snapshot?.capture_mode ===
                            "browser" && (
                            <p>
                              Tablet:{" "}
                              {tablets.find(
                                (t) =>
                                  t.id ===
                                  session.configuration_snapshot?.device_id,
                              )?.name ||
                                session.configuration_snapshot.device_id}
                              <br />
                              Camera:{" "}
                              {session.configuration_snapshot.camera_name}
                              <br />
                              For interrupted uploads, open player mode on the
                              original tablet and choose Recover / retry upload.
                            </p>
                          )}
                          <p>
                            Start:{" "}
                            {session.started_at
                              ? timestamp(session.started_at)
                              : "Not started"}
                          </p>
                          <p>
                            Stop:{" "}
                            {session.stopped_at
                              ? timestamp(session.stopped_at)
                              : "—"}
                          </p>
                          <p>Reason: {session.stop_reason || "—"}</p>
                          <p>Failure stage: {session.failure_stage || "—"}</p>
                          {(session.status === "local_ready" ||
                            ["upload", "sharing"].includes(
                              session.failure_stage || "",
                            )) && <DriveRetry sessionId={session.id} />}
                          {session.status === "ready" && (
                            <a
                              className="sign-in"
                              target="_blank"
                              rel="noopener noreferrer"
                              href={`/api/recordings/${session.id}/playback`}
                            >
                              View on Google Drive
                            </a>
                          )}
                          {session.status === "local_ready" && (
                            <p>
                              Video saved on the venue recorder in its protected
                              captures folder, under this session ID. Connect
                              Google Drive in Settings to upload it.
                            </p>
                          )}
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-panel">
              <List size={26} />
              <h3>
                {data.sessions.length
                  ? "No matching recordings."
                  : "No recordings yet."}
              </h3>
              <p>
                {data.sessions.length
                  ? "Try another filter."
                  : "Session history will appear once the recording service is connected."}
              </p>
            </div>
          )}
          <nav className="log-pagination" aria-label="Recording log pages">
            <span role="status">
              {filtered.length ? `${pageStart + 1}–${Math.min(pageStart + pageSize, filtered.length)} of ${filtered.length} recordings` : "0 recordings"}
            </span>
            <div className="log-page-controls">
              <button className="sign-in" disabled={currentPage === 1} onClick={() => setLogPage(currentPage - 1)}>Previous</button>
              <span>Page {currentPage} of {pageCount}</span>
              <button className="sign-in" disabled={currentPage === pageCount} onClick={() => setLogPage(currentPage + 1)}>Next</button>
            </div>
          </nav>
        </section>
      )}
    </main>
  );
}
