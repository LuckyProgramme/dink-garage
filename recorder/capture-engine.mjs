import { access, stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { run } from "./hardware.mjs";

// Same engine is exercised with synthetic video in tests and real devices in the worker.
export async function captureVideo({
  input,
  audio = false,
  audioMap = "0:a:0",
  video,
  maxSeconds,
  stopPath,
  onState,
}) {
  const started = Date.now();
  let stopping = false,
    finished = false,
    reason = "capture_error",
    forced = false,
    frames = 0,
    lastFrame = Date.now(),
    watchdog;
  const child = spawn(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      ...input,
      "-map",
      "0:v:0",
      ...(audio ? ["-map", audioMap, "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-af", "aresample=async=1"] : ["-an"]),
      "-t",
      String(maxSeconds),
      "-vf",
      "scale=w=min(1280\\,iw):h=-2",
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "25",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "60",
      "-movflags",
      "+frag_keyframe+empty_moov+default_base_moof",
      "-progress",
      "pipe:1",
      "-n",
      video,
    ],
    { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.on("error", () => {});
  let progress = "",
    writes = Promise.resolve();
  const notify = (state) => {
    writes = writes.then(() => onState(state));
    return writes;
  };
  function stop(why) {
    if (stopping || finished) return;
    stopping = true;
    reason = why;
    notify({ state: "finalizing", reason }).catch(() => {});
    child.stdin.write("q\n", () => {});
    watchdog = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
    }, 10000);
  }
  child.stdout.on("data", (chunk) => {
    progress = (progress + chunk.toString()).slice(-4096);
    const entries = [...progress.matchAll(/frame=(\d+)/g)];
    if (entries.length) {
      const count = Number(entries.at(-1)[1]);
      if (count > frames) {
        const first = frames === 0;
        frames = count;
        lastFrame = Date.now();
        if (first && !stopping)
          notify({ state: "recording", reason: "running" }).catch(() =>
            stop("capture_error"),
          );
      }
    }
  });
  notify({ ffmpegPid: child.pid || null }).catch(() => stop("capture_error"));
  child.stderr.resume();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || stopping) return;
    checking = true;
    try {
      if (Date.now() - started >= maxSeconds * 1000) stop("time_limit");
      else if (Date.now() - lastFrame > 20000) stop("capture_error");
      else {
        try {
          await access(stopPath);
          stop("player_stop");
        } catch {}
        const free = await statfs(dirname(video));
        if (free.bavail * free.bsize < 128 * 1024 * 1024) stop("storage_full");
      }
    } catch {
      stop("capture_error");
    } finally {
      checking = false;
    }
  }, 250);
  const code = await new Promise((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", resolve);
  });
  finished = true;
  clearInterval(timer);
  clearTimeout(watchdog);
  await writes;
  await onState({ state: "finalizing", reason });
  const bytes = (await stat(video).catch(() => ({ size: 0 }))).size;
  const readable =
    bytes > 0 &&
    (
      await run(
        [
          "-nostdin",
          "-v",
          "error",
          "-i",
          video,
          "-frames:v",
          "1",
          "-f",
          "null",
          "-",
        ],
        15000,
      )
    ).ok;
  if (
    !stopping &&
    code === 0 &&
    Date.now() - started >= (maxSeconds - 1) * 1000
  )
    reason = "time_limit";
  const complete =
    code === 0 &&
    !forced &&
    readable &&
    frames > 0 &&
    ["player_stop", "time_limit"].includes(reason);
  return {
    state: complete ? "local_ready" : "failed",
    reason: complete
      ? reason
      : ["capture_error", "storage_full"].includes(reason)
        ? reason
        : "interrupted",
    bytes,
  };
}
