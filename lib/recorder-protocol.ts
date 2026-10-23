import { createHash } from "node:crypto";
import { bool, InputError, text, uuid } from "./validation";
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export function inventoryInput(value: unknown) {
  if (!Array.isArray(value) || value.length > 64)
    throw new InputError("Invalid device inventory.");
  const references = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object")
      throw new InputError("Invalid device.");
    const reference = text(item.device_reference, "Device reference", 120);
    if (!/^[a-zA-Z0-9._:-]+$/.test(reference) || references.has(reference))
      throw new InputError("Invalid or repeated device reference.");
    references.add(reference);
    if (
      !["usb", "network"].includes(item.source_type) ||
      !["unknown", "online", "offline", "needs_configuration"].includes(
        item.health,
      ) ||
      ![
        "not_tested",
        "connected",
        "unreachable",
        "needs_configuration",
        "ffmpeg_missing",
        "device_missing",
        "unsupported_platform",
      ].includes(item.diagnostic)
    )
      throw new InputError("Invalid device status.");
    return {
      device_reference: reference,
      name: text(item.name, "Device name"),
      source_type: item.source_type as string,
      health: item.health as string,
      diagnostic: item.diagnostic as string,
      audio_sources: audioSources(item.audio_sources),
      audio_source: typeof item.audio_source === "string" && /^(stream|mic-[a-f0-9]{24})?$/.test(item.audio_source) ? item.audio_source : "",
    };
  });
}
export function completionInput(body: Record<string, unknown>) {
  return {
    id: uuid(body.id),
    lease: uuid(body.lease_token),
    success: bool(body.success),
    devices: inventoryInput(body.devices),
  };
}

function audioSources(value: unknown) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 64) throw new InputError("Invalid microphones.");
  return value.map(item => {
    if (!item || !/^mic-[a-f0-9]{24}$/.test(item.device_reference)) throw new InputError("Invalid microphone.");
    return { device_reference: item.device_reference as string, name: text(item.name, "Microphone name") };
  });
}
