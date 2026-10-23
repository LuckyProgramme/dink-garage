# Recording accuracy (Android 0.5.9 and web)

The camera's media clock controls playback. The device's monotonic elapsed clock
measures capture time and detects backlog; it must not replace source timestamps.

## Capture paths

- Android RTSP, wired Ethernet or Wi-Fi: H.264/AAC packets are copied without video
  re-encoding. Capture begins at a timestamped keyframe after countdown. One shared
  source offset rebases video and audio; PTS/DTS spacing is preserved. Video-only
  H.264 is supported. G.711 audio is converted to AAC while H.264 video is copied.
  Other unsupported MP4 audio/video codecs use the existing encoder,
  now with source-based video timing and audio sample/source drift checks.
- Android device camera: Camera2/MediaRecorder uses a supported frame-rate range
  compatible with the chosen output size. Sensor callbacks detect stalled capture
  and clock drift. Version 0.5.21 adds direct UVC/USB-host capture when Android
  detects the camera but does not expose a Camera2 external source. It selects a
  reported MJPEG mode at 720p when available, otherwise a safe reported mode up
  to 1080p, and caps the requested rate at 30 fps where the camera permits it.
- Browser cameras: MediaRecorder retains its native timing. Monotonic capture time
  ends before final storage writes. The original camera's frame delivery, track
  state, and chunk delivery are monitored, including for transformed canvas video.

## Validation and failure handling

Expected vs media duration must agree within max(1.5 seconds, 2%), capped at three
seconds. This is an operational tolerance, not a claim of frame-perfect capture.
Audio/video durations and initial offsets are checked. Source resets and gaps over
three seconds are rejected. Android scans packet timelines; web inspects regular
MP4 sample tables and fragmented MP4 tfdt/trun tables without loading video payloads.
Timing-table validation cannot prove that every image is unique or every frame
decodes; a stopwatch-and-clap acceptance test remains necessary on real hardware.

Android logs only capture mode, counts, and durations under WPCRecording. It does
not log RTSP addresses, credentials, player emails, or media content. Browser
validation failures retain local footage and do not initiate upload. Recovery also
validates timing. Rejected files must not be labeled successful matches.

No automatic reconnection joins separate timelines. A disconnect/reset stops the
clip with an error; recovery validates available footage. Existing enrollment,
upload queue, retry, email delivery and retention behavior remains in place.

Direct copy preserves camera bitrate and resolution; it may produce larger files
than the old 720p encoder. Lower camera stream quality if bandwidth/storage require
it. Software fallback is guarded, not guaranteed to sustain every stream. Hardware
encoding is not guaranteed on every device. Direct UVC support covers compliant
USB cameras; proprietary devices, inadequate OTG power, and unadvertised formats
remain outside the compatibility claim.

## Acceptance at the venue

1. Record a visible stopwatch with a clap at the beginning and end.
2. Test a short clip and a full 15-minute match on each intended device/camera mode.
3. Compare the original MP4 at 1x with the camera clock and verify A/V alignment.
4. Repeat with weak Wi-Fi, camera loss, backgrounding and a hot/busy tablet.
5. Record on four devices and verify each file independently, then let queued
   uploads finish over the site's actual connection. Playback and upload speed
   are separate acceptance criteria.

Automated fixtures use generated video/audio only. They do not contact real venue
cameras or send email. The private user sample stays outside tracked test fixtures.

The RTSP instrumentation tests expect a local test server on port 18554, exposed
to the Android emulator at 10.0.2.2. `/camera` supplies H.264/AAC and `/g711`
supplies H.264/PCMA. Run these tests against generated streams, never venue
credentials. The device-camera test requires a working emulator camera and audio
input or a physical Android device; audio overruns are validation failures rather
than a reason to loosen the acceptance threshold.

## Verification for this build

- Web production build and TypeScript check passed. The full automated suite
  passed 51 tests; the subsequently added invalid-upload test and all five other
  browser-recorder tests also passed.
- Real Chrome MediaRecorder with generated media passed six-second timing checks
  for normal and 90-degree canvas-rotated video.
- Android APK build, signature verification and lint completed successfully.
- 21 Android instrumentation tests passed, including H.264/AAC packet copy,
  G.711 audio conversion, four concurrent RTSP captures and invalid-file rejection.
- The additional built-in camera acceptance test failed on the API 36.1 emulator:
  Android reported repeated AudioRecord overruns and saved about 3.16 seconds of
  audio during 6.08 seconds of capture. The isolated retry reproduced it with
  emulator audio enabled. Validation correctly rejected that output. A physical
  device-camera test is still required; successful built-in camera recording is
  not verified by this emulator run.
- Full-match timing, thermal behavior and four physical devices at the venue
  remain unverified. No production deployment or email delivery test was performed.
