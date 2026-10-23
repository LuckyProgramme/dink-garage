import { assertCaptureVisible, watchCaptureVisibility } from "./capture-visibility";
import { inspectRecording } from "./recording-integrity";
import {
  cameraTransform,
  type CameraTransform,
} from "./camera-transform";

export type BrowserCamera = Partial<CameraTransform> & {
  source_type: "local";
  video_device: string;
  audio_device: string;
  camera_name: string;
};
const TEST_CLIP_DURATION_MS = 3000;
const CAMERA_OPEN_TIMEOUT_MS = 20_000;
// Give the encoder one final frame interval so a nominal three-second clip is
// not rounded down to two seconds by WebM/MP4 duration metadata.
export const ENCODER_FINAL_FRAME_MS = 250;
const MP4_RECORDING_TYPES = [
  // H.264 video with AAC audio gives Drive and browser playback the broadest
  // compatibility. The generic MP4 option lets the browser choose its best
  // MP4 codecs when a specific profile is unavailable.
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=avc1.4D0028,mp4a.40.2",
  "video/mp4",
];
export function recordingMime() {
  if (typeof MediaRecorder === "undefined")
    throw Error(
      "This browser does not support video recording. Use an updated Chrome browser.",
    );
  const mime = MP4_RECORDING_TYPES.find((m) =>
    MediaRecorder.isTypeSupported(m),
  );
  if (!mime)
    throw Error(
      "This browser cannot create MP4 recordings. Update Chrome or Edge, or use the Android recorder.",
    );
  return mime;
}
function verifyTracks(c: BrowserCamera, stream: MediaStream) {
  const video = stream.getVideoTracks().find((track) => track.readyState === "live");
  if (!video) throw Error("The selected camera did not provide live video.");
  video.enabled = true;
  if (c.audio_device) {
    const audio = stream
      .getAudioTracks()
      .find((track) => track.readyState === "live");
    if (!audio)
      throw Error(
        "The selected microphone did not provide audio. Choose another microphone and test again.",
      );
    audio.enabled = true;
  }
}

// Observe the original camera, including when a canvas is used for rotation.
// A canvas can keep emitting duplicates after the physical source has stalled.
function cameraProgress(raw: MediaStream) {
  if (typeof document.createElement !== "function")
    return { stalled: () => false, close: () => {} };
  const probe = document.createElement("video");
  probe.muted = true; probe.playsInline = true; probe.srcObject = raw;
  let lastFrame = performance.now(), callback = 0, closed = false, failed = false;
  const frame = () => {
    if (closed) return;
    lastFrame = performance.now();
    callback = probe.requestVideoFrameCallback(frame);
  };
  if (typeof probe.requestVideoFrameCallback === "function")
    callback = probe.requestVideoFrameCallback(frame);
  const visibility = () => {
    if (document.visibilityState === "visible") lastFrame = performance.now();
  };
  document.addEventListener("visibilitychange", visibility);
  void probe.play().catch(() => { failed = true; });
  return {
    stalled: () => failed || raw.getTracks().some(t => t.readyState !== "live" || t.muted)
      || (document.visibilityState === "visible"
        && typeof probe.requestVideoFrameCallback === "function"
        && performance.now() - lastFrame > 5000),
    close: () => {
      closed = true;
      document.removeEventListener("visibilitychange", visibility);
      if (callback) probe.cancelVideoFrameCallback(callback);
      probe.pause(); probe.srcObject = null;
    },
  };
}

async function transformedCamera(raw: MediaStream, selected: Partial<CameraTransform>) {
  // Chromium exposes the processor and generator on Window. Streams transfer
  // to a worker so tab visibility does not control the frame clock.
  const api = globalThis as typeof globalThis & {
    MediaStreamTrackProcessor?: new (options: { track: MediaStreamTrack }) => { readable: ReadableStream };
    MediaStreamTrackGenerator?: new (options: { kind: string }) => MediaStreamTrack & { writable: WritableStream };
  };
  if (!api.MediaStreamTrackProcessor || !api.MediaStreamTrackGenerator || typeof Worker === "undefined")
    throw Error("This browser cannot add the Dink Vision logo reliably. Use an updated Chrome or Edge browser.");
  const input = raw.getVideoTracks()[0];
  const processor = new api.MediaStreamTrackProcessor({ track: input });
  const output = new api.MediaStreamTrackGenerator({ kind: "video" });
  const worker = new Worker("/camera-transform-worker.js");
  let failed = false;
  const close = () => {
    worker.terminate();
    void processor.readable.cancel().catch(() => {});
    output.stop();
    raw.getTracks().forEach(track => track.stop());
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Camera transform did not produce video.")), 10000);
      worker.onerror = () => {
        failed = true;
        clearTimeout(timer);
        reject(Error("Camera transform worker failed."));
      };
      worker.onmessage = ({ data }) => {
        if (data.type === "error") {
          failed = true;
          clearTimeout(timer);
          reject(Error("Camera transform failed. Retry camera setup."));
        } else if (data.type === "frame") {
          clearTimeout(timer);
          resolve();
        }
      };
      try {
        worker.postMessage({ readable: processor.readable, writable: output.writable, transform: cameraTransform(selected) },
          [processor.readable, output.writable]);
      } catch (error) { clearTimeout(timer); reject(error); }
    });
    return { stream: new MediaStream([output, ...raw.getAudioTracks()]),
      stalled: () => failed || output.readyState !== "live" || input.readyState !== "live", close };
  } catch (error) { close(); throw error; }
}
export async function openCamera(
  c: BrowserCamera,
): Promise<{ stream: MediaStream; stalled: () => boolean; close: () => void }> {
  if (!window.isSecureContext)
    throw Error(
      "Open the tablet using HTTPS. Camera access is blocked on an insecure address.",
    );
  if (!navigator.mediaDevices?.getUserMedia)
    throw Error("Camera capture is unavailable in this browser.");
  const cameraRequest = navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: { exact: c.video_device },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 30 },
    },
    audio: c.audio_device
      ? {
          deviceId: { exact: c.audio_device },
          channelCount: { ideal: 2 },
          sampleRate: { ideal: 48000 },
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: true },
        }
      : false,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(
        Error(
          "Camera access did not open. Close old Dink Vision tabs, check the browser permission, and retry.",
        ),
      );
    }, CAMERA_OPEN_TIMEOUT_MS);
  });
  let stream: MediaStream;
  try {
    stream = await Promise.race([cameraRequest, timeout]);
  } catch (error) {
    if (timedOut)
      void cameraRequest
        .then((lateStream) =>
          lateStream.getTracks().forEach((track) => track.stop()),
        )
        .catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  try { verifyTracks(c, stream); }
  catch (error) { stream.getTracks().forEach(t => t.stop()); throw error; }
  const progress = cameraProgress(stream);
  try {
    // Every supported browser recording goes through the worker so the saved
    // video always includes the same Dink Vision mark as Android recordings.
    const camera = await transformedCamera(stream, c);
    return { stream: camera.stream, stalled: camera.stalled, close: () => { progress.close(); camera.close(); } };
  } catch (error) {
    progress.close();
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
}

export async function testCamera(c: BrowserCamera, preview?: HTMLVideoElement) {
  assertCaptureVisible();
  const mimeType = recordingMime();
  const camera = await openCamera(c);
  try {
    if (preview) {
      preview.srcObject = camera.stream;
      await preview.play();
    }
    const recorder = new MediaRecorder(camera.stream, {
      mimeType,
    });
    let startedAt = 0, endedAt = 0;
    const clip = await new Promise<Blob>((resolve, reject) => {
      const chunks: Blob[] = [];
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let startTimeout: ReturnType<typeof setTimeout> | undefined;
      let finalizationTimeout: ReturnType<typeof setTimeout> | undefined;
      const unwatchVisibility = watchCaptureVisibility(() => {
        clearTimers();
        if (recorder.state !== "inactive") recorder.stop();
        reject(Error("Camera test interrupted. Keep this page open and repeat the test."));
      });
      const clearTimers = () => {
        unwatchVisibility();
        if (stopTimer) clearTimeout(stopTimer);
        if (startTimeout) clearTimeout(startTimeout);
        if (finalizationTimeout) clearTimeout(finalizationTimeout);
      };
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.onerror = () => {
        clearTimers();
        reject(Error("Browser could not encode this camera."));
      };
      recorder.onstart = () => {
        if (startTimeout) clearTimeout(startTimeout);
        stopTimer = setTimeout(() => {
          if (recorder.state !== "inactive") {
            endedAt = performance.now();
            finalizationTimeout = setTimeout(() => {
              clearTimers();
              reject(
                Error(
                  "Camera recording finalization timed out. Reconnect the camera and repeat the test.",
                ),
              );
            }, 5000);
            recorder.stop();
          }
        }, Math.max(0, TEST_CLIP_DURATION_MS + ENCODER_FINAL_FRAME_MS - (performance.now() - startedAt)));
      };
      recorder.onstop = () => {
        clearTimers();
        const clip = new Blob(chunks, {
          type: recorder.mimeType || recordingMime().split(";")[0],
        });
        if (!clip.size) {
          reject(Error("The camera produced no video data."));
          return;
        }
        resolve(clip);
      };
      startTimeout = setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
        reject(Error("The browser did not start camera recording in time."));
      }, 5000);
      startedAt = performance.now();
      try {
        assertCaptureVisible();
        recorder.start(250);
      } catch (error) {
        clearTimers();
        reject(error);
      }
    });
    await inspectRecording(clip, Math.round((endedAt || performance.now()) - startedAt), camera.stream.getAudioTracks().length > 0);
    return clip;
  } finally {
    camera.close();
    if (preview) preview.srcObject = null;
  }
}
