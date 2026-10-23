import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import ffmpeg from "ffmpeg-static";
import onvif from "onvif";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";
const require = createRequire(import.meta.url);
const { Cam } = require("onvif/promises");
const ref = (prefix, value) =>
  `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

// Bound output and execution time; never send FFmpeg diagnostics or URLs to the cloud.
export function run(args, timeout = 15000) {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, args, {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const collect = (data) => {
      output = (output + data.toString()).slice(-65536);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, output: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, output });
    });
  });
}
export async function doctor() {
  return (await run(["-version"], 5000)).ok;
}
export function parseUsb(output, kind = "video") {
  const devices = [];
  let current;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/"([^"]+)" \((video|audio)\)/);
    const name = match?.[2] === kind ? match : null;
    if (name) {
      current = {
        name: name[1].slice(0, 100),
        source_type: "usb",
        input: name[1],
      };
      devices.push(current);
    } else if (/"[^"]+" \([^)]+\)/.test(line)) current = undefined;
    else {
      const alternative = line.match(/Alternative name "([^"]+)"/);
      if (alternative && current) current.input = alternative[1];
    }
  }
  return devices.map((device) => ({
    ...device,
    device_reference: ref(kind === "audio" ? "mic" : "usb", device.input),
  }));
}
export function cameraUrl(value, protocols) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !url.hostname || url.hash)
    throw new Error("Invalid camera address.");
  return url;
}
export function publicDevice(
  device,
  health = "unknown",
  diagnostic = "not_tested",
  audioSource = "",
) {
  return {
    device_reference: device.device_reference,
    name: device.name,
    source_type: device.source_type,
    health,
    diagnostic,
    audio_source: audioSource,
    audio_sources: (device.audio_sources || []).map(({ device_reference, name }) => ({ device_reference, name })),
  };
}
onvif.Discovery.on("error", () => {});
async function networkDevices(device) {
  return new Promise((resolve, reject) => {
    onvif.Discovery.probe(
      { resolve: false, timeout: 5000, device },
      (error, responses) => {
        if (error && !responses?.length)
          return reject(new Error("Network discovery unavailable."));
        const devices = [];
        for (const response of responses || []) {
          const match = response.probeMatches?.probeMatch;
          if (!match) continue;
          const endpoint = String(match.XAddrs || "")
            .split(/\s+/)
            .find((value) => /^https?:\/\//.test(value));
          if (!endpoint) continue;
          try {
            cameraUrl(endpoint, ["http:", "https:"]);
          } catch {
            continue;
          }
          const identity = match.endpointReference?.address || endpoint;
          const reference = ref("net", String(identity));
          // Do not forward camera-supplied scopes or URLs in display names.
          devices.push({
            device_reference: reference,
            name: `Network camera ${reference.slice(-6)}`,
            source_type: "network",
            endpoint,
          });
        }
        resolve(devices);
      },
    );
  });
}
export async function discover(existing) {
  if (process.platform !== "win32")
    throw new Error("USB discovery currently requires Windows.");
  const interfaces = Object.entries(networkInterfaces())
    .filter(([, addresses]) =>
      addresses?.some((a) => a.family === "IPv4" && !a.internal),
    )
    .map(([name]) => name);
  const [usb, scans] = await Promise.all([
    run(
      ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
      10000,
    ),
    Promise.allSettled(interfaces.map((name) => networkDevices(name))),
  ]);
  if (scans.some((result) => result.status === "rejected"))
    console.log(
      "Some network interfaces could not complete ONVIF discovery. USB and responding cameras are still listed.",
    );
  const network = scans.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const found = [
    ...parseUsb(usb.output).map(device => ({ ...device, audio_sources: parseUsb(usb.output, "audio") })),
    ...network,
    ...existing.filter((d) => d.manual),
  ];
  return mergeDevices(existing, found);
}
export function mergeDevices(existing, found) {
  // Keep local credentials through unplugging, temporary outages, and rescans.
  const unique = new Map(
    existing.map((device) => [
      device.device_reference,
      { ...device, present: false },
    ]),
  );
  for (const device of found) {
    const previous = unique.get(device.device_reference);
    unique.set(device.device_reference, {
      ...previous,
      ...device,
      name: previous?.name || device.name,
      present: true,
    });
  }
  if ([...unique.values()].filter((device) => device.present).length > 64)
    throw new Error("Discovery exceeds the 64-device safety limit.");
  return [...unique.values()];
}
export async function cameraInput(device, audioSource = "") {
  let input;
  if (device.source_type === "usb") {
    if (process.platform !== "win32") throw new Error("unsupported_platform");
    const microphone = audioSource && device.audio_sources?.find(d => d.device_reference === audioSource);
    if (audioSource && !microphone) throw new Error("device_missing");
    input = ["-f", "dshow", "-i", `video=${device.input}${microphone ? ":audio=" + microphone.input : ""}`];
  } else {
    let stream = device.stream;
    if (!stream && device.endpoint && device.username !== undefined) {
      const endpoint = cameraUrl(device.endpoint, ["http:", "https:"]);
      const cam = new Cam({
        hostname: endpoint.hostname,
        port: Number(
          endpoint.port || (endpoint.protocol === "https:" ? 443 : 80),
        ),
        useSecure: endpoint.protocol === "https:",
        path: endpoint.pathname,
        username: device.username,
        password: device.password,
        timeout: 5000,
      });
      await cam.connect();
      const media = await cam.getStreamUri({ protocol: "RTSP" });
      stream = media.uri;
    }
    if (!stream) throw new Error("needs_configuration");
    const uri = cameraUrl(stream, ["rtsp:", "rtsps:"]);
    if (device.username) {
      uri.username = device.username;
      uri.password = device.password || "";
    }
    input = ["-rtsp_transport", "tcp", "-i", uri.href];
  }
  return input;
}
export async function testDevice(device, ffmpegAvailable, audioSource = "") {
  if (!ffmpegAvailable)
    return publicDevice(device, "offline", "ffmpeg_missing", audioSource);
  try {
    const input = await cameraInput(device, audioSource);
    const result = await run([
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      ...input,
      "-map", "0:v:0",
      ...(audioSource ? ["-map", "0:a:0", "-t", "2"] : ["-an", "-frames:v", "1"]),
      "-f",
      "null",
      "-",
    ]);
    return publicDevice(
      device,
      result.ok ? "online" : "offline",
      result.ok ? "connected" : "unreachable",
      audioSource,
    );
  } catch (error) {
    if (error.message === "needs_configuration")
      return publicDevice(device, "needs_configuration", "needs_configuration", audioSource);
    if (error.message === "unsupported_platform")
      return publicDevice(device, "offline", "unsupported_platform", audioSource);
    return publicDevice(device, "offline", "unreachable", audioSource);
  }
}
