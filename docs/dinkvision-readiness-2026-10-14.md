# DinkVision implementation and readiness — October 14, 2026

> October 18 follow-up: Android 0.5.21 adds an in-APK UVC/USB-host fallback for
> standards-based OTG cameras that Android detects without publishing through
> Camera2, including the path reported on a Samsung A22. The original October 14
> matrix below remains historical; physical capture, unplug/reconnect, long-run,
> and powered-OTG acceptance tests are still required on the venue hardware.

**Verdict: CONDITIONALLY READY for a supervised pitch after the checks below.** Local software verification passes. The new tenant schema and matching application are not deployed; physical USB capture, a real 15-minute match, native Android clip execution, and real Google playback/email delivery remain unverified. This is not production approval or a claim that every possible failure has been tested.

The consolidated implementation request supersedes the earlier read-only multi-tenancy audit. Scope and completion criteria are recorded in [implementation-scope.md](implementation-scope.md). Wireless-specific work was excluded. Existing fixes and pre-existing uncommitted changes were preserved.

## A. Implementation summary

### Rebranding and compatibility

The application text, metadata, package/workspace labels, Android application label, native bridge, diagnostics, and current asset references identify DinkVision. No new logo was generated. The supplied original logo artwork was retained byte-for-byte, so the old WPC lettering remains inside those image pixels. That artwork is an explicit remaining visual-branding limitation, not an undiscovered text reference. A supplied replacement logo can later replace the assets without changing their new names.

Four asset renames:

| Previous path | Current path |
| --- | --- |
| `public/wpc-logo.png` | `public/dink-vision-logo.png` |
| `android/app/src/main/assets/wpc-logo.png` | `android/app/src/main/assets/dink-vision-logo.png` |
| `android/app/src/main/res/drawable/wpc_logo.png` | `android/app/src/main/res/drawable/dink_vision_logo.png` |
| `android/app/src/main/res/drawable/wpc_launcher.xml` | `android/app/src/main/res/drawable/dink_vision_launcher.xml` |

The website redirects the old logo URL to the new path. Android manifest/resource references and both sides of `DinkVisionNative` were updated together. `DINK_VISION_RECORDER_HOME` is the Windows recorder's current override, with the legacy variable retained as a fallback. No source directory, production table, bucket, domain, OAuth project, or Android application ID was renamed.

This task modifies **79 existing files**, adds **25 files**, and renames **4 assets**: **108 affected files** with no other removals. The exact paths compared with the saved starting baseline are in [dinkvision-change-inventory.md](dinkvision-change-inventory.md). This distinguishes this continuation's changes from older uncommitted recording fixes visible in `git diff`.

### Confirmed root causes and repairs

| Priority | Root cause and affected code | Implemented change / verification |
| --- | --- | --- |
| P0 | Global admin checks, unscoped service-role table access, singleton Google/venue settings, and globally scoped security-definer jobs: `lib/auth.ts`, `lib/recorder-server.ts`, `lib/google-server.ts`, old SQL routines | Tenant membership authorization, mandatory transport scope, composite foreign keys, restrictive authenticated RLS, and RLS-obeying RPC owner in migration 036. Two-tenant SQL/route/transport tests pass. Production rollout still required. |
| P0 | Guest recordings historically used `anyone/reader` Drive links: `lib/google-drive.ts`, session policy snapshots | Migration 038 makes new recordings private; approved team recipients are added idempotently. Tests reject unexpected readers. Existing external link ACLs are preserved and require a separate owner-coordinated review. |
| P1 | Camera callbacks could arrive after timeout; source-track stalls and missing stop events could retain resources: `DeviceCameraRecorder.java`, `lib/browser-recorder.ts` | Preserved and regression-tested bounded opening/finalization, late callback cleanup, stall detection, cancellation, and release of recording locks. Android callback behavior still needs hardware execution. |
| P1 | Short/interrupted recordings and upload errors could hold the UI and camera slot; stale results could replace a newer recording: `lib/player-session.ts`, `components/tablet-kiosk.tsx`, `lib/browser-upload.ts` | Existing result-screen, visibility, notification, local-only, and queue reconciliation fixes retained. Automated immediate-restart, stale-state, short-video, and fault tests pass. |
| P1 | Android restart left uploads active, retry attempts could restart indefinitely, and cleanup preceded durable completion: `Engine.java`, `UploadTransfer.java`, migration 033 | Durable queue transitions, bounded retries/backoff, recovery, completion before cleanup, and timeout paths retained. Isolated browser/SQL/transfer simulations pass; Android instrumentation APK builds. |
| P1 | A playable prefix could conceal a truncated MP4 tail; timing could diverge from source time: `RtspRecorder.java`, `RecordingAccuracy.java`, `lib/recording-integrity.ts` | Structural and timeline validation retained; Android decodes the file and rejects corrupt footage without endless upload retries. Synthetic validation tests pass. Physical A/V sync remains a hardware check. |
| P1 | Re-enrollment created a new kiosk identity, detaching old queued sessions: `app/api/tablet/enroll/route.ts`, migration 041 | Rotate the existing identity's token, preserve queue references, require active issuing-admin authorization, and reject active capture. Database regression passes. |
| P1 | The same-court capture index serialized independent tablets: migration 039, device selection UI | Keep one active capture per browser/APK device while allowing multiple devices on a court. Legacy primary-camera locking remains. Concurrent database fixtures pass. |
| P1 | The APK had no explicit wired external-camera selection | Add a Camera2 external-only mode in `DeviceCameraRecorder.java`, `Engine.java`, and tablet camera configuration. Re-enumerate at every start; never substitute the rear camera. Compiles; actual USB exposure is tablet-dependent. |
| P1 | No one-minute export workflow existed | Add `lib/video-clip.ts`, `components/local-clips.tsx`, `/tablet/clips`, `VideoClip.java`, and migration 040. The last minute is a separate file/job, with source ownership, idempotent registration, cancellation, and original preservation. Real Chromium export/decoding passes; native execution blocked on hardware/emulator. |
| P1 | Android local retry paths could mutate a job belonging to a previous enrollment: `Engine.java` | Match queued device identity, or require server ownership confirmation for legacy jobs, before visibility, retry, failure reporting, or upload. Test fixture covers foreign-device exclusion; compiled but not executed on Android. |
| P2 | Each browser upload slice reread the entire saved chunk set: `lib/browser-upload.ts` | Slice the already assembled immutable Blob, avoiding repeated full IndexedDB reads for each 4 MiB transfer. Resume, fault, and retention tests pass. |

### Data, configuration, and existing fixes

New migrations **036–041** implement tenant isolation, administration/quotas, private sharing for new sessions, independent devices, derived clips, and stable re-enrollment. No dependencies were added. `.env` remains the local configuration file; no `.env.local` requirement was introduced. New tenant owner/root settings live in the database, with environment fallback only for the original tenant. `APP_ORIGIN` remains the hosting switch for web callbacks and APK builds.

Already-correct paths were retained: encrypted credentials, origin checks, verified account lookup, resumable offsets, per-job leases, eight-attempt backoff, local-only short clips, queued email with ambiguous-send protection, recording logs, and cleanup only after verified upload. The full test suite covers these paths rather than replacing their implementations.

### Intentional legacy identifiers

| Identifier / location | Why it remains |
| --- | --- |
| `com.casabatik.recorder`, Java package directories, instrumentation class names, APK private-data path | Changing application identity can detach installed data, signing continuity, enrollment and local footage. No package migration performed. |
| `casa-batik-recorder-v1` in Android `Vault.java` | Existing Keystore alias decrypts stored cookies and queue journal. Renaming loses access to those values. |
| `casa-browser-recordings` in `lib/browser-storage.ts` | Existing IndexedDB database contains saved videos and queue metadata. |
| `casa-tablet-recorder-v2:*`, `casa-tablet-upload:*` in browser recorder/upload/clip code | Existing and newly opened tabs must contend for the same Web Locks during an update. |
| `cb-kiosk`, `cb-tablet-setup`, `cb_google_state`; `cbrec_`, `cbpair_` | Existing session/enrollment/OAuth cookies and machine protocols must remain readable. |
| `casa_migrations.applied`, historical migrations through 035 | Existing checksum ledger and immutable migration history. Migration 035 must recognize old organization values to update them. |
| `CASA_RECORDER_HOME` in Windows scripts | Backward-compatible fallback to the already protected recorder directory. |
| `wpc-` in the Gmail Message-ID | Stable historical delivery identity used to investigate ambiguous sends; changing it must not cause duplicate mail. |
| `WPC-Recorder-*.apk` and historical checksum/download links | Previously published artifacts keep their exact filenames and bytes; these are not newly published builds. |
| Old names in compatibility tests and historical recovery reports | Exercise upgrades and document actual historical state; they are not current display strings. |
| `/wpc-logo.png` redirect | Keeps bookmarks and previously rendered pages working. |
| Existing logo/icon image pixels and historical screenshots | Original artwork preserved, as requested; no replacement logo designed. |
| Workspace path `picklecamera`, remote/project IDs, existing domains, OAuth identifiers | External identity and deployment changes need coordination. No automatic relocation or infrastructure rename. |
| Wren Labs developer credit | Retained attribution, not the application name. |

## B. Recording and recovery results

- **Disconnection/permission loss:** software timeouts, callbacks, cancellation, and failure transitions release the capture resources. Browser mock scenarios pass. Android external-camera mode returns a specific failure if no Camera2 external source is exposed. Physical removal/reconnection and manufacturer permission behavior remain BLOCKED without hardware.
- **Short recordings:** any valid duration can finalize and remain local. Under 60 seconds is deliberately `local_only`: no Drive upload, email, or automatic retries. Exactly 60 seconds is upload-eligible. Source/file integrity, not elapsed UI time, controls eligibility.
- **Interrupted files:** finalized playable partial footage can proceed under the duration policy. Invalid/truncated files remain local and fail terminal validation. A process killed before a non-fragmented MP4 trailer is written may leave unrecoverable footage; the app does not claim those bytes are playable or delete them in recovery.
- **Persistent queues:** browser IndexedDB and Android encrypted queue journal retain independent jobs. Pending, uploading, retrying, completed (`uploaded` locally), failed, and local-only outcomes are explicit. Eight bounded attempts use backoff; exceptions and cancellation release locks. Server leases prevent duplicate concurrent work. Old attempts cannot overwrite newer lease results.
- **Availability:** stopped/failed uploads do not hold a capture slot, and a delayed job does not hold later eligible jobs at the head of the queue. Tests cover rapid start/stop, restart, lost completion response, offline recovery, full local storage, and other-device progress.
- **Local retention:** valid originals remain until successful backend completion is confirmed and recorded durably. Recovery does not clear queues or purge valid footage. Existing retention deletion after confirmed upload remains a separate configured policy.
- **One-minute export:** default is the last minute of a finalized source. Browser real-time export took the interval starting at 5,000 ms of a 65-second synthetic source and produced a fully decodable 60,101 ms MP4. Cancellation released the video source. Shorter sources return their existing valid bytes instead of padding. Native export is compiled but has not run. Automatic trimming does not imply a frame-exact 60,000 ms boundary; codec/frame timing tolerances are validated.
- **Playback:** synthetic MP4 timing and full decode pass. Actual 15-minute camera playback speed and physical audio/video sync are NOT VERIFIED. No hardware performance guarantee follows from the synthetic test.

## C. Multi-tenant assessment

**Before implementation:** single-tenant application with multiple courts/devices. A global admin role, singleton integration settings, and unscoped service-role/RPC access were unsuitable for unrelated customers sharing a database.

**Current code:** shared-database multi-tenant implementation with tenant-specific membership, locations, configuration, relational ownership, workers, and private new recordings. It is locally verified, but **not yet a fully verified multi-tenant deployment**. Until migrations and matching services are deployed together, the hosted system must still be treated as the original single-tenant system.

| Area | Evidence and assessment |
| --- | --- |
| Tenant selection | `lib/auth.ts` validates Supabase user, profile, active membership and active tenant. The cookie selects only from authorized tenants. Metadata cannot grant membership or super-admin status. |
| Admin and platform access | `app/api/tenants/route.ts` derives actor and tenant server-side, validates origins, and limits quota changes to explicit super-admins. Membership SQL protects the last active admin. No automatic super-admin bootstrap. |
| Database isolation | Migration 036 adds `tenant_id` to 21 existing operational tables, restrictive authenticated policies, composite references, and immutable ownership. Existing RPCs execute as NOLOGIN/NOBYPASSRLS `dinkvision_executor`; explicit first-party function/table allowlists avoid changing unrelated schema objects. |
| Privileged API access | `lib/tenant-scope.ts` scopes service-role REST reads/writes and passes RPC context; mismatched scopes and unknown tables fail closed. `systemDatabase()` is reserved for credential lookup, provisioning, scheduler selection and platform quotas. Service-role access remains a privileged boundary requiring code review. |
| Devices and recordings | Device credentials derive tenant ownership from stored hashed tokens, not request body/header. Same-tenant composite foreign keys protect court/device/session/file/job relationships. Re-enrollment keeps queue identity. |
| Local and cloud storage | Device IDs filter browser/native queue access. Each tenant has its own private Google root/owner/token row. File permissions are checked before readiness. No Supabase Storage buckets or realtime channels are used by this application code. Historical public links remain a documented exception. |
| Worker isolation | `lib/browser-jobs.ts` operates on scoped clients; scheduler selects up to four tenants per invocation and isolates failures using settled promises. Queue leases/idempotency are tested across devices and tenants. |
| Quotas | Migration 037 serializes quota checks with tenant row locks. New tenants have device/court/storage caps; original tenant remains unlimited for compatibility. Aggregate usage avoids a REST result-row cap. No destructive quota enforcement. |
| Scale limits | Shared DB and serverless duration limits remain. Scheduler capacity is bounded; Google API quotas are shared by the OAuth project. Logs currently load the latest 100 sessions. Android serializes its encrypted queue journal. These are scaling limits, not evidence of unlimited supported tenants/devices. No large production load test was performed. |

## D. Verification matrix

PASS means actually executed. FIXED rows specify the retest. BLOCKED means hardware, staging access/configuration or an external workflow is still required. NOT VERIFIED means the check was not performed. A compiled instrumentation APK is never counted as executed instrumentation.

| Test | Platform | Initial status | Action | Final status | Evidence |
| --- | --- | --- | --- | --- | --- |
| Device setup / enrollment | Web / database | FAIL: re-enrollment detached identity | Preserve identity; verify issuer still authorized | FIXED — isolated PASS; live deployment NOT VERIFIED | `tests/browser-tablets.test.ts`, `tests/tenant-isolation.test.ts`, migration 041 |
| Wired camera selection | Web / Android | NOT VERIFIED; APK lacked external-only mode | Add explicit Camera2 external mode | Web config PASS; Android execution BLOCKED | `tests/tablet-camera-config.test.ts`; Android test APK compiled |
| USB removal / reconnect / permissions | Web / Android | Existing failure paths required verification | Retain cleanup and timeout fixes; add external re-enumeration | Mock recovery PASS; physical BLOCKED | `tests/recording-stress.test.ts`; `DeviceCameraRecorder.java` |
| 15-minute real recording | PC / Android | NOT VERIFIED | No physical source available | BLOCKED | No hardware claim; manual procedure below |
| One-minute cut | Chromium | FAIL: workflow absent | Add bounded export, validation and cancellation | FIXED — PASS on synthetic source | `scripts/test-browser-clips.mjs`, 60,101 ms output, FFmpeg full decode |
| One-minute cut | Android | FAIL: workflow absent | Add source-timed native export, original retention | Build PASS; execution BLOCKED | `VideoClip.java`, `VideoClipTest.java` compiled |
| Short clips, immediate next recording | Browser / database | Previously fixed | Run regression unchanged | SKIPPED implementation; PASS regression | `tests/browser-recorder.test.ts`, `tests/player-session.test.ts` |
| Interrupted recording and finalization | Browser / database | Previously fixed | Run stall/stop/timeout/permission/storage faults | SKIPPED implementation; PASS simulation | `tests/recording-stress.test.ts`, `tests/recording-integrity.test.ts` |
| Persistent upload recovery | Browser / database | Previously fixed | Resume/retry/restart/lost-ack faults | PASS | `tests/upload-faults.test.ts`, `tests/upload-queue.test.ts` |
| Persistent upload recovery | Android | Ownership guard missing from local retry | Add guard and foreign-device regression | Build PASS; instrumentation BLOCKED | `QueueRecoveryTest.java`; no attached device |
| Continuous queuing / double actions | Browser / database | Existing tests available | Stress duplicate starts/stops and many queued jobs | PASS simulated workload | `tests/recording-stress.test.ts`, `tests/upload-faults.test.ts` |
| Multiple devices, same court | Database | FAIL: global court capture index | Per-device browser capture uniqueness | FIXED — PASS | `tests/tenant-isolation.test.ts`, migration 039 |
| Multiple tenants | SQL / API transport | FAIL: single-tenant scope | Tenant RLS, RPC ownership, API scope, composite keys | FIXED — PASS locally; staging BLOCKED | `tests/tenant-isolation.test.ts`, `tests/tenant-routes.test.ts` |
| Existing-data migration | Isolated database | NOT VERIFIED | Seed existing token/credential/file/lease state; apply new migrations | PASS | Nonempty migration preservation fixture in `tests/tenant-isolation.test.ts` |
| Account metadata / forged scope | SQL / route | Global role inappropriate for tenants | Deny spoofed tenant/actor and self-assigned privileges | PASS | Tenant tests; former global admin cannot override selected player membership |
| Court / location registration | Admin / SQL | NOT VERIFIED for tenancy | Scoped location resolution, quotas, duplicate/ownership checks | PASS isolated; authenticated deployed UI NOT VERIFIED | `tests/tenant-isolation.test.ts`, existing admin validation tests |
| Recording logs | Admin / SQL | Existing functionality | Preserve recent-history/filter UI, scope underlying queries | Type/build and SQL isolation PASS; live UI NOT VERIFIED | `components/admin-dashboard.tsx`, scoped admin route; latest 100 history limit |
| Google permissions and retries | Backend | FAIL for private new tenant recordings | Recipient-only sharing with partial-retry reuse | FIXED — mocked PASS | `tests/google-drive.test.ts`, drive job tests |
| Automated email | Backend | Existing outbox | Verify recipients, leases, retries and ambiguous-send handling | Mock/database PASS; inbox delivery NOT VERIFIED | Gmail/email tests; no real mail sent |
| Google OAuth / token refresh / playback | Hosted backend | Prior consent issue reported | Scope configuration and callbacks; document consent/rollout | Real integration NOT VERIFIED | Requires configured staging owner and recipient |
| Web startup / anonymous API security | Local production Next server | NOT VERIFIED for final build | Start final build and request 12 endpoints | PASS | `.local/rebrand-audit/startup-smoke.json`; port 3107 stopped after test |
| TypeScript / production build | Web | Required final check | `npm run typecheck`, `npm run build` | PASS | `.local/rebrand-audit/web-final.log` and final typecheck |
| Full automated suite | Node / TypeScript / database | 110 passed before tenancy | Run complete regression suite | PASS — 120 tests, 0 failures | `.local/rebrand-audit/final-tests.log` |
| Android build and lint | Android | Required final check | assembleDebug, assembleDebugAndroidTest, lintDebug | PASS — 0 lint errors, 12 warnings | `.local/rebrand-audit/android-final.log`, lint XML |
| Frontend lint | Web | No configured lint command/config | No unrelated dependency/setup added | NOT VERIFIED — not configured | `package.json` |
| Branding and compatibility | Repository | Legacy names existed | Rename appropriate assets/text; retain persistent IDs | PASS text/path audit with documented exceptions | Change inventory; migration/asset hashes; old logo redirect smoke |

The 12 production-server requests covered `/`, `/preview`, `/admin/login`, `/login`, `/tablet/setup`, `/tablet/clips`, both logo URLs, disabled tablet setup API, and unauthenticated admin/tenant/recording APIs. This verifies rendering and denial paths, not authenticated cloud workflows.

### Exact remaining hardware / external acceptance steps

1. Rehearse [tenant-rollout.md](tenant-rollout.md) on a separate Supabase project. Create two tenants with separate Google roots and devices. Confirm both administrators see only their own courts, logs, recipients and files. Try another tenant's IDs and revoked credentials against each device/recording operation.
2. Install the new APK over the existing installation with the same package/signing key. Attach the target USB camera. Verify Android exposes `LENS_FACING_EXTERNAL`; if not, this APK cannot capture that camera through Camera2. Use a supported device/browser for the pitch or plan a separate UVC driver integration. Do not call this a verified USB solution on an unsupported tablet.
3. Use `adb devices` to confirm a target, then run `android/gradlew.bat :app:connectedDebugAndroidTest` from `android`. Existing RTSP instrumented tests require the local fixtures documented in `android/README.md`; their runtime is not part of the wired demonstration. Record actual instrumentation output separately from build output.
4. On Chrome PC and the supported APK, record 0.5, 1, 15, 59, 60 and 65 seconds, then a continuous 15-minute match. Check file duration, seeking to final frames, normal speed, resolution/fps and visible/audible synchronization. Under-60-second clips must not appear on Drive or trigger mail. Verify a new match starts immediately after each stop.
5. Remove USB during opening, countdown, capture, and finalization; repeat with camera/mic permission revoked and restored. Reconnect and start again without restarting the app. Record state transitions and resource release in logs. Preserve and inspect any partial file.
6. Cut the last minute of the 15-minute source; verify source bytes remain unchanged, output duration is about 60 seconds within validated frame tolerance, sound aligns with action, and the output reaches the correct tenant/recipients. Cancel another export and confirm a new recording can start. Exercise the under-minute source case without padding.
7. Queue at least five eligible recordings on each of two devices on one court. Disconnect networking mid-chunk and after a completion response, restart during upload/backoff, and force-stop once during capture. Restore connectivity. Verify independent progress, bounded retries, preserved failed files, no duplicate Drive IDs, and no capture lock held by old failures. Re-enroll the original device and confirm old jobs remain accessible.
8. With two tenants active, revoke tenant A's Google consent or interrupt its network. Tenant B must still record/process normally. Confirm unauthorized accounts cannot open a new private replay. In the intended recipient inbox, verify exactly the expected replay email after a confirmed upload, and no mail for short or invalid footage. For any Unknown send, inspect sender Sent history before retrying.
9. In admin, create/edit a court and location, register/re-enroll a device, inspect filters and upload/error status, retry a valid failed upload, and confirm an invalid file cannot enter endless automatic retries. Repeat after app/browser restart.

## E. Readiness decision

**CONDITIONALLY READY.** Automated software tests and builds are green, and a real-browser synthetic clip export passes. The primary PC path needs a physical wired camera acceptance run. The secondary Android path additionally needs proof that the selected tablet exposes the USB camera, native exporter execution, and foreground/background behavior on that hardware. New schema, private Drive playback and actual inbox delivery must be staged before the pitch. No confirmed failing software test is being hidden by this verdict.

## F. Prioritized remaining work

| Priority | Remaining action | Requires |
| --- | --- | --- |
| P0 | Keep shared-customer hosting disabled until migrations 036–041, managed-Supabase grants/RLS, and all matching web/workers pass staging. Never run old unscoped services against newly created tenants. | Deployment coordination and staging access |
| P0 | Inventory historical public Drive links and decide a permission migration; new-private policy does not revoke old public access. | Owner approval, external ACL review; separate migration if required |
| P0 | Rotate any credentials previously pasted into chat before exposing a live environment; preserve the encryption key needed for stored credentials unless performing a coordinated re-encryption. | Credential owner; no secret values included here |
| P1 | Execute physical USB reconnect/permission tests, a real 15-minute recording, native last-minute cut, and restart/network tests on intended pitch devices. | Hardware/emulator; fix any reproduced defects before presenting |
| P1 | Verify OAuth audience/test-user or publication settings, real token refresh, private playback and delivered replay emails. | Google project owner, staging recipients and network |
| P1 | Deploy scheduler and matching APK/web release after staging; preserve old origin and local queues during any hosting change. | Deployment/release owner |
| P2 | Load-test expected tenant/device volume; measure backlog age, Google quotas, function deadlines, memory, storage and upload throughput. Tune the four-tenant scheduler batch only from measured results. | Staging load fixtures and monitoring |
| P2 | Add database-backed history pagination beyond the latest 100 sessions and review Android whole-journal write cost at large queue sizes. | Targeted follow-up code after measurements |
| P2 | Review 12 nonblocking Android lint warnings (SDK/tooling, WebView, backup rules, free-space, icons and text formatting). | Targeted maintenance; no new errors |
| P3 | Replace old-lettering logo pixels with supplied DinkVision artwork, configure frontend lint, and add broader authenticated browser automation. | Artwork/preference and follow-up tooling |

No production data, valid video, or upload queue was intentionally deleted by this implementation or its isolated tests. No production schema rollout, push, deployment, or actual email send was performed in this continuation.
