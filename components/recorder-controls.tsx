"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminData, Device, Recorder } from "@/lib/admin-types";
import { recorderOnline } from "@/lib/recorder-status";

const diagnostics: Record<string, string> = {
  not_tested: "Not tested",
  connected: "Connection passed",
  unreachable: "Camera unreachable",
  needs_configuration: "Add credentials on the venue computer",
  ffmpeg_missing: "FFmpeg unavailable",
  device_missing: "Not found in the last scan",
  unsupported_platform: "Windows required for USB",
};
export default function RecorderControls({
  recorder,
  data,
  onRegister,
}: {
  recorder: Recorder;
  data: AdminData;
  onRegister: (device: Device) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [pair, setPair] = useState<{ code: string; expires: string } | null>(
    null,
  );
  const online = recorderOnline(recorder);
  async function action(action: string, device_reference?: string) {
    setBusy(true);
    setMessage("");
    setFailed(false);
    try {
      const response = await fetch(`/api/admin/recorders/${recorder.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, device_reference }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Action failed.");
      if (result.code) setPair(result);
      else {
        setMessage(result.message || "Recorder disconnected.");
        if (action === "revoke") setPair(null);
      }
      router.refresh();
    } catch (error) {
      setFailed(true);
      setMessage(
        error instanceof Error ? error.message : "Could not reach the server.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="recorder-controls">
      <div className="card-title">
        <h3>Connect & discover</h3>
        <span className={`status-tag ${online ? "connected" : ""}`}>
          {online
            ? "Connected"
            : recorder.paired_at
              ? "Waiting for recorder"
              : "Not paired"}
        </span>
      </div>
      <p className="form-note">
        {online
          ? `${recorder.platform} · service ${recorder.agent_version} · FFmpeg ${recorder.ffmpeg_available ? "ready" : "unavailable"}`
          : "Run the local recorder on a Windows computer connected to the cameras."}
      </p>
      <div className="recorder-actions">
        <button
          className="sign-in"
          disabled={busy}
          onClick={() => action("pair")}
        >
          {recorder.paired_at ? "New pairing code" : "Get pairing code"}
        </button>
        <button
          className="primary"
          disabled={busy || !online}
          onClick={() => action("discover")}
        >
          Discover cameras
        </button>
        {recorder.paired_at && (
          <button
            className="sign-in"
            disabled={busy}
            onClick={() => action("revoke")}
          >
            Revoke pairing
          </button>
        )}
      </div>
      {pair && (
        <div className="pairing-box">
          <strong>Pair on your venue computer</strong>
          <p>
            In the project folder, run <code>npm run recorder -- pair</code>.
            Enter this app’s address and the code below. The code is single-use
            and expires after 10 minutes.
          </p>
          <label>
            One-time pairing code
            <input
              readOnly
              value={pair.code}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <p>
            Then run <code>npm run recorder -- start</code> and leave the
            service running.
          </p>
          <button className="sign-in" onClick={() => setPair(null)}>
            Hide code
          </button>
        </div>
      )}
      {message && (
        <p
          role={failed ? "alert" : "status"}
          className={failed ? "form-error" : "save-success"}
        >
          {message}
        </p>
      )}
      <h3>Discovered devices</h3>
      <p className="form-note">
        A connection test checks video and, when enabled, two seconds of audio without saving a clip. A successful check
        remains valid while the recorder is connected. Retest after changing the
        device or if capture fails. Network cameras may need local credentials.
      </p>
      <div className="discovered-devices">
        {data.devices
          .filter((d) => d.recorder_id === recorder.id)
          .map((device) => {
            const registered = data.cameras.some(
              (c) =>
                c.recorder_id === recorder.id &&
                c.device_reference === device.device_reference,
            );
            return (
              <article key={device.id}>
                <strong>{device.name}</strong>
                <small>
                  {device.source_type === "usb" ? "USB" : "Wi-Fi / Ethernet"} ·{" "}
                  {diagnostics[device.diagnostic] || "Unknown"}
                  {!online ? " · Recorder offline" : ""}
                </small>
                <code>{device.device_reference}</code>
                <div className="recorder-actions">
                  <button
                    className="sign-in"
                    disabled={busy || !online}
                    onClick={() => action("test", device.device_reference)}
                  >
                    Test connection
                  </button>
                  <button
                    className="sign-in"
                    disabled={registered}
                    onClick={() => onRegister(device)}
                  >
                    {registered ? "Registered" : "Assign to court"}
                  </button>
                </div>
              </article>
            );
          })}
      </div>
      {!data.devices.some((d) => d.recorder_id === recorder.id) && (
        <p className="form-note">
          No devices discovered yet. Pair and start the recorder, then run
          discovery.
        </p>
      )}
      <details className="recorder-history">
        <summary>Recent recorder checks</summary>
        {data.commands
          .filter((c) => c.recorder_id === recorder.id)
          .slice(0, 8)
          .map((command) => (
            <p key={command.id}>
              {command.kind === "discover" ? "Discovery" : "Connection test"} ·{" "}
              {command.status}
              {command.result_code && command.result_code !== "completed"
                ? ` · ${command.result_code.replaceAll("_", " ")}`
                : ""}
            </p>
          ))}
      </details>
    </section>
  );
}
