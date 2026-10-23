import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  open,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  doctor,
  discover,
  testDevice,
  publicDevice,
  cameraUrl,
} from "./hardware.mjs";
import { randomUUID } from "node:crypto";
import { syncCaptures } from "./capture-manager.mjs";
import { uploadLoop } from "./drive-upload.mjs";
import { emailLoop } from "./email-delivery.mjs";
import { cleanupLoop } from "./cleanup.mjs";

const home = resolve(process.env.CASA_RECORDER_HOME || ".local/recorder");
const configPath = join(home, "config.json");
async function save(path, value) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
async function load(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new Error("Local configuration is invalid.");
  }
}
async function secureHome() {
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const who = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const sid = who.stdout?.match(/S-1-5-[\d-]+/)?.[0];
    if (!sid) throw new Error("Cannot identify the Windows recorder account.");
    const acl = spawnSync(
      "icacls",
      [
        home,
        "/inheritance:r",
        "/grant:r",
        `*${sid}:(OI)(CI)F`,
        "*S-1-5-18:(OI)(CI)F",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    if (acl.status !== 0)
      throw new Error("Cannot protect the recorder configuration directory.");
  }
}
async function ask(question, secret = false) {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: process.stdin.isTTY,
  });
  const answer = rl.question(question);
  muted = secret;
  try {
    return (await answer).trim();
  } finally {
    muted = false;
    rl.close();
    if (secret) process.stdout.write("\n");
  }
}
function appUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error(
      "Use an HTTPS app origin, or HTTP localhost for development.",
    );
  return url.origin;
}
async function api(config, path, body, authenticated = true) {
  const response = await fetch(`${config.url}/api/recorder/${path}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(["uploads","emails","cleanup"].includes(path) ? 60000 : 12000),
    headers: {
      "Content-Type": "application/json",
      ...(authenticated ? { Authorization: `Bearer ${config.token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = new Error(`Server returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}
async function lock() {
  const path = join(home, "agent.lock");
  try {
    const file = await open(path, "wx", 0o600);
    await file.writeFile(String(process.pid));
    await file.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(path, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error(
        "Invalid recorder lock. Remove it after checking for running services.",
      );
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        await unlink(path);
        return lock();
      }
      throw error;
    }
    throw new Error(
      "A recorder command is already running. Stop it before configuring devices.",
    );
  }
  return () => unlink(path).catch(() => {});
}
async function main() {
  const command = process.argv[2] || "help";
  if (command === "help") {
    console.log(
      "Wrenlabs Pickleball Camera recorder (Windows)\nCommands: doctor, pair, discover, configure [device-reference], start\nRun from the repository directory. Configuration stays in .local/recorder.",
    );
    return;
  }
  if (command === "doctor") {
    console.log(
      `Platform: ${process.platform}; FFmpeg: ${(await doctor()) ? "ready" : "unavailable"}`,
    );
    return;
  }
  await secureHome();
  const unlock = await lock();
  try {
    const config = await load(configPath, { devices: [] });
    if (command === "pair") {
      const url = appUrl(
        await ask("App origin (e.g. http://localhost:3000): "),
      );
      const code = await ask("One-time pairing code: ", true);
      if (!/^cbpair_[A-Za-z0-9_-]{43}$/.test(code))
        throw new Error("Invalid pairing code.");
      const paired = await api({ url }, "pair", { code }, false);
      await save(configPath, {
        ...config,
        url,
        token: paired.token,
        recorderId: paired.recorderId,
      });
      await unlink(join(home, "completion.json")).catch(() => {});
      console.log("Paired. Run npm run recorder -- start to connect.");
      return;
    }
    if (command === "discover") {
      if (!(await doctor()))
        throw new Error("FFmpeg is unavailable. Run npm install again.");
      config.devices = await discover(config.devices);
      await save(configPath, config);
      console.table(
        config.devices
          .filter((device) => device.present !== false)
          .map((device) => publicDevice(device)),
      );
      return;
    }
    if (command === "configure") {
      let device = config.devices.find(
        (d) => d.device_reference === process.argv[3],
      );
      if (process.argv[3] && !device)
        throw new Error("Device not found. Run discovery first.");
      if (device?.source_type === "usb")
        throw new Error("USB cameras need no credentials.");
      if (!device) {
        device = {
          device_reference: `net-${randomUUID()}`,
          source_type: "network",
          manual: true,
        };
        config.devices.push(device);
      }
      device.name =
        (await ask("Camera name: ")).slice(0, 100) || "Network camera";
      const stream = await ask(
        "RTSP address (blank to use discovered ONVIF): ",
        true,
      );
      if (stream) {
        device.stream = cameraUrl(stream, ["rtsp:", "rtsps:"]).href;
        device.manual = true;
      }
      if (!device.stream && !device.endpoint)
        throw new Error("An RTSP address is required for a manual camera.");
      device.username = await ask("Camera username (blank if none): ");
      device.password = await ask("Camera password (blank if none): ", true);
      await save(configPath, config);
      console.log(
        "Saved locally. Start the service, then discover and test in the admin dashboard.",
      );
      return;
    }
    if (command !== "start")
      throw new Error("Unknown command. Run npm run recorder -- help.");
    if (!config.token || !config.url)
      throw new Error("Pair this recorder first.");
    appUrl(config.url);
    const available = await doctor();
    console.log(
      "Recorder running. Waiting for admin discovery/test commands. Ctrl+C stops the service.",
    );
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    const pendingPath = join(home, "completion.json");
    const uploads = uploadLoop(home, config, api, () => stopping);
    const emails = emailLoop(config, api, () => stopping);
    const cleanup = cleanupLoop(home, config, api, () => stopping);
    try {
      while (!stopping) {
        try {
          const capturing = await syncCaptures(home, config, api);
          const pending = await load(pendingPath, null);
          if (pending) {
            try {
              await api(config, "complete", pending);
            } catch (error) {
              if (error.status !== 409) throw error;
            }
            await unlink(pendingPath);
          }
          const { command: job } = await api(config, "poll", {
            platform: process.platform,
            version: "0.4.0",
            ffmpeg_available: available,
            capturing,
          });
          if (job) {
            let devices = [];
            let success = true;
            try {
              if (job.kind === "discover") {
                if (!available) throw new Error("FFmpeg missing.");
                config.devices = await discover(config.devices);
                await save(configPath, config);
                devices = config.devices
                  .filter((device) => device.present !== false)
                  .map((device) => publicDevice(device));
              } else if (job.kind === "test") {
                const device = config.devices.find(
                  (d) => d.device_reference === job.device_reference,
                );
                if (!device)
                  throw new Error("Device missing. Rediscover cameras.");
                devices = [await testDevice(device, available, job.audio_source || "")];
              } else throw new Error("Unsupported command.");
            } catch {
              success = false;
            }
            await save(pendingPath, {
              id: job.id,
              lease_token: job.lease_token,
              success,
              devices,
            });
            console.log(
              `${job.kind === "discover" ? "Discovery" : "Connection test"} ${success ? "completed" : "failed"}; sending result.`,
            );
            continue;
          }
        } catch (error) {
          if (error.status === 401)
            throw new Error(
              "Pairing was revoked. Pair again from the dashboard.",
            );
          console.log("Server unavailable. Retrying shortly.");
        }
        await delay(2000);
      }
    } finally {
      stopping = true;
      await uploads;
      await emails;
      await cleanup;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    await unlock();
  }
}
main().catch((error) => {
  console.error(
    error.message?.startsWith("Server returned")
      ? error.message
      : error instanceof TypeError
        ? "Connection or configuration failed."
        : error.message,
  );
  process.exitCode = 1;
});
