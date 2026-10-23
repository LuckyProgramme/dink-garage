# Dink Vision match recording

## Publishing merged updates

The deployment branch is `codex/player-preview`. After reviewing and merging contributor changes, the Vercel project owner publishes the release using their linked Git identity. Keep contributor commits intact. Verify that the new Vercel deployment reaches **Ready**, then promote it to Production if it was created as a Preview. Redeploying an older deployment does not include newer branch commits.

Latest owner deployment refresh: October 18, 2026. The latest local Android package is [Dink Vision Recorder 0.5.23](artifacts/Dink-Vision-Recorder-0.5.23.apk) (debug-signed; [SHA-256 checksum](artifacts/Dink-Vision-Recorder-0.5.23.apk.sha256)). It adds direct standards-based UVC/OTG capture when Android does not expose the attached camera through Camera2. Version 0.5.23 also prevents rounded camera timestamps from corrupting the MP4 while adding the Dink Vision logo, keeps technical encoder details in Android logs, waits for permission results during setup, and reports the actual camera failure. It shows background upload progress, reports the locally safe video to the admin queue immediately, and keeps the logo upright at the displayed bottom right. It has not been published or deployed. Apply the pending database migration `supabase/migrations/202610100028_device_upload_queues.sql` to the deployment database before testing the new queue behavior. The exact USB camera, OTG adapter, power supply, and Android device still require a physical recording test.

Tablet guest recording with Google Drive upload, emailed playback links, and automatic retention cleanup. The tablet design preview is at `/preview` and cannot record.

## Run

Requires Node.js 20.9+ and npm.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:3000. Administrators sign in at `/admin/login`; players do not need accounts. `/preview` needs no credentials and cannot record.

```sh
npm run typecheck
npm run build
npm test
```

## Browser recording update (October 10, 2026)

The current Windows PC test target is Google Chrome. Switching tabs no longer requests a recording stop. Camera flips and rotation use a worker-based frame pipeline with source timestamps; these transforms require supported browser APIs and otherwise report a setup error. Keep the recording tab open and the device awake; closing or reloading it, device sleep, and OS suspension can still interrupt capture. The configured recording time limit still applies.

This update also improves MP4 timing validation, keeps local recovery controls visible after interruption, and allows cancellation or device removal for ended captures with failed uploads. It does not rebuild or change the native Android APK. Apply migrations through `202610100032_failed_upload_device_actions.sql` to each deployment database before testing the admin actions; migrations are not applied by the web build.

## Browser tablet build

The new player setup is browser-only. Each enrolled tablet records one assigned court. No Android APK or venue computer is required for this mode. The legacy Windows APIs and existing recordings remain available for compatibility.

1. In **Admin / Devices & cameras**, add a tablet, assign a court, and copy its single-use enrollment code (expires in ten minutes).
2. Open `/tablet/setup` on the physical tablet using the same HTTPS site, and enter the code. Grant camera/microphone permissions on that tablet. The local `127.0.0.1` address works only on the computer hosting development; a tablet accessing its LAN HTTP address cannot capture cameras. Use an HTTPS deployment or trusted HTTPS development endpoint.
3. Choose a browser-detected built-in or USB camera and microphone, then pass the three-second recording test. Setup access expires fifteen minutes after enrollment; later changes require admin sign-in on the tablet.
4. Open `/` in the same browser. Screen 2 displays the fixed assigned court. Players enter email, review details, and record without an account or Google login.
5. Keep the recording tab open and the device awake. Switching tabs does not request a stop. Stop using the recording button or reach the time limit. Clips shorter than one minute stay only on their recording device and never upload. Longer browser recordings are first saved in the website’s protected IndexedDB storage (`casa-browser-recordings`) and then enter a per-court, first-in upload queue. Only one tablet per court uploads to Drive at a time. Waiting tablets and the admin device cards show the active upload and live progress. An administrator can cancel a stuck upload to release the queue without deleting the original device's local video; Recover / retry upload later rejoins at the end. The backend verifies Drive metadata, grants link access, and queues email. Google credentials stay server-side.
6. Upload failures retry three times and retain saved chunks. A failed first upload pauses later cameras on the same court until **Recover / retry upload** succeeds on the original tablet. The original webpage or APK removes its local video only after it verifies a successful backend upload response. Backgrounding or closing the page interrupts recording; recovered footage can be partial. Clearing browser data loses enrollment and unsent video.

Direct browser capture supports built-in cameras and physically connected USB cameras exposed through `getUserMedia`. External Tapo C210 Wi-Fi cameras use their local RTSP stream through the enrolled Android gateway instead of the Android device camera or browser setup page. The gateway receives, saves, and uploads the Tapo stream without using its own camera or microphone. Keep the Tapo camera and Android gateway on the same trusted local network.

Organization defaults to Dink Vision. Enrollment creates a revocable browser identity, not a player account or hardware serial number. One enabled tablet per court; assignments cannot change during unfinished recordings. Web Locks prevent concurrent recording tabs. Recorded size and MIME type become immutable when upload begins.

### Browser background processing

`/api/jobs/browser` requires `Authorization: Bearer <CRON_SECRET>` and handles email retries, completed-upload reconciliation, stale capture status, and expired Drive deletion. Upload completion also attempts email immediately. Ambiguous Gmail sends are never automatically repeated. Drive links stop working after actual deletion, which scheduling delays or outages can postpone.

Set a random server-only `CRON_SECRET` in `.env`. For local development, run alongside the web app:

```sh
npm run jobs:browser
```

At deployment, configure an independent scheduler to invoke the endpoint every minute and set `CRON_SECRET` on the server. `deploy/vercel.cron.example.json` can be merged into `vercel.json` for Vercel Pro/Enterprise. It is not enabled by default because [Vercel Hobby permits only daily cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) and rejects a per-minute schedule at deployment. Hobby can use an external authenticated scheduler such as Supabase Cron. The local worker does not activate production scheduling. Admin Devices & cameras displays the latest successful worker run.

For Vercel deployment, configure the production variables from `.env.example` in Vercel (never commit `.env`). Set `APP_ORIGIN` to the canonical hosted origin, without a trailing slash; Google OAuth callbacks and Android builds derive their endpoints from it. Keep `TOKEN_ENCRYPTION_KEY` unchanged. Apply migrations through `202610100032_failed_upload_device_actions.sql` to the production database before testing. Migrations are not applied by `next build`. Verify a recording, upload completion, and replay email on the deployed site; the original tablet must remain available to upload its local videos. Android upload-recovery changes require installing a rebuilt APK. Browser backups are scoped to the site's origin, so recordings saved on localhost cannot be resumed from the Vercel website.

Cloud retention permanently deletes expired browser videos with no backup. Successful uploads remove their tablet-local video; interrupted or abandoned footage remains for recovery. Historical Windows clips retain the legacy worker flow below.

Automated tests cover browser registration, fixed assignment, scoped transitions, the one-minute upload minimum, per-court upload serialization, failure blocking, administrator cancellation and end-of-queue recovery, upload resume offsets, local chunk persistence, first-footage acknowledgement, and cloud email leases. Before venue use, test Android permissions/audio, a full match, interruption recovery, multiple simultaneous tablets, and actual emailed playback.

## Legacy recorder behavior (existing recordings)

- Real Supabase email/password sign-in and logout; server-managed HttpOnly cookies, token refresh, and server-side user verification.
- Every admin mutation validates the request origin, signed-in account, active profile, database role and input; database RLS also restricts access.
- Admin overview, court creation/editing/deactivation, recorder entries, dynamic network/USB camera assignments and primary-camera configuration.
- Duration/retention/time-zone settings, recent activity, and latest 100 recording sessions with email/court/status/date filters.
- Guests use an admin-enabled tablet, choose an available court, enter an email, confirm details, and record without an account. No email verification is claimed.
- One-time recorder pairing, scoped revocable machine tokens, heartbeats, ONVIF network discovery, Windows USB discovery, and single-frame connection tests. Hardware health is not editable by an admin browser.
- Players select an available court and start/stop its primary camera. Session settings are snapshotted at Start; the local worker enforces the duration even without a browser or cloud connection. Only the owner or an administrator can request Stop.
- Successful clips upload to Drive, receive a read-only playback link, and queue Gmail delivery. Expired cloud and local videos are permanently deleted by the recorder worker.
- `/preview` uses the same tablet UI with a labeled read-only fixture and never starts a capture.

The approved logo is `public/dink-vision-logo.png`. Website and Android copies are checked against that file during tests and Android builds. Court artwork is an original SVG illustration. Fonts use Google Fonts with local system fallbacks.

## Foundation and configuration

Copy `.env.example` to `.env` and enter credentials locally. No secrets are committed. Rotate previously exposed credentials before configuring live services.

The application uses Supabase's HTTPS API; direct PostgreSQL access is only needed for migrations. Set `MIGRATION_DATABASE_URL` to the session pooler URI (port 5432) from your project's Connect panel, replacing the password placeholder without brackets. The public Supabase CA certificate is included as `DATABASE_CA_CERT` in the tracked `.env.example`; copy it into `.env` along with the other settings. Alternatively, set `DATABASE_CA_CERT_PATH` to a local certificate file. TLS certificate verification stays enabled. The transaction pooler `DATABASE_URL` is reserved for future direct server queries. Never commit `.env` or database credentials.

```sh
npm run db:migrate
npm run account:create -- owner@example.com admin "Venue owner"
npm run account:create -- player@example.com player "Test player"
```

The migration runner records checksums and applies each new file in a transaction. Never edit already applied migrations. It refuses modified checksums and serializes concurrent runs.

Account provisioning is a trusted local operation for explicitly confirmed owner/test emails. It auto-confirms seeded emails without sending mail, assigns the requested role server-side, and generates a random password in a git-ignored `.local/account-<id>.json` file. It does not reset existing users' passwords. Deliver these credentials privately; no public signup or email-based password reset UI is included yet. The owner must supply the lasting admin/test-player identities. Passwords and tokens must never enter Git.

Browser clients cannot set roles or hardware health. Camera records hold only local device identifiers; stream URLs and passwords stay on the local service. Do not put credentials in recording snapshots or audit details. `SUPABASE_SECRET_KEY` is now required in the web server environment for the protected recorder APIs. Never expose it through a `NEXT_PUBLIC_` variable or install it on the recorder.

## Local recorder setup (Windows)

The venue PC must stay awake, have Node.js and this repository installed, and share a reachable network with the cameras. USB/integrated cameras connect to this PC, not the player's phone. Vercel hosts only the control app. The recorder makes outbound HTTPS requests; no inbound port forwarding is needed.

1. Run `npm install` and `npm run recorder -- doctor` on the venue PC. FFmpeg is bundled by the dependency installer.
2. In Admin → Camera setup, add a recorder and select it. Click **Get pairing code**.
3. From the project directory run `npm run recorder -- pair`. Enter the app origin (locally `http://127.0.0.1:3000`; later your Vercel HTTPS origin), then the one-time code. Codes expire in ten minutes. Redeeming a new code revokes the prior machine token.
4. Run `npm run recorder -- start` and leave it running. The dashboard refreshes every ten seconds. A recorder becomes offline after 45 seconds without a heartbeat.
5. Click **Discover cameras**. USB cameras and ONVIF cameras advertising on the local network appear under the selected recorder. Discovery does not open a video feed. ONVIF must be enabled on the camera; guest Wi-Fi isolation, VLAN separation, firewalls and proprietary cloud-only cameras may prevent discovery.
6. For network credentials, stop the recorder with Ctrl+C, run `npm run recorder -- configure DEVICE_REFERENCE`, and answer the prompts locally. For a camera that cannot be discovered, omit the reference and enter its RTSP URL. Restart the service and discover again. `npm run recorder -- discover` can also enumerate devices locally before pairing.
7. Click **Assign to court**, choose the court, enable its primary camera, and save. Then **Test connection**. This opens the feed briefly, decodes one video frame, and discards it; no clip, image or audio is saved or uploaded. A passing result remains valid while the recorder is connected. Starting a recording opens the camera again and confirms frames before reporting Recording. Retest after registration or a device change.

The service currently supports Windows USB via DirectShow and ONVIF/RTSP network cameras. The number of cameras is configurable; each discovery is capped at 64 devices to bound payloads. Network credentials and the scoped machine token live in `.local/recorder/config.json`, protected with Windows account ACLs and excluded from Git. Do not copy this file into cloud hosting. Stop the service before local configuration changes. `CASA_RECORDER_HOME` can specify a different protected local directory.

For a hidden background process, after pairing run `powershell -File recorder/start-hidden.ps1` from the project directory. It writes local service logs and runs until the process is stopped or the user signs out. This build does not install an automatic boot service. For visible operation use `npm run recorder -- start` and Ctrl+C. **Revoke pairing** immediately denies subsequent recorder API requests; an already-running capture worker will still enforce its local duration limit. Re-pair the same recorder to reconcile its saved results.

Discovery/test commands use 90-second leases, at most three attempts, and a ten-minute queue lifetime. Completion is checkpointed locally and retried after network failures; stale lease completions are rejected. Discovery results alone never establish healthy cameras. Diagnostic checks are deferred while that recorder has pending/active captures.

## Test a match recording

1. Run migrations and restart the local recorder after updating the code. Its dashboard version should be `0.4.0`.
2. Ensure the court has an enabled primary camera. Run **Test connection** if the camera has not passed a check or its last capture failed.
3. Enable the tablet as described below, sign out of admin, tap the welcome screen, select **Court 1**, enter your email, and confirm **Start recording**. Wait for the live countdown before playing.
4. Click **Stop recording**. The UI will show **Saved locally** when finalization is confirmed. Closing/reloading the browser does not stop capture; reopening the page restores the active session.
5. On the recorder PC, open `.local/recorder/captures/<session-id>/video.mp4` to play the clip. The admin Recording logs show the session ID. Local files are private and are not served by the web app. Google Drive viewing is available after owner authorization; email delivery is available after Gmail authorization.

The capture profile is H.264 MP4 at up to 1280 pixels wide and 30 fps, with optional 48 kHz AAC audio. In Camera setup, discover devices, edit a camera, and choose Recording audio: Off, a discovered USB microphone, or Camera stream microphone for RTSP cameras. Save and run Test connection: audio-enabled tests decode two seconds without saving a clip. Audio defaults off; enabling it requires recorder 0.4.0 and invalidates the prior connection test. Players see a microphone notice before recording. The audio choice is snapshotted for each session and cannot be changed during capture. If a selected microphone or stream audio is unavailable, the test/capture fails instead of claiming an audio recording succeeded; choose Off to record silently. Windows video and microphone devices are opened together ([FFmpeg DirectShow documentation](https://www.ffmpeg.org/ffmpeg-devices.html#dshow)). Fragmented MP4 preserves recoverable fragments during interruptions ([FFmpeg documentation](https://www.ffmpeg.org/ffmpeg-formats.html)). Default duration stays 15 minutes. The hardware check and recording cannot run on the same recorder concurrently; other apps holding the webcam may prevent capture.

Capture admission is transactional, with one active session per court, one per player, and one per device. Repeating a start idempotency key returns the original session. Start is limited to five new sessions per player per minute. Pending requests older than 60 seconds are failed when the recorder reconnects. Capture workers run independently of the control process, persist their result before reporting, and are never automatically relaunched for an existing session. A controller restart reconciles them using the existing session identity. Internet outages delay Stop delivery, but FFmpeg's duration limit and the worker's wall-clock limit continue locally.

An active capture lock is deliberately not released merely because its heartbeat expires: the camera could still be recording offline. After a worker crash, reconnecting the controller marks the session interrupted once its configured deadline plus a recovery allowance has passed and both the worker and its FFmpeg child are no longer running. An ambiguous or still-running orphan process keeps the court locked for administrator investigation. Valid partial files stay local for administrator review. Keep the PC awake and restart the recorder after OS restarts; automatic boot/service installation is not included. Low disk space rejects new captures or stops an ongoing one. Local clips are retained until the future upload/cleanup stage; the 24-hour Drive retention clock has not started for these files.

## Verification

`npm test` runs validation, hardware-parser and SQL migration tests in an isolated PostgreSQL engine (PGlite), including pairing expiry/replay, command leases, recorder isolation, recorder heartbeat expiry, roles, session isolation and camera constraints. The test bootstrap models Supabase auth roles; production checks also run against the configured Supabase project.

With the local web app running, explicitly run this integration check:

```sh
node --env-file=.env scripts/test-live.mjs
```

It creates three temporary test identities and its own court/recorder/camera/session fixtures, verifies live login, cookies, roles, CRUD, isolation, recorder pairing/commands/revocation and logout, then removes its fixtures. Camera results are explicitly simulated protocol fixtures. It sends no emails, opens no cameras, and does not change venue settings. Do not use it as a load test. Check its cleanup result if it fails.

`node --env-file=.env scripts/test-recorder-agent.mjs` additionally launches the actual local service with a disposable recorder and verifies pairing, heartbeats, discovery and result delivery. It enumerates devices on the local computer/network but never opens a feed. It cleans up its own cloud records and temporary configuration directory. Run it only on the intended test computer.

`node --env-file=.env scripts/test-capture-live.mjs <local-player-credentials.json> "Court 1"` explicitly records from that configured court, tests idempotency and a second player's isolation, restarts the control process during capture, stops and fully decodes the MP4. It keeps the recording under the supplied player's account and removes its temporary second player. Run only when recording from that camera is intended. Unit tests use generated test patterns for accelerated automatic-stop and early-source-failure checks; no camera is opened by `npm test`.

## Agreed next stages

1. Drive upload, playback, Gmail delivery, and expiry cleanup have been implemented and live-tested.
2. Verify the complete workflow with actual venue hardware and guest email delivery, then deploy the web app to Vercel.

Default duration is 900 seconds and retention is 86400 seconds after successful upload. Venue time zone is Asia/Manila; final camera hardware remains unconfirmed. Windows is the first supported recorder OS. The local recorder runs independently of the player's browser.

## Google Drive upload and playback

Browser and USB-camera recordings are captured directly as MP4 (H.264/AAC where the browser exposes it) for dependable Drive and browser playback. The tablet setup blocks recording when the browser cannot produce MP4 and asks staff to update Chrome/Edge or use the Android recorder. Legacy WebM clips are never added to the Drive queue; they remain in that browser's protected local storage and can be downloaded from the tablet recovery screen. Already-uploaded historical WebM files are not rewritten.

1. Configure APP_ORIGIN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_DRIVE_ROOT_FOLDER_ID, GOOGLE_SENDER_EMAIL and a stable base64 TOKEN_ENCRYPTION_KEY containing 32 random bytes. Deployed builds derive the OAuth callback from `APP_ORIGIN`; `GOOGLE_REDIRECT_URI` is only a local-development override. These are server secrets except for the public application origin; never prefix secrets with NEXT_PUBLIC or put them in recorder configuration. Keep the encryption key across deployments and backups.
2. Enable Drive API and register `<APP_ORIGIN>/api/integrations/google/callback` as the exact Authorized redirect URI in Google Cloud. Generated Vercel deployment domains and the site root are rejected. Local development may use `http://127.0.0.1:3000/api/integrations/google/callback`; use the same host for the app and callback because 127.0.0.1 and localhost have different cookies. Set the venue time zone; Dink Vision uses Asia/Manila.
3. Sign in as the venue admin, open Settings, and Connect Google Drive. Authorize the configured owner. This POC uses the Drive scope because the destination is an existing owner-supplied folder; it also requests the send-only gmail.send scope for email notifications. The destination must be an owner-only My Drive folder; shared/public folders fail closed rather than exposing player recordings through inherited permissions.
4. Restart the recorder to load its background upload loop. New completed recordings created after the first connection queue automatically. Existing local recordings require Upload / retry Drive in Recording logs. Use a real recipient email. New guest recordings use link access; older private recordings still require the matching Google account.
5. Uploads run directly from the venue PC to Google's resumable endpoint in 4 MiB chunks, independently of camera control. The web app only handles metadata and sharing. The worker queries acknowledged offsets after interruptions; persisted pre-generated file IDs prevent duplicate Drive files. A verified byte count and MD5 are required before sharing.
6. Guest sessions snapshot `sharing_mode: link`; only those files receive `anyone/reader` with file discovery disabled. Anyone holding the emailed link can watch without a Google account. Parent folders remain private. Legacy sessions keep owner/recipient-only sharing and their authenticated playback route. The app becomes Ready only after sharing is confirmed. Google may need time to process MP4 playback.
7. Failures appear under Settings > Recent uploads. Transient failures back off, up to eight claims before manual retry. Reconnection preserves the original auto-upload cutoff. A restarted recorder resumes after the previous three-minute lease expires. Original videos stay local until expiry; the cleanup worker then deletes them. Do not delete them manually during upload.

The planned viewing deadline is stored after upload using the current retention setting. The app hides playback links at that deadline. The recorder cleanup worker permanently deletes the Drive video and then its local copy; outages or revoked credentials delay physical deletion until recovery. OAuth authorization and actual recipient playback must be verified with the owner and player Google accounts before calling this a completed live integration.

References: [Google resumable uploads and pre-generated IDs](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [private sharing](https://developers.google.com/workspace/drive/api/guides/manage-sharing), [server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server).


## Automatic Gmail delivery

Migration 009 adds a service-only email outbox. Enable Gmail API, then use Admin > Settings > Connect / reconnect Drive & Gmail and approve sending as the configured owner. No mailbox reading or deletion permission is requested. The existing callback and encrypted refresh-token storage are reused. New ready uploads after the first Gmail authorization automatically queue; older unexpired recordings have an explicit Send email action. Reauthorization preserves the original email cutoff for the same owner.

The recorder runs a separate ten-second email poll, so sending is independent of capture and video upload. Restart it after updating. Each API request claims at most one job with a three-minute lease. Only confirmed ready, unexpired files are emailed, to the session's original recipient, from GOOGLE_SENDER_EMAIL. Messages include a Drive URL, the correct access instructions for that session, and the venue-local retention deadline. No localhost links or video attachments are emailed.

Known rejected rate-limited requests retry with exponential backoff and Retry-After, up to eight attempts. Failed jobs can be retried by admins. Gmail does not support send idempotency: timeouts, server errors, or a crashed worker after claiming a send become Unknown and are not resent automatically. Check the owner's Sent folder before manual recovery. A stable Message-ID aids investigation but is not treated as deduplication. Sent means Gmail accepted the message, not that it reached the recipient inbox. Email failure does not revoke playback or erase recordings.

Testing uses fake Gmail responses and a temporary database; automated tests never send real mail. Live delivery requires owner Gmail consent and verification with the intended recipient. Retention deletion is handled by the cleanup worker.


## Retention and permanent deletion

Migration 010 adds a service-only cleanup queue. Every ten seconds the recorder claims at most one expired, successfully uploaded recording belonging to it. The saved expiry is calculated at upload from the retention setting (default 24 hours); changing settings never shortens existing recordings. The worker checks the stored Drive ID, original upload folder, owner and video MIME type, then calls Drive files.delete (permanent deletion, not Trash). A missing Drive file is idempotently treated as already absent. Root/account changes or permission failures are surfaced and retried with backoff up to one hour, without abandoning the job.

After cloud deletion is persisted, only the corresponding captures/<session-id>/video.mp4 is unlinked locally. Path traversal, symbolic links and non-finalized capture states are rejected; no recursive directory deletion is used. A lost acknowledgement retries safely. Metadata and audit records remain, but no video backup is created. Unuploaded/failed captures have no upload-based expiry and are not purged by this policy.

Admin Settings shows cleanup state and errors. Players see expired/deleted status. Email queues cannot send new links for expired videos. The current scheduler runs on the venue recorder: leave it running and online. Physical deletion is eventual rather than guaranteed at the exact expiry second; cloud-independent scheduling can be configured during deployment. Never describe a hidden playback link alone as proof of remote deletion.

Validation includes isolated database expiry/lease/RLS tests, mocked Drive errors, local path tests, and a live generated one-second black-video fixture whose Drive file and local copy were both deleted. Actual match recordings were not prematurely expired for testing.


## Guest tablet setup (migration 011)

1. On the intended tablet/browser, sign in at `/admin/login` and open **Settings → Guest tablet → Enable this tablet**.
2. Sign out of admin before handing over the tablet. Sign-out returns to the welcome screen and retains the separate guest device cookie.
3. Guests tap to start, select an available court, enter their email, check the address/access/audio notice, and confirm recording. The active session survives refresh and has a countdown and Stop control.
4. After capture, upload and email continue in the background. **Done** clears the tablet immediately; completion screens reset automatically after 45 seconds without a status change. Abandoned forms clear after two minutes of inactivity. A live recording is never stopped by an idle-screen timer.
5. Clearing browser cookies or using another browser requires enabling that browser again. **Disable this tablet** revokes its guest credential; active captures continue to their limit and remain stoppable by an admin.

The 180-day HttpOnly, SameSite=Strict cookie is independent of Supabase login. Only its SHA-256 hash is stored in a service-only table. Guest APIs require this device credential, validate mutation origins, and expose only its current session without recipient email or historical recordings. Guest RPCs are service-role only and keep the existing court/device locks, rate limit, camera readiness checks, and idempotency. No fake Supabase accounts are created for email addresses. Existing account-owned recordings are retained.

The admin Google OAuth callback, owner credentials, Drive root, Gmail sender and retention process are unchanged. The link-access choice applies only to new guest files, not historical private videos. A forwarded link grants playback until the video is deleted. The local venue recorder still needs to stay running for capture, delivery and cleanup.

Validation: 32 automated tests, production build, API authorization/origin/session checks, landscape and portrait tablet layout review, and a generated one-second green-video guest fixture uploaded through the real worker with verified read-only link permission and Gmail acceptance. This fixture did not open the camera and expires under the regular retention policy.


## Unified camera setup

Admin → Camera setup now keeps the venue computer selector, pairing/discovery controls, camera list, and court/audio form together. The connected computer is selected initially; switching computers scopes the devices and camera list and clears the previous edit. Camera forms inherit this selected computer. Add/edit computer remains inline, and saving a new computer selects it for pairing. No advanced-settings area is introduced in this phase.
