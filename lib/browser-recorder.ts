import { assertCaptureVisible, watchCaptureVisibility, CAPTURE_HIDDEN_MESSAGE } from "./capture-visibility";
import {
  ENCODER_FINAL_FRAME_MS,
  openCamera,
  recordingMime,
  type BrowserCamera,
} from "./browser-media";
import {
  saveMeta,
  getMeta,
  saveChunk,
  savedVideo,
  savedVideoRange,
  removeVideo,
  removeVideoData,
  listMeta,
  patchMeta,
  type LocalRecording,
} from "./browser-storage";
import { inspectRecording, RecordingIntegrityError } from "./recording-integrity";
export async function tabletRequest(
  action: string,
  fields: Record<string, unknown> = {},
) {
  const r = await fetch("/api/tablet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...fields }),
    signal: AbortSignal.timeout(60000),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "Tablet request failed.");
  return d;
}
type Config = BrowserCamera & { id: string };
function queuedUploadMessage(queue: any) {
  const uploader =
    [queue?.activeCourt, queue?.activeDevice].filter(Boolean).join(" · ") ||
    "Another device";
  const place =
    queue?.position > 0 && queue?.total > 1
      ? ` Your video is ${queue.position} of ${queue.total} in the queue.`
      : "";
  return queue?.blocked
    ? `Upload queue paused. ${uploader} must retry its saved video first.${place}`
    : `${uploader} is ahead of you in the upload queue. Progress: ${Math.max(0, Number(queue?.percent || 0))}%.${place}`;
}

class UploadCancelledError extends Error {}
class LocalOnlyRecordingError extends Error {}

export class BrowserCapture {
  private startup?: { cancelled: boolean };
  private recorder?: MediaRecorder;
  private finishCapture?: () => void;
  private forceStop?: (reason: string) => void;
  private releaseLock?: () => void;
  private wake?: WakeLockSentinel;
  private stopping = false;
  private stopIssued = false;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private captureStart = 0;
  private captureEnd = 0;
  public activeId: string | null = null;
  public startedAt = 0;
  constructor(
    private message: (s: string) => void,
    private changed: (event?: "started" | "queued" | "short" | "progress") => void,
  ) {}
  dispose() {
    if (this.startup) this.startup.cancelled = true;
    if (this.activeId || this.recorder) this.stop(true);
    else this.finishCapture?.();
  }
  private async releaseCompletedCaptures(deviceId: string) {
    const ready = (await listMeta())
      .filter(
        (item) =>
          item.deviceId === deviceId &&
          item.complete &&
          !item.interrupted &&
          item.localAvailable !== false &&
          item.captureReleased !== true &&
          ["saved_locally", "pending", "retrying", "uploading", undefined].includes(
            item.status,
          ),
      )
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const item of ready) {
      try {
        await tabletRequest("captured", { id: item.id });
        await patchMeta(item.id, { captureReleased: true });
      } catch {
        // The local copy remains authoritative. A later start, queue pass, or
        // final `saved` transition retries this idempotently.
      }
    }
  }
  async start(
    config: Config,
    emails: string[],
    key: string,
    maxSeconds: number,
    beforeRecording?: () => Promise<void>,
  ) {
    this.finishCapture = undefined;
    if (this.startup || this.activeId || this.recorder)
      throw Error("Finish the current recording before starting another match.");
    if (!navigator.locks)
      throw Error("An updated browser with Web Locks support is required.");
    const startup = { cancelled: false };
    this.startup = startup;
    try {
      await new Promise<void>((resolve, reject) => {
        void navigator.locks
          .request(
            `casa-tablet-recorder-v2:${config.id}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) {
                reject(
                  Error(
                    "Another Dink Vision tab is using this device. Close the old tab or reload it, then retry.",
                  ),
                );
                return;
              }
              await new Promise<void>((release) => {
                this.releaseLock = release;
                void this.capture(
                  config,
                  emails,
                  key,
                  maxSeconds,
                  startup,
                  beforeRecording,
                ).then(
                  resolve,
                  (e) => {
                    release();
                    reject(e);
                  },
                );
              });
            },
          )
          .catch(reject);
      });
    } finally {
      if (this.startup === startup) this.startup = undefined;
    }
  }
  private async capture(
    config: Config,
    emails: string[],
    key: string,
    maxSeconds: number,
    startup: { cancelled: boolean },
    beforeRecording?: () => Promise<void>,
  ) {
    const estimate = await navigator.storage?.estimate();
    const needed = maxSeconds * 500000 + 25_000_000;
    if (estimate?.quota && estimate.quota - (estimate.usage || 0) < needed)
      throw Error(
        "Not enough browser storage for this match. Free storage before recording.",
      );
    await navigator.storage?.persist?.();
    // Release a previous locally durable capture before asking the server for
    // another session. Its upload continues independently.
    await this.releaseCompletedCaptures(config.id);
    const camera = await openCamera(config);
    if (startup.cancelled) {
      camera.close();
      throw Error("Recording start was cancelled because the page was closed.");
    }
    let sid: string | undefined;
    let aborted = false;
    let failureReport: Promise<unknown> | null = null;
    const reportFailed = () => {
      if (!sid) return Promise.resolve();
      failureReport ??= tabletRequest("failed", { id: sid });
      return failureReport;
    };
    try {
      const mime = recordingMime();
      const recorder = new MediaRecorder(camera.stream, {
        mimeType: mime,
        videoBitsPerSecond: 3_000_000,
        audioBitsPerSecond: 128000,
      });
      const result = await tabletRequest("start", { emails, key });
      sid = result.id;
      if (startup.cancelled)
        throw Error("Recording start was cancelled because the page was closed.");
      const id = sid!;
      const meta: LocalRecording = {
        id,
        jobId: id,
        mime: mime.split(";")[0],
        complete: false,
        interrupted: false,
        createdAt: Date.now(),
        deviceId: config.id,
        expectAudio: !!config.audio_device,
        courtId: (config as Config & { court_id?: string }).court_id,
        status: "saved_locally",
        progress: 0,
        retryCount: 0,
        localAvailable: true,
      };
      await saveMeta(meta);
      this.activeId = id;
      this.recorder = recorder;
      this.stopping = false;
      this.stopIssued = false;
      let write = Promise.resolve(),
        index = 0,
        bytes = 0,
        storageFailed = false,
        interrupted = false;
      let firstResolve: () => void = () => {},
        firstReject: (e: Error) => void = () => {};
      const first = new Promise<void>((resolve, reject) => {
        firstResolve = resolve;
        firstReject = reject;
      });
      // The encoder can fail before startup has finished awaiting `started`.
      // Observe this promise immediately so that early camera failures do not
      // become an unhandled rejection while cleanup is still in progress.
      void first.catch(() => {});
      let startedResolve: () => void = () => {},
        startedReject: (e: Error) => void = () => {};
      const started = new Promise<void>((resolve, reject) => {
        startedResolve = resolve;
        startedReject = reject;
      });
      void started.catch(() => {});
      let timeout: ReturnType<typeof setTimeout> | undefined,
        limit: ReturnType<typeof setTimeout> | undefined;
      let watchdog: ReturnType<typeof setInterval> | undefined;
      let lastChunkAt = performance.now();
      let interruptionReason: string | undefined;
      let cleaned = false;
      let finalizeStop: (forcedReason?: string) => void = () => {};
      const unload = (e: BeforeUnloadEvent) => {
        e.preventDefault();
        e.returnValue = "";
      };
      window.addEventListener("beforeunload", unload);
      const resumed = () => {
        if (document.visibilityState === "visible") lastChunkAt = performance.now();
      };
      document.addEventListener("visibilitychange", resumed);
      const unwatchVisibility = watchCaptureVisibility(() => {
        if (cleaned) return;
        interrupted = true;
        interruptionReason = CAPTURE_HIDDEN_MESSAGE;
        this.message(interruptionReason);
        // Do not wait for a timer or another rendered frame in a hidden page.
        this.stop(true);
      });
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (timeout) clearTimeout(timeout);
        if (limit) clearTimeout(limit);
        if (watchdog) clearInterval(watchdog);
        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTimer = undefined;
        window.removeEventListener("beforeunload", unload);
        unwatchVisibility();
        document.removeEventListener("visibilitychange", resumed);
        camera.close();
        void this.wake?.release();
        this.activeId = null;
        this.startedAt = 0;
        this.recorder = undefined;
        this.finishCapture = undefined;
        if (this.forceStop === finalizeStop) this.forceStop = undefined;
        const releaseLock = this.releaseLock;
        this.releaseLock = undefined;
        releaseLock?.();
      };
      this.finishCapture = cleanup;
      recorder.ondataavailable = (e) => {
        if (!e.data.size) return;
        bytes += e.data.size;
        lastChunkAt = performance.now();
        const n = index++;
        write = write
          .then(async () => {
            if (storageFailed) return;
            await saveChunk(id, n, e.data);
            firstResolve();
          })
          .catch(() => {
            storageFailed = true;
            interrupted = true;
            firstReject(Error("Local storage could not save the video."));
            this.message(
              "Local storage failed. The recording has stopped; recover available footage.",
            );
            this.stop(true);
          });
      };
      recorder.onerror = () => {
        interrupted = true;
        startedReject(Error("Camera recording could not start."));
        firstReject(Error("Camera recording was interrupted."));
        this.stop(true);
      };
      recorder.onstart = () => {
        lastChunkAt = this.captureStart;
        watchdog = setInterval(() => {
          if (this.stopping) return;
          const unavailable = camera.stalled();
          if (unavailable || (document.visibilityState === "visible" && performance.now() - lastChunkAt > 15_000)) {
            interrupted = true;
            this.message("Camera capture stalled or was suspended. Saving available footage; keep this page visible.");
            this.stop(true);
          }
        }, 1000);
        startedResolve();
      };
      camera.stream.getTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          if (!this.stopping) {
            interrupted = true;
            this.message("Camera disconnected. Saving available footage.");
            this.stop(true);
          }
        }),
      );
      finalizeStop = (forcedReason?: string) => {
        // A late stop event from a failed encoder must not clean up a newer
        // recording that has already reclaimed the same BrowserCapture.
        if (cleaned) return;
        if (forcedReason) {
          interrupted = true;
          interruptionReason = forcedReason;
        }
        if (!this.stopping) {
          interrupted = true;
          this.message(
            "The browser stopped recording unexpectedly. Saving the available local footage.",
          );
        }
        // Freeze capture time before storage writes or encoder finalization.
        const endedAt = this.captureEnd || performance.now();
        void (async () => {
          await write;
          const durationMs = this.startedAt
            ? Math.round(Math.max(0, endedAt - this.captureStart))
            : undefined;
          await saveMeta({
            ...meta,
            complete: true,
            interrupted: interrupted || storageFailed || aborted,
            durationMs,
            bytes,
            status: interrupted || storageFailed || aborted ? "failed" : "saved_locally",
            captureReleased: false,
            lastError: interrupted || storageFailed || aborted ? interruptionReason || "Recording was interrupted." : undefined,
          });
          cleanup();
          if (!index) {
            firstReject(Error("Camera did not save any video."));
            await reportFailed();
            throw Error("Camera did not save any video.");
          }
          if (interrupted || storageFailed || aborted) {
            await reportFailed();
            this.message(
              interruptionReason || (durationMs !== undefined && durationMs >= 60_000
                ? "Recording interrupted after one minute. A local backup was saved. Use Recover / retry upload to send the available footage."
                : "Recording interrupted. Available footage remains saved locally, but clips under one minute are not uploaded."),
            );
            this.changed("progress");
            return;
          }
          const shortRecording = durationMs !== undefined && durationMs < 60_000;
          this.message(
            shortRecording
              ? "Recording saved locally. Clips under 1 minute are not uploaded or emailed."
              : "Recording saved. Checking video and preparing upload...",
          );
          this.changed(shortRecording ? "short" : "queued");
          void this.releaseCompletedCaptures(config.id).finally(
            () => void this.processQueue(config.id),
          );
        })().catch((e) => {
          cleanup();
          this.message(
            e instanceof Error ? e.message : "Upload needs recovery.",
          );
          this.changed();
        });
      };
      this.forceStop = finalizeStop;
      recorder.onstop = () => finalizeStop();
      try {
        this.wake = await navigator.wakeLock?.request("screen");
      } catch {
        this.message(
          "Keep this tablet awake and this page open during recording.",
        );
      }
      await beforeRecording?.();
      if (this.stopping || startup.cancelled) throw Error("Recording start was cancelled.");
      timeout = setTimeout(() => {
        interrupted = true;
        startedReject(Error("Camera produced no video."));
        firstReject(Error("Camera produced no video."));
        this.stop(true);
      }, 15000);
      // The start event can arrive after the encoder has already captured frames.
      this.startedAt = Date.now();
      this.captureStart = performance.now();
      this.captureEnd = 0;
      assertCaptureVisible();
      recorder.start(1000);
      await started;
      limit = setTimeout(
        () => this.stop(),
        Math.max(0, maxSeconds * 1000 - ENCODER_FINAL_FRAME_MS - (performance.now() - this.captureStart)),
      );
      await tabletRequest("started", { id });
      this.changed("started");
      await first;
      clearTimeout(timeout);
    } catch (e) {
      aborted = true;
      if (sid)
        await patchMeta(sid, {
          status: "failed",
          interrupted: true,
          lastError:
            e instanceof Error ? e.message : "Recording was interrupted.",
        }).catch(() => {});
      if (this.recorder && this.recorder.state !== "inactive")
        this.stop(true);
      else {
        camera.close();
        this.finishCapture?.();
      }
      await reportFailed().catch(() => {});
      throw e;
    }
  }
  stop(immediate = false) {
    if (this.stopIssued) return;
    if (this.stopping && !(immediate && this.stopTimer)) return;
    this.stopping = true;
    const finish = () => {
      if (this.stopIssued) return;
      this.stopIssued = true;
      this.captureEnd = performance.now();
      this.stopTimer = undefined;
      if (this.activeId)
        void tabletRequest("stopped", { id: this.activeId }).catch(() => {});
      if (this.recorder && this.recorder.state !== "inactive") {
        const recorder = this.recorder;
        try {
          recorder.stop();
          if (this.recorder === recorder && this.forceStop)
            this.stopTimer = setTimeout(
              () => this.forceStop?.("The browser did not finish stopping the video. Available footage was preserved."),
              10_000,
            );
        } catch {
          this.forceStop?.("The browser could not finish stopping the video. Available footage was preserved.");
        }
      }
    };
    if (immediate || !this.recorder || this.recorder.state !== "recording") {
      if (this.stopTimer) clearTimeout(this.stopTimer);
      finish();
      return;
    }
    try {
      this.recorder.requestData();
    } catch {}
    this.stopTimer = setTimeout(finish, ENCODER_FINAL_FRAME_MS);
  }
  async upload(id: string, deviceId: string, retryCancelled = false) {
    if (!navigator.locks)
      throw Error("This browser cannot safely coordinate uploads.");
    await navigator.locks.request(
      "casa-tablet-upload",
      { mode: "exclusive" },
      async (lock) => {
        if (!lock)
          throw Error(
            "Another tab is recording or uploading. Return to that tab.",
          );
        let lastError: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await this.uploadAttempt(id, deviceId, retryCancelled);
            return;
          } catch (e) {
            lastError = e;
            if (
              e instanceof UploadCancelledError ||
              e instanceof LocalOnlyRecordingError || e instanceof RecordingIntegrityError
            )
              break;
            if (attempt === 2) break;
            this.message("Upload interrupted. Retrying saved video…");
            await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          }
        }
        if (lastError instanceof RecordingIntegrityError) {
          await patchMeta(id, {
            status: "failed",
            lastError: lastError.message,
            serverRetryRequired: true,
            nextRetryAt: undefined,
          });
          this.changed("progress");
        }
        if (
          !(lastError instanceof UploadCancelledError) &&
          !(lastError instanceof LocalOnlyRecordingError)
        ) {
          await tabletRequest("upload-failed", {
            id,
            validation_failed: lastError instanceof RecordingIntegrityError,
            last_error: lastError instanceof Error ? lastError.message : "Upload paused on this device.",
          }).catch(() => {});
          // Clear recording state after upload failure to prevent interruption on next recording
          await patchMeta(id, {
            status: "failed",
            lastError: lastError instanceof Error ? lastError.message : "Upload paused on this device.",
            serverRetryRequired: false,
            nextRetryAt: undefined,
          }).catch(() => {});
        }
        throw lastError;
      },
    );
  }
  async processQueue(deviceId: string, requestedRetries: string[] = []) {
    if (!navigator.locks || !deviceId) return;
    await this.releaseCompletedCaptures(deviceId);
    let localRecordings = await listMeta();
    const requested = new Set(requestedRetries);
    const resumable = localRecordings.filter(
      (item) =>
        requested.has(item.id) &&
        item.deviceId === deviceId &&
        item.status === "failed" &&
        item.complete &&
        !item.interrupted &&
        item.localAvailable !== false,
    );
    if (resumable.length) {
      await Promise.all(
        resumable.map((item) =>
          patchMeta(item.id, {
            status: "pending",
            retryCount: 0,
            serverRetryRequired: true,
            lastError: undefined,
            nextRetryAt: undefined,
          }),
        ),
      );
      this.changed("progress");
      localRecordings = await listMeta();
    }
    await Promise.all(
      localRecordings
        .filter(
          (item) =>
            item.deviceId === deviceId &&
            item.status === "failed" &&
            (item.interrupted || !item.complete),
        )
        .map((item) =>
          tabletRequest("failed", { id: item.id }).catch(() => undefined),
        ),
    );
    await navigator.locks.request(
      "casa-tablet-upload",
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          setTimeout(() => void this.processQueue(deviceId), 300);
          return;
        }
        while (true) {
          const now = Date.now();
          const next = (await listMeta())
            .filter(
              (item) =>
                item.deviceId === deviceId &&
                item.complete &&
                !item.interrupted &&
                item.localAvailable !== false &&
                ["saved_locally", "pending", "uploading", "retrying", undefined].includes(item.status) &&
                (item.nextRetryAt || 0) <= now,
            )
            .sort((a, b) => a.createdAt - b.createdAt)[0];
          if (!next) return;
          try {
            const retryServerQueue =
              next.serverRetryRequired === true ||
              (next.retryCount || 0) > 0 ||
              next.status === "retrying";
            await patchMeta(next.id, {
              status: retryServerQueue ? "retrying" : "uploading",
              lastError: undefined,
            });
            this.changed("progress");
            await this.uploadAttempt(next.id, deviceId, retryServerQueue);
          } catch (error) {
            if (error instanceof LocalOnlyRecordingError || error instanceof UploadCancelledError) {
              await patchMeta(next.id, {
                status: "failed",
                lastError: error.message,
                nextRetryAt: undefined,
              });
              this.changed("progress");
              continue;
            }
            const retries = (next.retryCount || 0) + 1;
            const terminal = retries >= 8 || error instanceof RecordingIntegrityError;
            const delay = Math.min(15 * 60_000, 5_000 * 2 ** Math.min(retries - 1, 7));
            await patchMeta(next.id, {
              status: terminal ? "failed" : "retrying",
              retryCount: retries,
              serverRetryRequired: true,
              lastError: error instanceof Error ? error.message : "Upload temporarily unavailable.",
              nextRetryAt: terminal ? undefined : Date.now() + delay + Math.floor(Math.random() * Math.max(1000, delay / 4)),
            });
            await tabletRequest("upload-failed", {
              id: next.id,
              retrying: !terminal,
              validation_failed: error instanceof RecordingIntegrityError,
              retry_count: retries,
              last_error: error instanceof Error ? error.message : "Upload temporarily unavailable.",
            }).catch(() => {});
            this.changed("progress");
            if (!terminal) return;
          }
        }
      },
    );
  }
  async retry(id: string, deviceId: string) {
    await patchMeta(id, {
      status: "pending",
      retryCount: 0,
      serverRetryRequired: true,
      lastError: undefined,
      nextRetryAt: undefined,
    });
    this.changed("progress");
    await this.processQueue(deviceId);
  }
  private async waitForUploadTurn(id: string, firstAction = "upload") {
    let prepared = await tabletRequest(firstAction, { id });
    while (prepared.queued) {
      if (prepared.queue?.state === "cancelled")
        throw new UploadCancelledError(
          "Upload cancelled by venue staff. Your video remains saved on this device. Choose Recover / retry upload when ready.",
        );
      if (prepared.queue?.state === "failed")
        throw new Error(
          "Upload paused after a connection problem. Automatic retry is scheduled.",
        );
      this.message(queuedUploadMessage(prepared.queue));
      this.changed();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      prepared = await tabletRequest("upload", { id });
    }
    return prepared;
  }
  private async uploadAttempt(
    id: string,
    deviceId: string,
    retryCancelled = false,
  ) {
    const meta = await getMeta(id);
    if (!meta || meta.deviceId !== deviceId)
      throw Error(
        "No saved video was found in this browser. Ask the administrator to review the interrupted session.",
      );
    const blob = await savedVideo(id, meta.mime);
    if (!blob.size) throw Error("No video chunks were saved.");
    if (meta.mime.split(";")[0].trim().toLowerCase() === "video/mp4") {
      this.message("Checking recording timing…");
      await inspectRecording(blob, meta.durationMs, meta.expectAudio);
    }
    let total = Number(meta.bytes || 0);
    if (!total) total = blob.size;
    this.message("Preparing saved video…");
    const saved = await tabletRequest("saved", {
      id,
      bytes: total,
      mime: meta.mime,
      duration_ms: meta.durationMs === undefined
        ? undefined
        : Math.round(meta.durationMs),
    });
    if (saved.localOnly && saved.reason === "unsupported_format")
      throw new LocalOnlyRecordingError(
        "This older WebM recording was not uploaded. It remains in this browser’s protected site storage. Download the local backup below; new recordings use MP4.",
      );
    if (saved.localOnly)
      throw new LocalOnlyRecordingError(
        "This clip is under one minute, so it was not uploaded. It remains in this browser’s protected site storage. Download a local backup below if you need a normal video file.",
      );
    this.changed();
    let prepared = await this.waitForUploadTurn(
      id,
      retryCancelled ? "retry-upload" : "upload",
    );
    if (!prepared.ready) {
      let offset = 0,
        restarts = 0;
      while (offset < total) {
        const status = await tabletRequest("upload-status", { id });
        if (status.uploaded) break;
        if (status.expired) {
          if (restarts++ > 1)
            throw Error("Upload session expired. Retry upload.");
          prepared = await this.waitForUploadTurn(id, "restart-upload");
          if (prepared.ready) break;
          offset = 0;
          continue;
        }
        offset = status.offset;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > total)
          throw Error("Invalid upload progress.");
        const end = Math.min(offset + 4 * 1024 * 1024, total);
        const chunk = await savedVideoRange(id, offset, end);
        if (chunk.size !== end - offset) throw Error("Saved video data is incomplete.");
        const r = await fetch(
          `/api/tablet/upload-chunk?id=${encodeURIComponent(id)}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": meta.mime,
              "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
            },
            body: chunk,
            signal: AbortSignal.timeout(60000),
          },
        );
        const result = await r.json().catch(() => ({}));
        if (!r.ok)
          throw Error(
            result.error ||
              "Upload interrupted. Saved video remains on this tablet; retry upload.",
          );
        if (result.expired) {
          if (restarts++ > 1)
            throw Error("Upload session expired. Retry upload.");
          prepared = await this.waitForUploadTurn(id, "restart-upload");
          if (prepared.ready) break;
          offset = 0;
          continue;
        }
        offset = end;
        await patchMeta(id, {
          status: "uploading",
          progress: Math.round((offset / total) * 100),
          serverUploadReference: id,
        });
        this.changed("progress");
        this.message(
          `Uploading video… ${Math.round((offset / total) * 100)}%`,
        );
      }
    }
    const finished = await tabletRequest("finish", { id });
    if (!finished.ready)
      throw Error("Upload is still being confirmed. The local backup is kept and will retry.");
    await removeVideoData(id);
    await patchMeta(id, {
      status: "uploaded",
      progress: 100,
      localAvailable: false,
      serverRetryRequired: false,
      lastError: undefined,
      nextRetryAt: undefined,
    });
    this.message("");
    this.changed();
  }
}
