# Recording and queue recovery

## Scope and root causes

The APK records Camera2, direct UVC/USB-host, or RTSP. Version 0.5.23 keeps the
external Camera2 path and adds a direct UVC fallback for Android devices that
detect a standards-based USB camera without publishing it through Camera2. It
does not substitute the rear camera while a UVC device is attached. The browser
also supports USB cameras exposed through getUserMedia. Physical camera formats,
OTG adapters, available USB power, and manufacturer behavior still require testing. See the
[October 14 report](dinkvision-readiness-2026-10-14.md) and
[tenant rollout guide](tenant-rollout.md) for the current release requirements;
the October 13 results below are historical.

Version 0.5.23 also maps camera timestamps to strictly increasing MP4 frame
numbers while adding the Dink Vision logo. This prevents FFmpeg error -22 when
two valid camera timestamps round to the same encoded frame number.

- Camera2 callbacks could arrive after open/configure timeouts and escape cleanup.
  Session/encoder failures did not consistently release every resource. Browser
  transformed capture ignored the original source's stall detector; a missing
  `onstop` event could hold the capture lock indefinitely.
- The server explicitly held sub-minute recordings as `local_only`. Android also
  advertised this restriction. Saved footage could be marked failed merely because
  the `stopped` request failed, before its durable queue entry was written.
- Android restored `recording` as failed and never restored `uploading`. Queue
  polling could wait forever. Server expiration moved stale jobs to `retrying`
  without removing them from the FIFO head.
- Android validation decoded only the first frames and some validation errors
  retried as network errors. A playable prefix could hide a truncated MP4 tail.
- Cleanup preceded durable completion, allowing a crash or failed deletion to
  reopen a successful job. Upload calls and heartbeats shared a synchronized API
  method, so a slow request could delay capture control.
- The browser recovery screen refused a new match while failed footage existed;
  leaving some failures deleted the local backup. Leaving now dismisses the
  player screen while retaining footage and queue history for admin recovery.

## Changes

All valid durations can be recorded. Per the updated venue policy, migration 034
keeps clips under 60 seconds local, without Drive upload or replay email. Exactly
60 seconds is eligible for upload. This supersedes migration 033's upload policy
while retaining its recovery safeguards. Finalized video duration controls the
cutoff. Short clips remain downloadable and do not retry or block later clips.

Camera resources close on failure and late callbacks close immediately. Browser
capture observes physical track stalls even with transforms and releases resources
after a bounded finalization wait. Finalized partial footage is validated before
queueing. Android checks MP4 box boundaries, decodes video throughout the file,
and retains the existing packet timestamp and audio/video checks. Invalid files
remain local and do not automatically retry. Google metadata is checked against
the Android file's MD5 before completion.

Local states are `pending`/`saved_locally`, `uploading`, `retrying`, `uploaded`
(completed), and `failed`. The encrypted journal survives process death. Retries
use exponential backoff with jitter and an eight-attempt budget. A restarted
in-flight upload consumes a retry. Server entries leave the active FIFO during
backoff. Three-minute abandoned server claims expire to failed, except while an
operation lease is active. Resumable IDs and offsets are retained. Each network
operation is bounded; per-chunk server leases prevent overlapping transfers of
the same recording. Devices keep independent queues. Local cleanup follows
server confirmation and a durable completed record.
Failure reports persist across outages. Explicit remote retries must be newer
than the last acknowledged failure, preventing stale polls from resetting the
retry budget. Browser queue reconciliation runs under the device upload lock.

Diagnostics: Android logcat tags `DinkVisionRecording` and `DinkVisionQueue` include job IDs,
state transitions, attempt counts, timing, and failure categories. They exclude
camera URLs, credentials, and Google tokens. The existing dashboard shows queue
status and error messages.

## Deployment and verification

The player retains its selected recording result until “Record another match”
is chosen. Start keys are cleared when a session is created; stale polling
responses and older failed clips cannot replace a new match. Brief hidden-page
states during permission/countdown wait for visibility before camera capture.
Upload recovery runs in the background, and saved notifications appear at the
bottom with a dismiss button. A previous finalized clip can register its saved
state while another upload holds the queue lock, releasing the capture slot.

Local verification on October 13, 2026: all 109 Node/SQL/browser regression
tests passed; TypeScript and the production web build passed. Android debug
and instrumentation APKs compiled (version 0.5.11). No Android device was
connected, so instrumentation and physical hardware scenarios below have not
been executed. Migration 033 was subsequently applied to the configured Supabase
database to resolve the tablet setup endpoint's missing-RPC error. Its function
and columns were verified through the Data API. Migration 034 was then applied
for the requested local-only sub-minute policy. Web deployment is still pending.
The expanded fault-test findings and hardware verification scope are recorded in
[`recording-test-report.md`](recording-test-report.md).

1. Apply migrations through 034 through the normal migration runner, deploy the web code,
   and install the rebuilt APK as an update (preserve the application ID/signing
   key and app data). Migrations 033 and 034 are already applied to the configured
   Supabase project; other environments need them before deploying these changes.
2. Run `npm test`, `npm run typecheck`, and the Android build. Android
   instrumentation tests include restart queue restoration, short/truncated MP4s,
   missing confirmation, lost chunk responses, stalls, and cancellation. They
   require an Android device/emulator; RTSP tests also require the existing RTSP
   fixtures. Building the test APK does not execute these tests.
3. On each supported physical device, record 0.5-, 1-, 15-, and 59-second clips
   plus 60-second clips and a full match. Confirm duration, seeking, end frames,
   and audio. Sub-minute clips must remain local without upload or email; verify
   Drive MD5 and email only for eligible longer clips.
4. Remove/reconnect USB during camera opening, countdown, capture, and finalization;
   repeat with rotation/flips. Revoke and restore camera/mic permissions. Confirm
   resources release, valid partial footage of at least 60 seconds uploads, short
   or invalid footage remains local,
   and a new recording starts without restarting the app.
5. Disable networking during a chunk and immediately after its response. Queue
   several clips, restart the app mid-upload and during backoff, then reconnect.
   Verify acknowledged-offset resume, later-clip progress, bounded failures, and
   no duplicate Drive files. Run simultaneously on two devices.
6. Kill the process while recording and while saving completion. On reopening,
   verify files and history remain, invalid clips stop retrying, and confirmed
   uploads are not repeated. A non-fragmented MP4 killed before its trailer may
   be unrecoverable; it is preserved, not presented as a valid recording.
7. Stop a short browser recording and immediately choose “Record another match.”
   Repeat with an older upload still running and after returning from a camera
   permission dialog. Confirm one start attempt works, the previous clip remains
   downloadable, old failures do not replace the form, and manual upload recovery
   still allows another match. No automatic welcome-screen jump should occur.

Physical USB/encoder and manufacturer background restrictions require hardware
verification. Android force-stop cannot be bypassed; reopen the app to resume.
The browser requires an open page to upload; its persistent queue resumes on return.
