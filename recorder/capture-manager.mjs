import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const worker = fileURLToPath(new URL("./capture-worker.mjs", import.meta.url));
export async function syncCaptures(home, config, api) {
  const { jobs } = await api(config, "captures", { action: "sync" });
  for (const job of jobs) {
    if (!/^[0-9a-f-]{36}$/.test(job.session_id))
      throw new Error("Invalid session identifier");
    const dir = join(home, "captures", job.session_id),
      manifest = join(dir, "state.json");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let record;
    try {
      record = JSON.parse(await readFile(manifest, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      record = {
        job,
        state: "starting",
        reason: "running",
        bytes: 0,
        createdAt: Date.now(),
      };
      // Exclusive creation is the durable at-most-once launch marker.
      await writeFile(manifest, JSON.stringify(record), {
        flag: "wx",
        mode: 0o600,
      });
      if (!job.stop_requested) {
        const child = spawn(process.execPath, [worker, home, job.session_id], {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        });
        child.on("error", () => {});
        child.unref();
      } else {
        record = { ...record, state: "failed", reason: "interrupted" };
      }
    }
    if (job.stop_requested)
      await writeFile(join(dir, "stop"), "stop", { mode: 0o600 });
    if (!["local_ready", "failed"].includes(record.state)) {
      const overdue =
        Date.now() >
        Date.parse(job.claimed_at) + job.max_seconds * 1000 + 60000;
      if (overdue) {
        let alive = false;
        if (record.workerPid)
          try {
            process.kill(record.workerPid, 0);
            alive = true;
          } catch (error) {
            if (error.code !== "ESRCH") alive = true;
          }
        if (!alive && record.spawnAttempted) {
          // A crashed worker can leave FFmpeg behind. Missing child identity is
          // ambiguous, so keep the lock until an operator can verify shutdown.
          if (!record.ffmpegPid) alive = true;
          else
            try {
              process.kill(record.ffmpegPid, 0);
              alive = true;
            } catch (error) {
              if (error.code !== "ESRCH") alive = true;
            }
        }
        // Fail closed while a worker or orphaned FFmpeg could still hold the camera.
        if (!alive)
          record = {
            ...record,
            state: "failed",
            reason: "interrupted",
            bytes: (
              await stat(join(dir, "video.mp4")).catch(() => ({ size: 0 }))
            ).size,
          };
      }
    }
    if (record.state !== "starting")
      await api(config, "captures", {
        action: "report",
        id: job.session_id,
        token: job.claim_token,
        state: record.state,
        reason: record.reason,
        bytes: record.bytes || 0,
      });
  }
  return jobs.length > 0;
}
