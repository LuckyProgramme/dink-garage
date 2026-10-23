"use client";
import { useEffect, useRef, useState } from "react";
import {
  openCamera,
  testCamera,
  type BrowserCamera,
} from "@/lib/browser-media";
import { tabletRequest } from "@/lib/browser-recorder";
import {
  cameraTransform,
  DEFAULT_CAMERA_TRANSFORM,
} from "@/lib/camera-transform";
export default function BrowserTabletSetup() {
  const [state, setState] = useState<any>(null),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [testClip, setTestClip] = useState(""),
    [testHasAudio, setTestHasAudio] = useState(false),
    [previewing, setPreviewing] = useState(false),
    [reenrolling, setReenrolling] = useState(false),
    [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<BrowserCamera>({
    source_type: "local",
    video_device: "",
    audio_device: "",
    camera_name: "",
    ...DEFAULT_CAMERA_TRANSFORM,
  });
  const video = useRef<HTMLVideoElement>(null);
  const previewClose = useRef<(() => void) | null>(null);
  async function refresh() {
    const r = await fetch("/api/tablet?setup=1", { cache: "no-store", signal: AbortSignal.timeout(15000) })
      .catch(() => { throw Error("Tablet connection unavailable. Please retry."); });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) throw Error(d?.error || "Tablet connection unavailable. Please retry.");
    setState(d);
    if (d.device)
      setConfig({
        ...d.device,
        source_type: "local",
        ...cameraTransform(d.device),
        video_rotation: 0,
      });
  }
  useEffect(() => {
    setReenrolling(
      new URLSearchParams(window.location.search).get("reenroll") === "1",
    );
    void refresh().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setTestClip("");
    setTestHasAudio(false);
  }, [
    config.video_device,
    config.audio_device,
    config.video_rotation,
    config.video_flip_horizontal,
    config.video_flip_vertical,
  ]);
  useEffect(
    () => () => {
      if (testClip) URL.revokeObjectURL(testClip);
    },
    [testClip],
  );
  useEffect(
    () => () => {
      previewClose.current?.();
      previewClose.current = null;
    },
    [],
  );
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function cameraAccessError(error: unknown) {
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError")
      return Error(
        "Camera access is blocked. Open this site’s permissions, allow Camera and Microphone, then try again.",
      );
    if (name === "NotFoundError" || name === "DevicesNotFoundError")
      return Error(
        "No usable camera was found. Connect the USB camera, then try again.",
      );
    if (name === "NotReadableError" || name === "TrackStartError")
      return Error(
        "The camera is being used by another app or browser tab. Close it there, then try again.",
      );
    return error instanceof Error
      ? error
      : Error("The browser could not open this camera.");
  }
  function stopPreview() {
    previewClose.current?.();
    previewClose.current = null;
    if (video.current) {
      video.current.pause();
      video.current.srcObject = null;
    }
    setPreviewing(false);
  }
  async function showPreview(next: BrowserCamera) {
    stopPreview();
    let camera: Awaited<ReturnType<typeof openCamera>>;
    try {
      camera = await openCamera(next);
      if (!video.current) {
        camera.close();
        return;
      }
      previewClose.current = camera.close;
      video.current.srcObject = camera.stream;
      await video.current.play();
      setPreviewing(true);
    } catch (error) {
      stopPreview();
      throw cameraAccessError(error);
    }
  }
  function updatePreview(next: BrowserCamera) {
    setConfig(next);
    if (!previewClose.current) return;
    void run(async () => {
      await showPreview(next);
      setMessage(
        "Live preview updated. Record the test clip when the picture and microphone are correct.",
      );
    });
  }
  async function discover() {
    if (!window.isSecureContext || !navigator.mediaDevices)
      throw Error(
        "Open the deployed HTTPS address on your tablet to use cameras.",
      );
    let permissionStream: MediaStream;
    try {
      permissionStream = await navigator.mediaDevices
        .getUserMedia({ video: true, audio: true })
        .catch(() => navigator.mediaDevices.getUserMedia({ video: true }));
    } catch (error) {
      throw cameraAccessError(error);
    }
    try {
      const found = await navigator.mediaDevices.enumerateDevices();
      const cameras = found.filter((device) => device.kind === "videoinput");
      const microphones = found.filter(
        (device) => device.kind === "audioinput",
      );
      if (!cameras.length)
        throw Error(
          "No usable camera was found. Connect the USB camera, then try again.",
        );
      const selectedCamera =
        cameras.find((device) => device.deviceId === config.video_device) ||
        cameras[0];
      const microphoneGranted = permissionStream.getAudioTracks().length > 0;
      const selectedMicrophone = microphoneGranted
        ? microphones.find(
            (device) => device.deviceId === config.audio_device,
          ) || microphones[0]
        : undefined;
      const next: BrowserCamera = {
        ...config,
        video_device: selectedCamera.deviceId,
        camera_name: selectedCamera.label || "Camera",
        audio_device: selectedMicrophone?.deviceId || "",
      };
      setDevices(found);
      setConfig(next);
      permissionStream.getTracks().forEach((track) => track.stop());
      await showPreview(next);
      setMessage(
        selectedMicrophone
          ? "Live camera and microphone preview is ready. Record the test clip to confirm the saved video and audio."
          : "Live camera preview is ready. Microphone access was not granted, so this setup is currently video-only.",
      );
    } finally {
      permissionStream.getTracks().forEach((track) => track.stop());
    }
  }
  const transform = cameraTransform(config);
  function setFlip(
    field: "video_flip_horizontal" | "video_flip_vertical",
    enabled: boolean,
  ) {
    updatePreview({
      ...config,
      video_rotation: 0,
      [field]: enabled,
    });
  }
  return (
    <main className="shell admin-main">
      <section className="admin-card tablet-enrollment">
        <a href="/">← Player screen</a>
        <h1>Set up this tablet</h1>
        <p>Dink Vision · Browser recording</p>
        {!state ? (
          error && !busy ? (
            <button type="button" onClick={() => void run(refresh)}>Retry connection</button>
          ) : <p role="status">Loading registration…</p>
        ) : !state.enabled || reenrolling ? (
          <form
            className="stack-form"
            onSubmit={(e) => {
              e.preventDefault();
              const code = new FormData(e.currentTarget).get("code");
              void run(async () => {
                const r = await fetch("/api/tablet/enroll", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ code, replace: !!state.enabled }),
                });
                const d = await r.json();
                if (!r.ok) throw Error(d.error);
                await refresh();
                setReenrolling(false);
                window.history.replaceState(null, "", "/tablet/setup");
                setMessage(
                  state.enabled
                    ? "This browser is now registered with the new enrollment code. The previous registration has been revoked."
                    : "This browser is now registered.",
                );
              });
            }}
          >
            {state.enabled && (
              <div className="admin-callout" role="status">
                <strong>Already registered as {state.device.name}</strong>
                <p>
                  Enter a different enrollment code to replace this browser’s
                  current registration. This does not delete saved recording
                  logs.
                </p>
              </div>
            )}
            <label>
              Enrollment code
              <input
                name="code"
                required
                autoComplete="off"
                placeholder="Code from Devices & cameras"
              />
            </label>
            <button className="primary" disabled={busy}>
              {busy
                ? "Registering…"
                : state.enabled
                  ? "Replace registration"
                  : "Register this browser"}
            </button>
            {state.enabled && (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setReenrolling(false);
                  window.history.replaceState(null, "", "/tablet/setup");
                }}
              >
                Keep current registration
              </button>
            )}
            <p className="form-note">
              Create the code in the admin dashboard. Use this same browser for
              player mode.
            </p>
          </form>
        ) : (
          <>
            <section
              className="tablet-registration-summary"
              aria-label="Current tablet registration"
            >
              <div className="tablet-registration-status" role="status">
                <span aria-hidden="true" />
                Registered
              </div>
              <div className="tablet-registration-heading">
                <div>
                  <span className="tablet-registration-label">
                    This browser
                  </span>
                  <h2>{state.device.name}</h2>
                </div>
                <span
                  className={`status-tag${
                    state.device.tested_at ? " connected" : ""
                  }`}
                >
                  {state.device.tested_at ? "Ready" : "Camera setup needed"}
                </span>
              </div>
              <dl className="tablet-registration-details">
                <div>
                  <dt>Assigned court</dt>
                  <dd>
                    {state.courts[0]?.name ||
                      "Ask the administrator to assign a court"}
                  </dd>
                </div>
                <div>
                  <dt>Recording setup</dt>
                  <dd>
                    {state.device.tested_at
                      ? "Camera tested and ready"
                      : "Camera test still required"}
                  </dd>
                </div>
              </dl>
            </section>
            <section
              className="tablet-camera-guide"
              aria-labelledby="tablet-camera-guide-title"
            >
              <div className="tablet-camera-guide-heading">
                <span>Camera guide</span>
                <h3 id="tablet-camera-guide-title">
                  Choose the setup that matches your camera
                </h3>
              </div>
              <div className="tablet-camera-guide-grid">
                <article>
                  <span className="status-tag">Direct camera</span>
                  <h4>Wired USB / built-in camera</h4>
                  <ol>
                    <li>Connect the camera directly to this tablet or computer.</li>
                    <li>
                      Press <strong>Allow access & find cameras</strong>, then
                      allow camera and microphone access.
                    </li>
                    <li>Select the camera and microphone, then record the test clip.</li>
                  </ol>
                </article>
                <article>
                  <span className="status-tag connected">Android APK</span>
                  <h4>Wired USB / built-in Android camera</h4>
                  <ol>
                    <li>
                      In Admin → Devices & cameras, create the device, assign
                      its court, and generate an enrollment code.
                    </li>
                    <li>
                      Install the APK, open Device setup, enter the code, then
                      choose <strong>Wired USB / built-in Android camera</strong>.
                    </li>
                    <li>
                      Allow camera and microphone access. The APK prefers an
                      Android-compatible USB camera and otherwise uses the rear camera.
                    </li>
                  </ol>
                </article>
                <article>
                  <span className="status-tag connected">External Wi-Fi camera</span>
                  <h4>Tapo C210 through Android gateway</h4>
                  <ol>
                    <li>
                      In Admin → Devices & cameras, create the device, assign
                      its court, and generate an enrollment code.
                    </li>
                    <li>
                      In the Android APK, open Device setup, enter the code, and
                      choose <strong>Tapo Wi-Fi camera</strong>.
                    </li>
                    <li>
                      Enter the camera IP and Tapo Camera Account details on the
                      tablet. Keep both devices on the same local network.
                    </li>
                    <li>
                      The APK records the Tapo RTSP stream. It does not use the
                      Android device’s camera or microphone in this mode.
                    </li>
                  </ol>
                </article>
              </div>
              <div className="admin-callout">
                <div>
                  <strong>Where local recordings are kept</strong>
                  <p>
                    Browser/USB recordings use this website’s protected
                    IndexedDB storage named <code>casa-browser-recordings</code>;
                    browsers do not expose it as a normal folder. Use Download
                    local backup on the player screen to create a regular video
                    file in the browser’s Downloads folder or selected download
                    location.
                  </p>
                  <p>The Android APK uses this app-private directory:</p>
                  <code>
                    /data/user/0/com.casabatik.recorder/files/recordings/
                  </code>
                  <p>
                    Do not clear browser data, clear the Android app’s data, or
                    uninstall the APK while a recording is waiting.
                  </p>
                </div>
              </div>
            </section>
            {!state.canSetup ? (
              <p className="tablet-setup-expired">
                Setup access expired.{" "}
                <a href="/admin/login?next=/tablet/setup">
                  Sign in as an administrator
                </a>
                , then return here to configure the camera.
              </p>
            ) : (
              <form
                className="stack-form tablet-camera-setup"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    stopPreview();
                    await tabletRequest("configure", config);
                    const clip = await testCamera(
                      config,
                      video.current || undefined,
                    );
                    setTestClip(URL.createObjectURL(clip));
                    setTestHasAudio(!!config.audio_device);
                    setMessage(
                      config.audio_device
                        ? "Test clip ready. Play it below with the volume on, then confirm that video and audio are clear."
                        : "Test clip ready. Play it below, then confirm that the video is clear.",
                    );
                  }).catch(() => {});
                }}
              >
                <fieldset disabled={busy}>
                  <div className="tablet-connection-summary">
                    <span>Camera connection</span>
                    <strong>Wired USB / built-in camera</strong>
                    <small>
                      For Tapo C210 cameras, use Device setup in the Android
                      recorder instead.
                    </small>
                  </div>
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => void run(discover)}
                  >
                    Allow access & find cameras
                  </button>
                  <label>
                    Camera
                    <select
                      required
                      value={config.video_device}
                      onChange={(e) =>
                        updatePreview({
                          ...config,
                          video_device: e.target.value,
                          camera_name:
                            devices.find((d) => d.deviceId === e.target.value)
                              ?.label || "Camera",
                        })
                      }
                    >
                      <option value="">Choose a detected camera</option>
                      {config.video_device &&
                        !devices.some(
                          (d) => d.deviceId === config.video_device,
                        ) && (
                          <option value={config.video_device}>
                            {config.camera_name} (saved)
                          </option>
                        )}
                      {devices
                        .filter((d) => d.kind === "videoinput")
                        .map((d) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label || "Camera"}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Microphone
                    <select
                      value={config.audio_device}
                      onChange={(e) =>
                        updatePreview({
                          ...config,
                          audio_device: e.target.value,
                        })
                      }
                    >
                      <option value="">Off — video only</option>
                      {config.audio_device &&
                        !devices.some(
                          (d) => d.deviceId === config.audio_device,
                        ) && (
                          <option value={config.audio_device}>
                            Saved microphone
                          </option>
                        )}
                      {devices
                        .filter((d) => d.kind === "audioinput")
                        .map((d) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label || "Microphone"}
                          </option>
                        ))}
                    </select>
                  </label>
                  <section
                    className="camera-transform-panel"
                    aria-labelledby="camera-transform-title"
                  >
                    <div className="camera-transform-heading">
                      <div>
                        <span>Picture direction</span>
                        <strong id="camera-transform-title">
                          Flip the webcam picture
                        </strong>
                      </div>
                    </div>
                    <p>
                      Only use these when the live preview faces the wrong way.
                      The same picture will be saved in test clips and match
                      videos.
                    </p>
                    <div className="camera-flip-options">
                      <button
                        type="button"
                        className={`camera-flip-option${
                          transform.video_flip_horizontal ? " selected" : ""
                        }`}
                        aria-pressed={transform.video_flip_horizontal}
                        onClick={() =>
                          setFlip(
                            "video_flip_horizontal",
                            !transform.video_flip_horizontal,
                          )
                        }
                      >
                        <span>
                          <strong>Flip webcam left to right</strong>
                          <small>
                            Use this when the webcam picture looks mirrored.
                          </small>
                        </span>
                        <span className="camera-flip-state">
                          {transform.video_flip_horizontal ? "On" : "Off"}
                        </span>
                      </button>
                      <button
                        type="button"
                        className={`camera-flip-option${
                          transform.video_flip_vertical ? " selected" : ""
                        }`}
                        aria-pressed={transform.video_flip_vertical}
                        onClick={() =>
                          setFlip(
                            "video_flip_vertical",
                            !transform.video_flip_vertical,
                          )
                        }
                      >
                        <span>
                          <strong>Flip webcam up and down</strong>
                          <small>
                            Use this when the webcam is mounted upside down.
                          </small>
                        </span>
                        <span className="camera-flip-state">
                          {transform.video_flip_vertical ? "On" : "Off"}
                        </span>
                      </button>
                    </div>
                  </section>
                </fieldset>
                <video
                  ref={video}
                  muted
                  playsInline
                  aria-label="Live camera preview"
                  className="tablet-camera-preview"
                />
                {previewing && (
                  <p className="form-note" role="status">
                    Live preview · The saved test clip below will include audio
                    when a microphone is selected.
                  </p>
                )}
                <button className="primary" disabled={busy}>
                  {busy ? "Testing…" : "Record a 3-second test clip"}
                </button>
                {testClip && (
                  <section className="tablet-test-review" aria-label="Test recording review">
                    <h3>Review the saved test clip</h3>
                    <video
                      controls
                      playsInline
                      preload="metadata"
                      src={testClip}
                      className="tablet-camera-preview"
                    />
                    <p className="form-note">
                      {testHasAudio
                        ? "Turn the tablet volume up and confirm that court sounds or speech are clearly audible. The live preview is muted to prevent feedback; this saved test clip is not muted."
                        : "This configuration is video-only. Choose a microphone above and record another test if the final video should include sound."}
                    </p>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await tabletRequest("tested", { passed: true });
                          await refresh();
                          setMessage(
                            testHasAudio
                              ? "Video and audio confirmed. This tablet is ready for player mode."
                              : "Video confirmed. This tablet is ready in video-only mode.",
                          );
                        })
                      }
                    >
                      {testHasAudio
                        ? "I can see and hear the test"
                        : "The video looks clear"}
                    </button>
                  </section>
                )}
              </form>
            )}
            <div className="tablet-registration-actions">
              {state.device.tested_at && (
                <a className="primary" href="/">
                  Open player mode
                </a>
              )}
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setMessage("");
                  setError("");
                  setReenrolling(true);
                  window.history.replaceState(
                    null,
                    "",
                    "/tablet/setup?reenroll=1",
                  );
                }}
              >
                Register with another enrollment code
              </button>
            </div>
          </>
        )}
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <p className="form-note">
          Keep the tablet powered and awake with the recording tab open during matches. You can switch tabs without stopping recording.
          Camera access depends on the Android browser and hardware. Clearing
          browser data removes enrollment and locally saved videos.
        </p>
      </section>
    </main>
  );
}
