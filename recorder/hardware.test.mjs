import test from "node:test";
import assert from "node:assert/strict";
import {
  parseUsb,
  cameraUrl,
  publicDevice,
  mergeDevices,
} from "./hardware.mjs";
test("DirectShow parser keeps duplicate camera names distinct and excludes microphones", () => {
  const devices = parseUsb(
    '[dshow] "Webcam" (video)\n[dshow] Alternative name "@device_1"\n[dshow] "Webcam" (video)\n[dshow] Alternative name "@device_2"\n[dshow] "Microphone" (audio)\n[dshow] Alternative name "@audio"',
  );
  assert.equal(devices.length, 2);
  assert.notEqual(devices[0].device_reference, devices[1].device_reference);
  assert.equal(devices[1].input, "@device_2");
  assert.equal(
    publicDevice({ ...devices[0], password: "secret" }).password,
    undefined,
  );
});
test("inactive virtual devices cannot overwrite the preceding webcam address", () => {
  const devices = parseUsb(
    '[dshow] "EMEET" (video)\n[dshow] Alternative name "@physical"\n[dshow] "ByteCast VirtualCamera1" (none)\n[dshow] Alternative name "@inactive1"\n[dshow] "ByteCast VirtualCamera2" (none)\n[dshow] Alternative name "@inactive2"\n[dshow] "OBS" (video)\n[dshow] Alternative name "@obs"',
  );
  assert.equal(devices.length, 2);
  assert.equal(devices[0].input, "@physical");
  assert.equal(devices[1].input, "@obs");
  assert.equal(devices[0].device_reference, parseUsb('[dshow] "EMEET" (video)\n[dshow] Alternative name "@physical"')[0].device_reference);
});
test("camera addresses cannot use file or FFmpeg pseudo protocols", () => {
  for (const url of ["file:///private", "concat:secret", "http://example.com"])
    assert.throws(() => cameraUrl(url, ["rtsp:", "rtsps:"]));
  assert.equal(
    cameraUrl("rtsp://192.168.1.50:554/live", ["rtsp:"]).hostname,
    "192.168.1.50",
  );
});
test("discovery preserves local credentials and names while distinguishing absent devices", () => {
  const configured = {
    device_reference: "net-1",
    name: "Court camera",
    password: "local-only",
    endpoint: "http://old/onvif",
  };
  const absent = mergeDevices([configured], []);
  assert.equal(absent[0].present, false);
  const returned = mergeDevices(absent, [
    {
      device_reference: "net-1",
      name: "Network camera 1",
      endpoint: "http://new/onvif",
    },
  ]);
  assert.equal(returned[0].present, true);
  assert.equal(returned[0].password, "local-only");
  assert.equal(returned[0].name, "Court camera");
  assert.equal(returned[0].endpoint, "http://new/onvif");
});

test("microphone discovery separates duplicate names and keeps native paths local", () => {
  const devices = parseUsb('[dshow] "Mic" (audio)\n[dshow] Alternative name "@mic1"\n[dshow] "Mic" (audio)\n[dshow] Alternative name "@mic2"\n[dshow] "Webcam" (video)\n[dshow] Alternative name "@video"', "audio");
  assert.equal(devices.length, 2);
  assert.notEqual(devices[0].device_reference, devices[1].device_reference);
  assert.equal(devices[1].input, "@mic2");
  const safe = publicDevice({device_reference:"usb-test", audio_sources:devices});
  assert.equal(safe.audio_sources[0].input, undefined);
  assert.match(safe.audio_sources[0].device_reference, /^mic-/);
});
