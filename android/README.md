# Dink Vision Android recorder

This is an installable Android camera and RTSP recorder, using the existing hosted admin,
tablet enrollment, Drive upload, email delivery, and retention APIs. It does not
replace the Vercel application and does not require a venue PC. The Android
device must reach the hosted backend. Tapo mode also requires access to the
camera on the same local network.

## Install and configure

1. Transfer `Dink-Vision-Recorder-0.5.28.apk` to a **64-bit Android 8 or newer** device.
   Open it and allow installation from that file source when Android asks.
   This is a debug-signed testing build, not a Play Store release.
2. In the hosted admin's **Devices & cameras**, add/edit the device, assign its
   court, and generate an enrollment code. Camera mode is selected on the
   enrolled tablet:
   - **Wired USB / built-in Android camera** uses an attached standards-based
     UVC camera. It first uses Android Camera2 when the manufacturer exposes the
     camera there, then falls back to the APK's direct USB-host/UVC driver. With
     no USB camera attached it uses the rear camera. The tablet microphone supplies audio.
   - **Tapo Wi-Fi camera** uses a Tapo C210 or compatible RTSP camera. The APK
     receives, saves, and uploads the external camera stream; it does not use
     the Android camera or microphone.
3. For Tapo mode, create a **Camera Account** in the C210's advanced settings. Use
   the C210's Network Settings or your router to find its IP. Device setup
   automatically builds `rtsp://CAMERA_IP:554/stream1`. Keep the tablet and camera
   on the same LAN without guest-network isolation. Camera audio is included
   automatically when the RTSP stream provides a microphone track.
4. Open the APK, tap **Device setup**, and enter the code once. Choose the camera
   mode on the tablet. Tapo mode asks for its Camera Account details; USB or
   built-in mode asks for camera and microphone permissions. The saved setup is
   tested automatically and does not require another enrollment code.
5. On failure, open **Device setup** to test or change the saved camera. Camera
   configuration changes are blocked during active
   recording/upload; pending local footage must be recovered before retesting.
6. Tap to start, enter at least one player email on either team, add any optional recipients, confirm them, and record a short match.
   Stop, wait for upload confirmation, and check playback and email. Test a
   full-length match on the actual tablet before venue use.

Keep the tablet powered and the app open during initial testing. Its foreground
service can continue recording/uploading when the player screen is backgrounded;
force-stop, reboot, process termination, and manufacturer battery restrictions
can interrupt it. Do not clear app data or uninstall while a video is pending.
Use **Recover / retry upload** after reopening if needed. Only discard a failed
local recording when its loss is acceptable. Uploading sessions remain protected.
Recordings shorter than one minute are not uploaded. They remain in the APK’s
private directory at
`/data/user/0/com.casabatik.recorder/files/recordings/`. Offline and failed
uploads stay there too. Clearing app data or uninstalling the APK deletes them.
When several tablets finish together, the venue uploads one saved video at a
time. Waiting devices show the active upload and its progress. A failed first
upload pauses the queue until that same device successfully retries, so later
videos never skip ahead or lose their local copy. An administrator can cancel a
stuck upload to release the next device without deleting the original local
video. Recovering that video later places it at the end of the queue.

## Scope and limitations

- Tapo C210 uses standard RTSP; no proprietary Tapo SDK is embedded. Support for
  a camera depends on its protocol, codecs, account settings, and network access.
- This build records a standards-based UVC/OTG camera, the Android device's rear
  camera and microphone, or an assigned RTSP camera. UVC support still depends
  on the camera's advertised formats, a working OTG adapter, and sufficient USB
  power. Proprietary non-UVC cameras are unsupported. iOS, proprietary cloud-only cameras, ONVIF discovery,
  automatic IP discovery, and remote PTZ are not added here.
- RTSP capture copies H.264/AAC packets directly to hybrid-fragmented MP4 when
  compatible (H.264 video-only is also supported), preserving source resolution,
  quality and timestamps. G.711 audio is converted to AAC without re-encoding
  H.264 video. Other codecs use a source-timed 720p H.264/AAC encoding
  path. A clock reset, excessive gap or more than three seconds of processing
  drift stops capture; footage is never stretched to conceal a slow receiver.
  Stop writes the MP4 trailer. Both track durations and packet timelines are
  validated before upload, including recovery. An invalid file remains local.
  Android-device capture uses the platform camera and MediaRecorder APIs.
  Tablet CPU, battery,
  temperature, and Wi-Fi affect performance. This first build is not a guarantee
  of full-duration performance on untested hardware.
- Camera passwords are encrypted on the backend using TOKEN_ENCRYPTION_KEY.
  The enrolled tablet retrieves only its assigned configuration over HTTPS.
  Cached credentials and API cookies are encrypted with Android Keystore. Video files
  stay in app-private storage until the backend confirms upload; backups and
  device transfer are disabled. Camera RTSP uses the local network; it is not
  encrypted TLS. Internet API and Drive traffic use HTTPS.
- The backend origin is injected from `APP_ORIGIN` in the repository `.env` or
  the Android build environment. No service
  role key, Google secret, camera password, or admin password is bundled.
- The backend models both APK camera choices as managed Android recorder sources.
  Apply `202610060015_admin_rtsp_setup.sql` and
  `202610070017_permanent_device_removal.sql` through
  `202610100025_camera_orientation.sql`, then deploy the web changes before
  installing APK 0.5.9. Enrollment, authorization, upload, and email must still
  be tested with the venue's real account/device.

## Build

Install JDK 17 and Android SDK platform 36. Set `ANDROID_HOME`, or put the local
SDK location in a gitignored `local.properties`. From this directory:

```powershell
.\gradlew.bat :app:assembleDebug :app:lintDebug
```

APK: `app/build/outputs/apk/debug/app-debug.apk`. Every `assembleDebug` build,
including Android Studio's **Build APK(s)** action, copies that exact APK to
`../Dink-Vision-Recorder-0.5.28.apk` and
`../artifacts/Dink-Vision-Recorder-0.5.28.apk`. It contains arm64-v8a and x86_64
native libraries. Gradle and native dependencies are pinned. The debug signing
key lives in the developer's Android profile, not in this repository;
production signing and store distribution are a separate release step.

Open the `android` directory itself as the Android Studio project. Select the
automatically generated **app** Android run configuration and use **Run app**
to rebuild and reinstall the current source on the selected emulator. Opening
the repository root creates a non-Android project and can leave an older APK on
the emulator.

## Android integration tests

Tests use an Android emulator and a local synthetic RTSP source. They do not
access a physical camera or send a real recording/email. For the fixture, run
MediaMTX with RTSP TCP bound to `127.0.0.1:18554` and a `camera` publisher path;
disable unused protocol listeners. Publish generated test video/audio:

```text
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=15 -f lavfi -i sine=frequency=440:sample_rate=48000 -c:v libx264 -g 30 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -c:a aac -f rtsp -rtsp_transport tcp rtsp://127.0.0.1:18554/camera
```

The desktop fixture uses libx264 only to generate test input; the APK uses
libopenh264 and does not include the GPL FFmpeg Maven variant.

```powershell
.\gradlew.bat :app:connectedDebugAndroidTest
```

Tests cover native RTSP capture with video/audio, stop, output decoding, URI
validation/credential escaping, Android camera source selection, encrypted persistence, corrupt-file rejection,
player asset loading, and foreground-service startup. Physical C210 recording,
arm64 hardware performance, long captures, upload interruption/recovery, and
actual Drive/email delivery remain device acceptance tests.

## Open-source components

JavaCV/JavaCPP 1.5.12, FFmpeg 7.1.1-1.5.12 non-GPL Android classifiers,
UVCAndroid 1.0.13, AndroidX WebKit 1.14.0 and Activity 1.10.1. License texts and source links are packaged in
`app/src/main/assets/licenses`. FFmpeg libraries are dynamically linked; replacing
their native JAR inputs and rebuilding/re-signing the APK supports modifications
to those libraries. Preserve the included license notices when distributing.

## Upgrade from 0.1.0

Install over the existing APK to keep enrollment and pending footage. After the
device is enrolled, open **Device setup** in the APK to choose either the wired
USB / built-in Android camera or a Tapo Wi-Fi camera, then run its camera test.
Existing locally saved passwords are not uploaded automatically; enter the Tapo
Camera Account credentials on the tablet when configuring that camera. The
browser camera workflow remains available for browser-based tablets.
