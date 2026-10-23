import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import "fake-indexeddb/auto";
import {
  saveMeta,
  saveChunk,
  getMeta,
  savedVideo,
  removeVideo,
} from "../lib/browser-storage";
import { BrowserCapture } from "../lib/browser-recorder";
import { recordingMime } from "../lib/browser-media";
import {
  cameraTransform,
  DEFAULT_CAMERA_TRANSFORM,
  validCameraTransform,
} from "../lib/camera-transform";
const validClip = readFileSync(new URL("./fixtures/recording-one-second.mp4", import.meta.url));

test("camera flips normalize and validate saved settings", () => {
  assert.deepEqual(cameraTransform(undefined), DEFAULT_CAMERA_TRANSFORM);
  assert.equal(
    validCameraTransform({
      video_rotation: 90,
      video_flip_horizontal: true,
      video_flip_vertical: false,
    }),
    true,
  );
  assert.equal(validCameraTransform({ video_rotation: 45 }), false);
  assert.equal(
    validCameraTransform({ video_flip_horizontal: "yes" }),
    false,
  );
});

test("browser recording selects MP4 and never falls back to WebM", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "MediaRecorder");
  try {
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: {
        isTypeSupported: (mime: string) =>
          mime === "video/mp4" || mime === "video/webm",
      },
    });
    assert.equal(recordingMime(), "video/mp4");
    Object.defineProperty(globalThis, "MediaRecorder", {
      configurable: true,
      value: {
        isTypeSupported: (mime: string) => mime === "video/webm",
      },
    });
    assert.throws(() => recordingMime(), /cannot create MP4 recordings/);
  } finally {
    if (previous)
      Object.defineProperty(globalThis, "MediaRecorder", previous);
    else Reflect.deleteProperty(globalThis, "MediaRecorder");
  }
});

test("browser chunks survive a new reader and deleting one recording preserves another", async () => {
  await saveMeta({
    id: "first",
    deviceId: "tablet-1",
    mime: "video/webm",
    complete: false,
    interrupted: false,
    createdAt: Date.now(),
  });
  await saveChunk("first", 0, new Blob(["header"]));
  await saveChunk("first", 1, new Blob(["frames"]));
  await saveChunk("second", 0, new Blob(["other video"]));
  assert.equal((await getMeta("first"))?.complete, false);
  assert.equal(
    await (await savedVideo("first", "video/webm")).text(),
    "headerframes",
  );
  await removeVideo("first");
  assert.equal(await getMeta("first"), undefined);
  assert.equal(
    await (await savedVideo("second", "video/webm")).text(),
    "other video",
  );
  await removeVideo("second");
});

test("browser uploader resumes from Google offset and deletes local video only after server confirmation", async () => {
  const originalFetch = globalThis.fetch,
    nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: string[] = [];
  let complete = false;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          fn: (lock: object) => Promise<void>,
        ) => fn({}),
      },
    },
  });
  await saveMeta({
    id: "upload-test",
    deviceId: "tablet-1",
    mime: "video/mp4",
    complete: true,
    interrupted: false,
    createdAt: Date.now(),
  });
  await saveChunk("upload-test", 0, new Blob([validClip]));
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/tablet") {
      const b = JSON.parse(String(init?.body));
      calls.push(b.action);
      if (b.action === "upload") return Response.json({ ready: false });
      if (b.action === "upload-status") return Response.json({ offset: 4 });
      if (b.action === "finish") {
        assert.equal((await savedVideo("upload-test", "video/mp4")).size, validClip.length);
        complete = true;
        return Response.json({ ready: true });
      }
      return Response.json({ ok: true });
    }
    assert.equal(url, "/api/tablet/upload-chunk?id=upload-test");
    const range = (init?.headers as Record<string, string>)["Content-Range"];
    calls.push(range);
    assert.equal(range, `bytes 4-${validClip.length - 1}/${validClip.length}`);
    assert.deepEqual(Buffer.from(await (init!.body as Blob).arrayBuffer()), validClip.subarray(4));
    return Response.json({ id: "drive-file" });
  };
  try {
    await new BrowserCapture(
      () => {},
      () => {},
    ).upload("upload-test", "tablet-1");
    assert.equal(complete, true);
    const uploaded = await getMeta("upload-test");
    assert.equal(uploaded?.status, "uploaded");
    assert.equal(uploaded?.localAvailable, false);
    assert.equal((await savedVideo("upload-test", "video/mp4")).size, 0);
    assert.deepEqual(calls, [
      "saved",
      "upload",
      "upload-status",
      `bytes 4-${validClip.length - 1}/${validClip.length}`,
      "finish",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("invalid recording timing blocks upload and preserves local footage", async () => {
  const originalFetch = globalThis.fetch;
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name: string, _options: unknown, fn: (lock: object) => Promise<void>) => fn({}) } },
  });
  await saveMeta({ id: "invalid-timing", deviceId: "tablet-1", mime: 'video/mp4;codecs="avc1.42E01E"',
    complete: true, interrupted: false, createdAt: Date.now(), durationMs: 30000 });
  await saveChunk("invalid-timing", 0, new Blob([validClip]));
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.action);
    assert.equal(body.validation_failed, true);
    assert.match(body.last_error, /timing does not match/);
    return Response.json({ ok: true });
  };
  try {
    await assert.rejects(new BrowserCapture(() => {}, () => {}).upload("invalid-timing", "tablet-1"), /timing does not match/);
    assert.deepEqual(calls, ["upload-failed"]);
    assert.equal((await savedVideo("invalid-timing", "video/mp4")).size, validClip.length);
    assert.equal((await getMeta("invalid-timing"))?.status, "failed");
  } finally {
    await removeVideo("invalid-timing");
    globalThis.fetch = originalFetch;
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("a failed browser capture releases its server recording lock after reconnecting", async () => {
  const originalFetch = globalThis.fetch;
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          fn: (lock: object) => Promise<void>,
        ) => fn({}),
      },
    },
  });
  await saveMeta({
    id: "failed-capture",
    deviceId: "tablet-1",
    mime: "video/mp4",
    complete: false,
    interrupted: true,
    createdAt: Date.now(),
    status: "failed",
    lastError: "Camera disconnected.",
  });
  globalThis.fetch = async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)).action);
    return Response.json({ ok: true });
  };
  try {
    await new BrowserCapture(() => {}, () => {}).processQueue("tablet-1");
    assert.deepEqual(calls, ["failed"]);
  } finally {
    await removeVideo("failed-capture");
    globalThis.fetch = originalFetch;
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("background upload reopens a failed server queue without the admin dashboard", async () => {
  const originalFetch = globalThis.fetch;
  const nav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const calls: string[] = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (
          _name: string,
          _options: unknown,
          fn: (lock: object) => Promise<void>,
        ) => fn({}),
      },
    },
  });
  await saveMeta({
    id: "background-retry",
    deviceId: "tablet-remote",
    mime: "video/mp4",
    complete: true,
    interrupted: false,
    createdAt: Date.now(),
    status: "failed",
    retryCount: 8,
    serverRetryRequired: true,
    durationMs: 1000.75,
  });
  await saveChunk("background-retry", 0, new Blob([validClip]));
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/tablet");
    const body = JSON.parse(String(init?.body));
    calls.push(body.action);
    if (body.action === "saved") {
      assert.equal(body.duration_ms, 1001, "older browser durations are rounded before server validation");
      assert.equal(Number.isSafeInteger(body.duration_ms), true);
    }
    if (body.action === "retry-upload")
      return Response.json({ ready: false, queued: false });
    if (body.action === "upload-status")
      return Response.json({ uploaded: true });
    if (body.action === "finish")
      return Response.json({ ready: true });
    return Response.json({ ok: true });
  };
  try {
    await new BrowserCapture(() => {}, () => {}).processQueue(
      "tablet-remote",
      ["background-retry"],
    );
    assert.deepEqual(calls, [
      "saved",
      "retry-upload",
      "upload-status",
      "finish",
    ]);
    const completed = await getMeta("background-retry");
    assert.equal(completed?.status, "uploaded");
    assert.equal(completed?.localAvailable, false);
  } finally {
    await removeVideo("background-retry");
    globalThis.fetch = originalFetch;
    if (nav) Object.defineProperty(globalThis, "navigator", nav);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

for (const hidden of [false, true]) test(`browser capture ${hidden ? "continues recording across tab switches" : "uploads a visible recording"}`, async () => {
  const names = ["navigator", "window", "document", "MediaRecorder", "MediaStream", "MediaStreamTrackProcessor", "MediaStreamTrackGenerator", "Worker"] as const;
  const old = new Map(
    names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]),
  );
  const originalFetch = globalThis.fetch;
  const events: string[] = [];
  const sequence: string[] = [];
  const lockNames: string[] = [];
  const documentListeners = new Map<string, () => void>();
  const documentMock = {
    visibilityState: "visible",
    addEventListener(name: string, listener: () => void) {
      documentListeners.set(name, listener);
    },
    removeEventListener(name: string) {
      documentListeners.delete(name);
    },
  };
  let held = false,
    visibilityFlushes = 0,
    doneResolve: () => void = () => {};
  const done = new Promise<void>((r) => (doneResolve = r));
  const videoTrack = {
    kind: "video",
    readyState: "live",
    enabled: true,
    stop() {},
    addEventListener() {},
  };
  const audioTrack = {
    kind: "audio",
    readyState: "live",
    enabled: true,
    stop() {},
    addEventListener() {},
  };
  const mediaStream = {
    getTracks: () => [videoTrack, audioTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
  };
  class OutputTrack {
    kind = "video"; readyState = "live"; writable = {};
    stop(){this.readyState="ended";}
    addEventListener(){}
  }
  class Processor { readable={cancel:async()=>{}}; }
  class Stream {
    constructor(private tracks: Array<typeof audioTrack|OutputTrack>){}
    getTracks(){return this.tracks;}
    getVideoTracks(){return this.tracks.filter(track=>track.kind==="video");}
    getAudioTracks(){return this.tracks.filter(track=>track.kind==="audio");}
  }
  class LogoWorker {
    onerror?:()=>void;onmessage?:(event:{data:{type:string}})=>void;
    postMessage(){queueMicrotask(()=>this.onmessage?.({data:{type:"frame"}}));}
    terminate(){}
  }
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    ondataavailable: any;
    onstart: any;
    onstop: any;
    onerror: any;
    constructor(stream: typeof mediaStream) {
      assert.equal(stream.getVideoTracks().length, 1);
      assert.equal(
        stream.getAudioTracks().length,
        1,
        "the selected microphone is included in the recorded stream",
      );
    }
    start() {
      sequence.push("recording-started");
      this.state = "recording";
      setTimeout(() => {
        this.onstart();
        setTimeout(() => this.ondataavailable({ data: new Blob([validClip]) }), 10);
      }, 300);
    }
    stop() {
      this.state = "inactive";
      setTimeout(() => this.onstop(), 0);
    }
    requestData() {
      visibilityFlushes++;
      this.ondataavailable({ data: new Blob([validClip]) });
    }
  }
  const navigatorMock = {
    storage: {
      estimate: async () => ({ quota: 1000000000, usage: 0 }),
      persist: async () => true,
    },
    mediaDevices: {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        assert.notEqual(constraints.audio, false);
        return mediaStream;
      },
    },
    locks: {
      request: async (
        name: string,
        o: any,
        fn: (l: object | null) => Promise<void>,
      ) => {
        lockNames.push(name);
        if (held && o.ifAvailable) return fn(null);
        while (held) await new Promise((r) => setTimeout(r, 1));
        held = true;
        try {
          await fn({});
        } finally {
          held = false;
        }
      },
    },
  };
  for (const [n, value] of Object.entries({
    navigator: navigatorMock,
    window: {
      isSecureContext: true,
      addEventListener() {},
      removeEventListener() {},
    },
    document: documentMock,
    MediaRecorder: Recorder,
    MediaStream: Stream,
    MediaStreamTrackProcessor: Processor,
    MediaStreamTrackGenerator: OutputTrack,
    Worker: LogoWorker,
  }))
    Object.defineProperty(globalThis, n, { configurable: true, value });
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "/api/tablet");
    const b = JSON.parse(String(init?.body));
    events.push(b.action);
    if (b.action === "start") return Response.json({ id: "capture-test" });
    if (b.action === "started")
      assert.equal(
        (await savedVideo("capture-test", "video/mp4")).size,
        0,
        "the server timestamp starts with the recorder, not one chunk later",
      );
    if (["upload", "finish"].includes(b.action)) return Response.json({ ready: true });
    return Response.json({ ok: true });
  };
  try {
    const recorder = new BrowserCapture(
      () => {},
      () => {
        if (events.includes("finish")) doneResolve();
      },
    );
    await recorder.start(
      {
        id: "tablet-1",
        source_type: "local",
        video_device: "camera",
        audio_device: "microphone",
        camera_name: "Test camera",
      },
      ["one@gmail.com", "two@gmail.com", "three@gmail.com", "four@gmail.com"],
      "key",
      60,
      async () => {
        sequence.push("countdown-complete");
      },
    );
    assert.equal(lockNames[0], "casa-tablet-recorder-v2:tablet-1");
    assert.deepEqual(sequence, ["countdown-complete", "recording-started"]);
    assert.deepEqual(events, ["start", "started"]);
    if (hidden) {
      documentMock.visibilityState = "hidden";
      documentListeners.get("visibilitychange")?.();
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(recorder.activeId, "capture-test");
      assert.deepEqual(events, ["start", "started"], "tab switching must not stop capture");
      documentMock.visibilityState = "visible";
      documentListeners.get("visibilitychange")?.();
    }
    recorder.stop();
    await done;
    assert.deepEqual(events, [
      "start",
      "started",
      "stopped",
      "captured",
      "saved",
      "upload",
      "finish",
    ]);
    const uploaded = await getMeta("capture-test");
    assert.equal(Number.isSafeInteger(uploaded?.durationMs), true,
      "capture saves whole milliseconds accepted by the server");
    assert.ok((uploaded?.durationMs || 0) >= 500, "capture includes time before the delayed start event");
    assert.equal(uploaded?.status, "uploaded");
    assert.equal(uploaded?.localAvailable, false);
    assert.equal(uploaded?.captureReleased, true);
  } finally {
    await removeVideo("capture-test");
    globalThis.fetch = originalFetch;
    for (const n of names) {
      const value = old.get(n);
      if (value) Object.defineProperty(globalThis, n, value);
      else Reflect.deleteProperty(globalThis, n);
    }
  }
});
