# DinkVision cross-platform verification — October 14, 2026

> October 18 follow-up: Android 0.5.21 adds a direct UVC/USB-host fallback when
> the operating system sees a standards-based OTG camera but does not expose a
> Camera2 external source. The October 14 matrix remains a historical record;
> the new path compiles and its mode-selection tests pass, while physical USB
> capture and disconnect recovery still require the target phone and camera.

## A. Compatibility summary

**Verdict: CONDITIONALLY READY for a supervised desktop demonstration. The wired Android demonstration is not signed off.** All executable checks below pass. A connected Android tablet/USB camera, a fifteen-minute physical recording, and staged Google delivery are still required. This report does not claim that synthetic cameras or desktop rendering of APK assets verify Android hardware.

Current scope is modern **Chrome and Microsoft Edge**, Android browsers where their APIs support the feature, and the Android APK. iOS apps, iOS browsers and Safari are excluded at the user's request. Firefox is outside the final acceptance matrix. Wireless-specific testing is excluded; existing wireless behavior was preserved.

### Actual architecture and platform boundary

| Area | Desktop / Android browser | Android APK | Shared backend |
| --- | --- | --- | --- |
| Framework | Next.js 16.3.6 App Router, React 19, TypeScript | Java Android activity, bundled HTML/CSS/JS displayed by Android WebView | Next route handlers; Supabase Auth/Postgres |
| Camera | `getUserMedia`, MP4 `MediaRecorder`; feature-detected transform worker | Native Camera2 + MediaRecorder for built-in/external cameras; existing JavaCV/FFmpeg for network cameras | Enrollment, camera revision, session and permission policy |
| Wired support | Only cameras exposed by the OS/browser media API | External Camera2 source, selected without rear-camera fallback; no bundled USB-host/UVC driver | Existing wired mode identifier retained |
| Local storage | IndexedDB metadata/chunks, device Web Locks | App-private MP4 files; encrypted Vault queue, Android Keystore | Session/job records and scoped claims |
| Uploads | Resumable browser worker while the page can execute; resume after reopening | Native upload executor plus foreground service; resume after reopening | Resumable transfer, verification, Drive ACLs, email and job leases |
| Playback / cuts | Browser MP4 decoder and real-time last-minute export; original preserved | Native `VideoView` local playback added; existing native last-minute export | Tenant-authorized replay route and derived-clip registration |
| Authentication | Supabase account cookies; owner/admin tenant selection; device enrollment for player mode | Revocable device enrollment cookie; no owner/admin login UI inside the APK | Membership/device ownership checks, tenant-scoped queries and RPCs |
| Status | Polling | Native snapshot polling + backend heartbeat | Database records; no realtime subscription transport was found |

Sources: `package.json`, `app/api/`, `lib/browser-media.ts`, `lib/browser-recorder.ts`, `lib/browser-upload.ts`, `lib/browser-storage.ts`, `lib/tenant-scope.ts`, `android/app/src/main/java/com/casabatik/recorder/{MainActivity,DeviceCameraRecorder,Engine,RecorderService,Vault,VideoClip}.java`.

The APK uses WebView for its bundled interface, **not browser camera/storage/upload APIs**. `WebViewAssetLoader` serves only local assets; its JavaScript bridge calls native code. Remote WebView navigation/file access remains disabled. No wrapper/framework replacement or dependency was introduced.

Minimum APK platform remains Android 8/API 26, 64-bit ARM or x86; target/compile SDK 36. This is a build compatibility range, not a claim that every tablet exposes an external Camera2 camera. The APK currently validates camera setup by recording a test clip; it has **no live camera-preview surface**. Native local playback is separate from camera preview.

## B. Changes made and root causes

This continuation changes 16 existing files and adds 5 files (21 total). It preserves earlier uncommitted work. There are no database migrations, dependencies, production changes, file/asset renames, or recording/queue deletions in this compatibility pass.

| Priority / issue | Root cause | Smallest implemented correction | Files |
| --- | --- | --- | --- |
| P1: Some USB cameras rejected valid modes | A preferred resolution was selected before checking its achievable frame rate; continuous-video autofocus was requested unconditionally | Try reported size/rate combinations up to 1080p, prefer 720p, respect supported AF modes, tolerate nanosecond rounding of reported frame duration; fail clearly if none is supported | `DeviceCameraRecorder.java`, `RecordingAccuracyTest.java` |
| P1: Browser camera test could hang | Missing MediaRecorder `onstop` left test finalization unresolved | Overall encoder deadline, timer/listener cleanup and unconditional track release; reject unsupported MP4 encoding before opening the camera | `lib/browser-media.ts`, `lib/browser-recorder.ts`, `tests/browser-compatibility.test.ts` |
| P1: Upload-only service required camera/mic permission | Foreground type was tied to enrolled camera mode instead of current work | Use `dataSync` for upload-only work, camera/mic types only for active device capture, existing connected-device type for network capture; guard API-level constants; handle denied starts and Android service timeout by pausing work and retaining files | `RecorderService.java`, `Engine.java`, `AndroidManifest.xml`, `CompatibilityTest.java` |
| P1: Native result/error screen lost or trapped | Completion returned directly to welcome; stale server capture status could override the stopped local engine; immediate start failure cleared recipients | Keep the result until the player chooses another match; use local capture activity to drive the recording screen; prevent duplicate start clicks; retain recipients for retry until the next-match reset; short-result message correctly says local-only | `android/app/src/main/assets/app.js`, `Engine.java` |
| P1: Local APK footage could not be played inside the app | No local-video playback action/player existed | Add an ownership-checked playback action for available files outside capture/export and a native player with controls; release/pause it on dismiss/lifecycle transitions; exclude files already marked invalid and handle decoder failure without deleting data | `MainActivity.java`, `Engine.java`, native `app.js`, `QueueRecoveryTest.java` |
| P2: Narrow/enlarged interfaces overlapped or clipped controls | Fixed header/button dimensions, fixed re-enrollment overlay, undersized removal buttons; keyboard/cutout insets omitted | Reflow headers, size recording controls with text, minimum touch targets, move re-enrollment into content, keep decorative watermark off active forms, wrap queue/footer text, include IME/cutout insets | `app/tablet.css`, native `style.css`/`app.js`, `MainActivity.java`, `AndroidManifest.xml` |
| P2: Poor storage/API failure messages | Unavailable IndexedDB produced a reference error; an empty API failure was parsed as JSON | Report an actionable storage error, close old DB connections on version change, handle non-JSON local-video API responses | `lib/browser-storage.ts`, `components/local-clips.tsx` |

Other changed existing files: `README.md`, `android/README.md`. New files: this report, `scripts/test-cross-platform.mjs`, `scripts/test-browser-compatibility.mjs`, `tests/browser-compatibility.test.ts`, and `android/app/src/androidTest/java/com/casabatik/recorder/CompatibilityTest.java`.

Service changes follow Android's documented [foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types) and [data-sync timeout rules](https://developer.android.com/develop/background-work/services/fgs/timeout). Native runtime behavior remains a hardware/emulator test. The timeout handler stops the service promptly and pauses further transfers; an already-open bounded network request may finish before the worker observes the pause. Reopening the activity permits work to resume. No guaranteed execution after force-stop/reboot is claimed.

### Verified paths left intact

- Server-side duration policy: a valid recording can be shorter than a minute; **under 60 seconds stays local with no Drive upload/email**. At least 60 seconds is upload-eligible. Validation uses media duration, not the displayed countdown.
- Persistent pending/uploading/retrying/uploaded/failed/local-only states, eight-attempt retry budgets, backoff, timeouts, resume offsets, terminal corruption handling and confirmation-before-cleanup.
- Device-specific locks, independent queues, scoped backend claims and tenant ownership. A delayed or failed job does not hold the capture slot or block later eligible jobs.
- Authentication, tenant administration, private new Drive recordings, approved recipients, ambiguous-email safeguards, quotas, recording logs and worker isolation.
- Existing application ID, Keystore alias, IndexedDB name, lock names, cookie names, API protocols, database/storage identifiers and migration history. No renaming that could detach installed recordings or queues.

## C. Platform test matrix

### Evidence index

All paths below are relative to this repository. Generated logs/media are local, ignored artifacts under `.local/cross-platform/`.

| ID | Evidence | Final result |
| --- | --- | --- |
| T | `regression.log`; `npm test` | **PASS: 121/121**, zero failures/skips. Includes isolated PostgreSQL migrations/RLS, route authorization, queue faults, corruption, short clips, concurrency and recorder tests |
| B | `browser-results.json`; `scripts/test-cross-platform.mjs` against production server port 3109 | **PASS: 138/138** Chrome/Edge checks; actual installed Chrome 155.0.8059.41 and Edge 155.0.4283.45, headless on Windows |
| M | `media/results.json`; `scripts/test-browser-compatibility.mjs` | **PASS: 10/10** real media/persistence scenarios across Chrome/Edge; synthetic media only |
| W | `web-build.log`, `typecheck.log` | **PASS:** optimized production build and `tsc --noEmit` |
| S | `startup-smoke.json` | **PASS: 13/13** production HTTP checks, including pages, setup JSON, legacy logo redirect, unsupported GET and unauthenticated POST/admin/tenant/recording denial paths |
| A | `android-build.log`; Android build reports | **PASS:** debug APK, instrumentation APK and lint; **0 errors, 12 warnings**. Instrumentation is compiled, not executed |
| K | `apk-signature.log`, `apk-sha256.txt` | **PASS:** debug APK signature verification (v2) |
| H | `adb devices -l`; available SDK inspection | **BLOCKED:** no attached Android device, configured AVD, or installed emulator system image |

Initial status `NOT VERIFIED` means no failure was established at the start. `FAIL (inspection)` identifies a confirmed code path without pretending it was reproduced on physical hardware. A PASS is limited to the stated test level.

| Requirement / platform | Test performed | Initial status | Fix or retained behavior | Final status / evidence |
| --- | --- | --- | --- | --- |
| Architecture / both | Inspect framework, bridge, native engine, routes/storage | NOT VERIFIED | Preserve native/browser boundary | PASS — source map in A |
| Web startup / Chrome, Edge | Production render/navigation, page errors, HTTP responses | NOT VERIFIED | No startup changes | PASS — B, S, W |
| APK compilation/startup | Assemble application and instrumentation | NOT VERIFIED | Compile platform/API guards | PASS build — A; actual installation/startup BLOCKED — H |
| Login / web | Login UI, unauthenticated denial, route/session authorization fixtures | NOT VERIFIED | Existing auth retained | PASS at render/route level — B, S, T; real staged sign-in/sign-out NOT VERIFIED |
| APK account login | Inspect actual enrollment-only flow | NOT APPLICABLE | Owner login stays in web admin | NOT APPLICABLE in native player UI |
| Tenant selection / web | Authorized/forged switch, revoked membership, spoofed scope tests | NOT VERIFIED | Existing tenant authorization retained | PASS isolated — T; authenticated deployed UI NOT VERIFIED |
| Tenant isolation / both | Two-tenant SQL/RLS/RPC and route tests, ownership/claim denial | NOT VERIFIED | No security model changes | PASS isolated — T; simultaneous physical clients BLOCKED — H/staging |
| Court/location registration / web | Scoped SQL, ownership/limit and input tests | NOT VERIFIED | Existing implementation retained | PASS isolated — T; live admin form submission NOT VERIFIED |
| Court registration / APK | Inspect native workflow | NOT APPLICABLE | Done in web admin | NOT APPLICABLE |
| Device registration / both | Enrollment/re-enrollment ownership fixtures; setup-page render | NOT VERIFIED | Existing stable identity/queues retained | PASS isolated/web render — T, B; APK enrollment with backend BLOCKED — H |
| Dashboard/navigation/logs / web | Route checks, server policy/recording-state tests | NOT VERIFIED | Existing pages and backend retained | PASS tested contracts — T, S; authenticated dashboard visual tour NOT VERIFIED |
| Admin logs/GCP setup / APK | Inspect capabilities | NOT APPLICABLE | Admin web owns configuration/history | NOT APPLICABLE; native local queue is available |
| Wired camera detection / browser | Real browser media API and feature detection with synthetic camera | NOT VERIFIED | Unsupported capability errors retained | PASS API path — M; physical USB detection BLOCKED — H |
| Wired camera detection / APK | Inspect external-only enumeration and error path; compile selection tests | NOT VERIFIED | Re-enumerates at each attempt; no rear-camera substitution | PASS compile — A; actual Camera2 exposure/UVC/OTG BLOCKED — H |
| Native size/FPS/AF selection | Compile reported-mode/fixed-focus/rounding tests | FAIL (inspection) | Capability-based negotiation | PASS compile — A; runtime/hardware BLOCKED — H |
| Camera preview / browser | Actual synthetic camera test preview and release | NOT VERIFIED | Existing browser preview retained | PASS — M |
| Camera preview / APK | Inspect UI/capture surfaces | NOT APPLICABLE to implemented flow | Native setup validates a recorded test clip; no live preview UI | NOT APPLICABLE; explicit feature limitation |
| Permission loss/USB disconnect/reconnect / browser | Capture fault, timeout, ended/muted tracks and cleanup tests | NOT VERIFIED | Existing recovery retained; test finalization bounded | PASS simulated — T; physical removal BLOCKED — H |
| Permission loss/USB disconnect/reconnect / APK | Native source review and instrumentation build | NOT VERIFIED | Existing callback cleanup preserved; mode negotiation fixed | PASS compile — A; runtime BLOCKED — H |
| Missing test encoder stop / browser | Test suppresses `onstop`, verifies bounded rejection and track release | FAIL | New deadline and cleanup | PASS — T (`browser-compatibility.test.ts`) |
| Repeated short capture / Chrome, Edge | Three real synthetic MP4 captures per browser, one with flip transform | NOT VERIFIED | No minimum capture duration added | PASS — M; about 3.2-second clips validate and all tracks end |
| Short recording policy / both | Boundary tests, local-only queue/backend/email tests | NOT VERIFIED | Under-minute policy retained | PASS isolated — T; real no-email end-to-end NOT VERIFIED |
| 15-minute recording / both | No physical hardware available | BLOCKED | No synthetic substitute labelled as hardware success | BLOCKED — H |
| Recording result / APK UI assets | Complete/error/next-match, immediate failed-start retry and stale-server-state fixtures | FAIL | Stay on result; expose next match; local state controls activity; retry preserves recipients | PASS desktop DOM fixture — B; native WebView runtime BLOCKED — H |
| MP4 playback and seek / Chrome, Edge | Play/seek synthetic H.264/AAC, measure timeline against wall time | NOT VERIFIED | Existing codec path retained | PASS — M: 65-second source, normal-speed ratio about 0.98 including start overhead |
| Local playback / APK | Compile native player and ownership tests; verify bridge controls exclude invalid files | FAIL (missing UI) | Ownership-checked native player added | PASS build/UI fixture — A, B; real native decoding BLOCKED — H |
| One-minute cut / Chrome, Edge | Real-time export from 65-second source, full FFmpeg decode, cancellation | NOT VERIFIED on Edge | Existing clip engine retained | PASS — M: starts at 5,000 ms; Chrome 60,102 ms, Edge 60,099 ms; wall time about 60.1 s |
| One-minute cut / APK | Compile native export/integrity instrumentation | NOT VERIFIED | Original preserved; existing export retained | PASS compile — A; native execution BLOCKED — H |
| Physical A/V sync / both | Source timeline tests only | NOT VERIFIED | No blind retiming or codec changes | BLOCKED physical — H; synthetic validation PASS — T/M |
| Video download / Chrome, Edge | Save local MP4 with Unicode filename and fully decode output | NOT VERIFIED | Existing Blob/download behavior retained | PASS — M |
| Browser local persistence | Save three videos, read offline, close/relaunch full browser with same isolated profile | NOT VERIFIED | Same IndexedDB identity retained | PASS — M; no files lost |
| Browser storage failures | Inspect missing-IndexedDB guard; exercise quota/transaction/invalid-file paths | NOT VERIFIED | Clear unavailable-storage error; version-change cleanup | PASS tested paths — T; device storage-pressure behavior NOT VERIFIED |
| Native local storage/restart | Inspect durable files/Vault/reconciliation; compile recovery tests | NOT VERIFIED | No storage identity or data migration | PASS compile — A; process kill/reboot execution BLOCKED — H |
| Multiple queued videos | FIFO/delayed retries, later-job progress, capture independence | NOT VERIFIED | Existing bounded queue retained | PASS simulations/SQL — T; three actual browser saved videos — M |
| Multiple devices/tenants | Overlapping workers, same-court independent device claims, cross-tenant denial | NOT VERIFIED | Existing isolation retained | PASS isolated — T; physical multi-device test BLOCKED — H/staging |
| Network loss/high latency/timeout | Lost responses, offline/retry, resume/confirmation fault scenarios | NOT VERIFIED | No queue protocol changes | PASS simulated — T; real offline local read — M; real interrupted cloud transfer NOT VERIFIED |
| Native upload-only service | Compile type selection and timeout behavior | FAIL (inspection) | Separate data sync from camera/mic work; pause safely on OS timeout/denial | PASS compile — A; Android 14–16 lifecycle execution BLOCKED — H |
| Corrupt recordings / both | Invalid MP4, stalled/misaligned tracks, truncation and retry terminality | NOT VERIFIED | Validation/retention retained | PASS browser/server tests — T; native validator execution BLOCKED — H |
| Duplicate processing / both | Concurrent claims, lost completion response, stale worker denial | NOT VERIFIED | Existing locks/leases/idempotency retained | PASS isolated — T |
| Responsive layouts / Chrome, Edge | Seven portrait/landscape viewports; screenshot inspection; enlarged text | FAIL: narrow header and enlarged recording label | Reflow/size controls; move overlapping overlays | PASS — B: 320×640 through 1920×1080, plus 640×400 and 200% computed text scaling |
| Touch/keyboard / web | Emulated tablet touch entry, Enter submission, removal target sizes | NOT VERIFIED | Touch targets enlarged | PASS desktop touch emulation — B; actual Android keyboard/zoom NOT VERIFIED |
| APK system bars/cutout/keyboard | Compile insets and resize configuration; local HTML layout fixtures | FAIL (inspection: missing IME/cutout handling) | Apply IME/cutout/system-bar insets and resize | PASS compile/fixture — A/B; actual devices BLOCKED — H |
| API serialization/errors | Shared protocol/route tests; empty HTTP 500 fixture for clips page | FAIL: JSON parse error exposed | Actionable error instead of raw JSON failure | PASS — T, B |
| UTC/local date handling | Inspect ISO/epoch persistence, venue timezone validation; Honolulu browser context | NOT VERIFIED | Existing UTC storage and local display retained | PASS covered validation/render paths — T/B/M; cross-timezone live scheduling NOT VERIFIED |
| Unicode/file naming | Japanese/Portuguese court label layout and actual Unicode MP4 download | NOT VERIFIED | Existing Unicode behavior retained | PASS — B, M |
| Realtime updates | Inspect status transport | NOT APPLICABLE | Existing polling retained | NOT APPLICABLE for subscriptions; live polling across physical clients NOT VERIFIED |
| Google connection / Drive | Redirect, tenant scoping, recipient ACL, upload confirmation mocks | NOT VERIFIED | Existing server-only credentials retained | PASS isolated — T; live OAuth/Drive staging NOT VERIFIED |
| Automated email | Recipient policy, ambiguous-send/retry and short-video tests | NOT VERIFIED | Existing backend email queue retained | PASS mocked — T; actual inbox delivery NOT VERIFIED |
| Memory/resources | Repeated capture track release, cancellation/source cleanup; native release paths | NOT VERIFIED | Correct bounded test cleanup | PASS browser checks — T/M; large-file RAM, battery/thermal soak NOT VERIFIED |
| Scalability/quotas | Tenant limits, batch/scoped jobs and independent queue tests | NOT VERIFIED | No speculative concurrency changes | PASS isolated — T; expected venue-scale load NOT VERIFIED |
| Android browser runtime | Desktop mobile/touch emulation only | BLOCKED | No equivalence claimed | BLOCKED on physical Android — H |
| iOS/Safari | User explicitly excluded platform | NOT APPLICABLE | No work required | NOT APPLICABLE |

### Execution details

Browser layout evidence covers `/admin/login`, `/tablet/setup`, `/tablet/clips`, `/preview`, and the actual bundled APK HTML through a **fake native bridge**. Those assets run in desktop Chromium for DOM/CSS checks only. `/preview` intentionally does not record. The media runner separately invokes actual recording/storage/clip modules with a synthetic browser camera and an FFmpeg-generated source, in disposable isolated profiles. It makes no cloud writes or email sends.

The initial UI check found the native result-screen failure in each browser. Screenshot review additionally found header overlap and enlarged recording-label clipping; the final runner now checks both explicitly. Test-harness-only issues (Next route announcer also has `role=alert`, temporary rather than permanent logo redirect, POST-only admin route) were corrected to the inspected contracts without changing working application behavior.

The output files from the browser media checks were decoded in full with FFmpeg `-v error -xerror`, not judged solely from file size or a playable first frame. These results do not establish long-running tablet A/V synchronization or solve arbitrary corrupt historical footage.

No frontend ESLint command/configuration exists in this project. Frontend lint is **NOT APPLICABLE as an available check**; TypeScript, production build and automated tests passed. Android lint passed with 12 warnings; Gradle reports existing deprecations. Neither was suppressed to pass the build. Git whitespace validation passed.

## D. Remaining limitations and required manual verification

1. **Wired hardware:** use the exact pitch tablet, USB camera, OTG cable/hub and power supply. Confirm Android exposes a Camera2 external source. If it does not, this APK cannot use that camera through its current architecture; a bundled UVC driver would be a separate, justified implementation, not an assumed capability.
2. **Native runtime:** install the rebuilt debug APK without uninstalling/clearing the current app's data. Verify setup permissions, camera test, player UI, local playback, clipping, rotation, keyboard and system bars. Test the oldest intended Android version and at least the intended modern Android device/OS.
3. **Capture soak:** record a real 15-minute match. Compare video duration to elapsed time, check normal-speed movement, lip/clap sync near beginning/end, and seek/play on both desktop browsers. Monitor storage, memory, temperature and battery.
4. **Recovery:** remove USB during preparation, countdown, recording and stop/finalization. Reconnect; deny/revoke/regrant permissions; immediately record again. Available valid footage must remain local, invalid footage must fail clearly, and the next recording must not require restarting the app.
5. **Short boundaries:** test approximately 1 s, 10 s, 59 s, 60 s and 61 s, followed immediately by another recording. Validate the saved media duration; under 60 s must produce neither Drive file nor replay email.
6. **Queue/lifecycle:** queue three videos, interrupt Wi-Fi mid-transfer, restore it, background the APK, and reopen after process termination/reboot. Confirm durable rows/files, bounded retries, no duplicate remote files, no permanent camera lock and correct completed/failed logs. Browser uploads resume on reopening; they are not promised to run while the browser is fully closed. Test native Android foreground-service timeouts/denials on a suitable device/emulator.
7. **Staging:** follow [tenant-rollout.md](tenant-rollout.md), apply the existing migrations through 041 to a separate staging project, and deploy the matching application/workers. This pass did not apply migrations or deploy production. Old unscoped code must not run against newly added tenants.
8. **Two tenants/devices:** use two owners, separate Google roots, and multiple devices including two on one court. Switch authorized tenants; try foreign IDs, revoked memberships/device credentials and court reassignment. Verify each queue, log, recipient and replay stays in the correct tenant when one connection fails.
9. **Google/email:** complete consent with the intended test accounts, upload an eligible recording, validate recipient-only playback, verify the expected email once, and confirm no mail for short/invalid clips. Real Google/inbox execution was not performed here.
10. **Presentation browser/environment:** verify the authenticated dashboard, court/device setup, recording logs, Google settings and playback on the actual laptop. Android browser camera exposure, Android WebView decoding, real browser zoom/system font settings and other desktop operating systems require their own runtime checks.

The existing WPC lettering inside the supplied logo pixels remains from the earlier explicit no-new-logo decision; DinkVision display text and asset paths are unchanged by this pass. Existing storage/package/Keystore identifiers remain intentionally compatible. See [dinkvision-readiness-2026-10-14.md](dinkvision-readiness-2026-10-14.md) for the previous rebranding/tenant implementation report.

## E. Pitch readiness and reproduction

**CONDITIONALLY READY** means the executable local software matrix is green. It is not approval to demonstrate unverified wired hardware or share production across tenants before staged rollout. The remaining gating checks are physical USB exposure/recovery, a real 15-minute A/V recording, native clip/playback execution and lifecycle recovery, staged multi-device isolation, and actual Google delivery.

```powershell
npm test
npm run typecheck
npm run build
npm run start -- --hostname 127.0.0.1 --port 3109
```

In another terminal, provide an existing Playwright installation (the runner adds no application dependency):

```powershell
$env:DINKVISION_PLAYWRIGHT = 'C:/Users/maano/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
$env:TEST_ORIGIN = 'http://127.0.0.1:3109'
node scripts/test-cross-platform.mjs
node scripts/test-browser-compatibility.mjs
```

With the existing Java/Android SDK configured, from `android/`:

```powershell
.\gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
# Only after connecting an authorized test device/emulator:
.\gradlew.bat :app:connectedDebugAndroidTest
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk` (debug-signed 0.5.11). Instrumentation: `android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`. Verified application SHA-256: `2B4FE7576784F6B9B4EFCFD88244A9354311BD5166323ABF02A1322BF76D9F77`. This artifact was built locally; it was not published or deployed.
