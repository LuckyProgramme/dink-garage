export class InputError extends Error {}
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function uuid(value: unknown) {
  if (typeof value !== "string" || !uuidPattern.test(value))
    throw new InputError("Choose a valid item.");
  return value;
}
export function text(value: unknown, label: string, max = 100) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw new InputError(`${label} must be between 1 and ${max} characters.`);
  return value.trim();
}
export function bool(value: unknown) {
  if (typeof value !== "boolean")
    throw new InputError("Invalid on/off setting.");
  return value;
}
export function integer(
  value: unknown,
  min: number,
  max: number,
  label: string,
) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new InputError(
      `${label} must be a whole number between ${min} and ${max}.`,
    );
  return value;
}
export function settingsInput(body: Record<string, unknown>) {
  const zone = text(body.venue_time_zone, "Venue time zone", 80);
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  } catch {
    throw new InputError("Enter a valid IANA time zone, such as Asia/Manila.");
  }
  return {
    max_duration_seconds:
      integer(body.duration_minutes, 1, 120, "Duration") * 60,
    retention_seconds:
      integer(body.retention_hours, 1, 720, "Retention") * 3600,
    venue_time_zone: zone,
    updated_at: new Date().toISOString(),
  };
}
export function cameraInput(body: Record<string, unknown>) {
  const source = body.source_type;
  if (source !== "network" && source !== "usb")
    throw new InputError("Choose network or USB.");
  const reference = text(body.device_reference, "Device reference", 120);
  if (!/^[a-zA-Z0-9._:-]+$/.test(reference) || reference.includes("://"))
    throw new InputError(
      "Use a local device identifier, not a stream URL or password.",
    );
  const audio = body.audio_source == null ? "" : String(body.audio_source);
  if (audio && !(source === "network" ? audio === "stream" : /^mic-[a-f0-9]{24}$/.test(audio)))
    throw new InputError("Choose a discovered microphone or network stream audio.");
  const court = body.court_id ? uuid(body.court_id) : null;
  const primary = bool(body.is_primary);
  if (primary && !court)
    throw new InputError("Assign a court before selecting a primary camera.");
  return {
    name: text(body.name, "Camera name"),
    recorder_id: uuid(body.recorder_id),
    court_id: court,
    device_reference: reference,
    source_type: source,
    audio_source: audio,
    is_primary: primary,
    enabled: bool(body.enabled),
  };
}
