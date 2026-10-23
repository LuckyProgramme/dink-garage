import test from "node:test";
import assert from "node:assert/strict";
import { cameraInput, settingsInput, uuid, bool } from "../lib/validation";

test("settings reject invalid limits, fractional values, and invalid time zones", () => {
  for (const value of [0, 121, 1.5, "15", null])
    assert.throws(() =>
      settingsInput({
        duration_minutes: value,
        retention_hours: 24,
        venue_time_zone: "Asia/Manila",
      }),
    );
  assert.throws(() =>
    settingsInput({
      duration_minutes: 15,
      retention_hours: 0,
      venue_time_zone: "Asia/Manila",
    }),
  );
  assert.throws(() =>
    settingsInput({
      duration_minutes: 15,
      retention_hours: 24,
      venue_time_zone: "Not/AZone",
    }),
  );
  const result = settingsInput({
    duration_minutes: 15,
    retention_hours: 24,
    venue_time_zone: "Asia/Manila",
  });
  assert.equal(result.max_duration_seconds, 900);
  assert.equal(result.retention_seconds, 86400);
});
test("camera registration rejects connection secrets and invalid assignments", () => {
  const valid = {
    name: "Court camera",
    recorder_id: "30000000-0000-4000-8000-000000000001",
    court_id: "20000000-0000-4000-8000-000000000001",
    source_type: "network",
    device_reference: "garden-01",
    is_primary: true,
    enabled: true,
  };
  assert.equal(cameraInput(valid).device_reference, "garden-01");
  assert.equal(cameraInput(valid).audio_source, "");
  assert.equal(cameraInput({...valid, audio_source: "stream"}).audio_source, "stream");
  assert.throws(() => cameraInput({...valid, source_type: "usb", audio_source: "stream"}));
  assert.throws(() => cameraInput({...valid, audio_source: "file:///private"}));
  assert.throws(() =>
    cameraInput({
      ...valid,
      device_reference: "rtsp://user:password@host/feed",
    }),
  );
  assert.throws(() => cameraInput({ ...valid, court_id: "" }));
  assert.throws(() => cameraInput({ ...valid, enabled: "true" }));
  assert.throws(() => uuid("not-an-id"));
  assert.throws(() => bool(1));
});
