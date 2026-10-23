import { readFile, writeFile, rename, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cameraInput } from "./hardware.mjs";
import { captureVideo } from "./capture-engine.mjs";
const home = resolve(process.argv[2]),
  id = process.argv[3];
if (!/^[0-9a-f-]{36}$/.test(id || "")) throw new Error("Invalid capture ID");
const directory = join(home, "captures", id),
  manifest = join(directory, "state.json"),
  video = join(directory, "video.mp4");
let record = JSON.parse(await readFile(manifest, "utf8"));
async function save(changes) {
  record = {
    ...record,
    ...changes,
    workerPid: process.pid,
    updatedAt: Date.now(),
  };
  await writeFile(manifest + ".tmp", JSON.stringify(record), { mode: 0o600 });
  await rename(manifest + ".tmp", manifest);
}
try {
  await save({ state: "starting", reason: "running" });
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
  const device = config.devices.find(
    (d) => d.device_reference === record.job.device_reference,
  );
  if (!device) throw new Error("device_missing");
  const disk = await statfs(directory);
  if (disk.bavail * disk.bsize < 512 * 1024 * 1024)
    throw new Error("storage_full");
  const input = await cameraInput(device, record.job.audio_source || "");
  const remaining = Math.floor(
    (Date.parse(record.job.claimed_at) +
      record.job.max_seconds * 1000 -
      Date.now()) /
      1000,
  );
  if (remaining <= 0) throw new Error("interrupted");
  await save({ spawnAttempted: true });
  const result = await captureVideo({
    input,
    audio: !!record.job.audio_source,
    video,
    maxSeconds: remaining,
    stopPath: join(directory, "stop"),
    onState: save,
  });
  await save(result);
} catch (error) {
  await save({
    state: "failed",
    reason: ["device_missing", "storage_full", "interrupted"].includes(
      error.message,
    )
      ? error.message
      : "capture_error",
    bytes: (await stat(video).catch(() => ({ size: 0 }))).size,
  });
}
