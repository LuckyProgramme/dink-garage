import { encryptSecret } from "./google-crypto";
import { InputError } from "./validation";

export function rtspCameraHost(address: unknown) {
  const value = String(address ?? "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "rtsp:" ? url.hostname : "";
  } catch {
    return value;
  }
}

function validIpv4(value: string) {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    )
  );
}

export function tabletCameraFields(
  body: Record<string, unknown>,
  previous: Record<string, any> = {},
) {
  const mode = String(
    body.recorder_mode ?? previous.recorder_mode ?? "browser",
  );
  if (!["browser", "android_camera", "android_rtsp"].includes(mode))
    throw new InputError("Choose a valid recorder type.");
  if (mode === "browser")
    return {
      recorder_mode: mode,
      ...(previous.recorder_mode !== "browser"
        ? {
            rtsp_url: "",
            rtsp_username: "",
            rtsp_password_encrypted: null,
            video_device: "",
            audio_device: "",
            tested_at: null,
            camera_name: "",
          }
        : {}),
    };
  if (mode === "android_camera")
    return {
      recorder_mode: "android_rtsp",
      rtsp_url: "",
      rtsp_username: "",
      rtsp_password_encrypted: null,
      camera_name: "Android USB / built-in camera",
      source_type: "local",
      video_device: "android-camera-v1",
      audio_device: "device-microphone",
      stream_url: "",
    };
  const host =
    body.rtsp_host !== undefined
      ? String(body.rtsp_host).trim()
      : rtspCameraHost(body.rtsp_url ?? previous.rtsp_url);
  if (!validIpv4(host))
    throw new InputError(
      "Enter only the camera IP address, for example 192.168.1.100.",
    );
  const address = `rtsp://${host}:554/stream1`;
  const name = String(body.camera_name ?? previous.camera_name ?? "").trim();
  const user = String(
    body.rtsp_username ?? previous.rtsp_username ?? "",
  ).trim();
  const password = String(body.rtsp_password ?? "");
  if (
    !name ||
    name.length > 100 ||
    !user ||
    user.length > 100 ||
    password.length > 256
  )
    throw new InputError("Enter a camera name and Camera Account username.");
  const encrypted = password
    ? encryptSecret(password)
    : previous.rtsp_password_encrypted;
  if (!encrypted) throw new InputError("Enter the Camera Account password.");
  return {
    recorder_mode: mode,
    rtsp_url: address,
    rtsp_username: user,
    rtsp_password_encrypted: encrypted,
    camera_name: name,
    source_type: "local",
    video_device: "android-rtsp-v2",
    // Android records the RTSP audio track whenever the camera supplies one.
    audio_device: "camera-audio",
    stream_url: "",
  };
}

export function nativeTabletCameraFields(
  body: Record<string, unknown>,
  previous: Record<string, any> = {},
) {
  const mode = String(body.recorder_mode || "");
  if (!["android_camera", "android_rtsp"].includes(mode))
    throw new InputError("Choose this tablet camera or a Tapo Wi-Fi camera.");
  return tabletCameraFields(body, previous);
}
