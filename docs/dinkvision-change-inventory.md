# DinkVision change inventory — October 14, 2026

Compared with the byte-hash baseline saved at the start of this rebranding/implementation task in `.local/rebrand-audit/baseline.json`. Existing dirty changes were already present in that baseline. Consequently this count is narrower than the complete working-tree diff against Git HEAD. Generated build files, dependencies, local secrets and ignored test outputs are excluded.

- Existing files modified: **79**.
- New files added: **25** (including this inventory).
- Files renamed: **4**. No directories renamed.
- Other files removed: **0**.
- Total affected files, counting each rename once: **108**.

## Compatibility verification

- All 34 pre-existing migration files retain their exact baseline bytes: **PASS**.
- The three renamed PNG files retain their exact original bytes: **PASS**.
- Launcher XML references were updated to the renamed resource.
- Legacy text/path matches are inventoried in `.local/rebrand-audit/legacy-final.json`; reasons are listed in the [readiness report](dinkvision-readiness-2026-10-14.md). No credential values are included.

## Renamed files

| Previous path | Current path |
| --- | --- |
| `public/wpc-logo.png` | `public/dink-vision-logo.png` |
| `android/app/src/main/assets/wpc-logo.png` | `android/app/src/main/assets/dink-vision-logo.png` |
| `android/app/src/main/res/drawable/wpc_logo.png` | `android/app/src/main/res/drawable/dink_vision_logo.png` |
| `android/app/src/main/res/drawable/wpc_launcher.xml` | `android/app/src/main/res/drawable/dink_vision_launcher.xml` |

## Modified existing files

- `README.md`
- `android/README.md`
- `android/app/src/androidTest/java/com/casabatik/recorder/QueueRecoveryTest.java`
- `android/app/src/androidTest/java/com/casabatik/recorder/RecordingAccuracyTest.java`
- `android/app/src/main/AndroidManifest.xml`
- `android/app/src/main/assets/app.js`
- `android/app/src/main/assets/index.html`
- `android/app/src/main/java/com/casabatik/recorder/DeviceCameraRecorder.java`
- `android/app/src/main/java/com/casabatik/recorder/Engine.java`
- `android/app/src/main/java/com/casabatik/recorder/MainActivity.java`
- `android/app/src/main/java/com/casabatik/recorder/PacketRecorder.java`
- `android/app/src/main/java/com/casabatik/recorder/RecorderService.java`
- `android/app/src/main/java/com/casabatik/recorder/RecordingAccuracy.java`
- `android/app/src/main/java/com/casabatik/recorder/RtspRecorder.java`
- `app/admin/page.tsx`
- `app/api/admin/[resource]/route.ts`
- `app/api/admin/cleanup/route.ts`
- `app/api/admin/drive/retry/route.ts`
- `app/api/admin/email/route.ts`
- `app/api/admin/kiosk/route.ts`
- `app/api/admin/recorders/[id]/route.ts`
- `app/api/admin/tablets/route.ts`
- `app/api/auth/login/route.ts`
- `app/api/integrations/google/callback/route.ts`
- `app/api/integrations/google/health/route.ts`
- `app/api/integrations/google/start/route.ts`
- `app/api/integrations/google/status/route.ts`
- `app/api/jobs/browser/route.ts`
- `app/api/kiosk/route.ts`
- `app/api/recorder/cleanup/route.ts`
- `app/api/recorder/emails/route.ts`
- `app/api/recorder/pair/route.ts`
- `app/api/recordings/[id]/playback/route.ts`
- `app/api/recordings/route.ts`
- `app/api/tablet/camera/route.ts`
- `app/api/tablet/enroll/route.ts`
- `app/api/tablet/route.ts`
- `app/api/tablet/upload-chunk/route.ts`
- `app/tablet.css`
- `components/account-controls.tsx`
- `components/admin-dashboard.tsx`
- `components/browser-tablet-setup.tsx`
- `components/browser-tablets-admin.tsx`
- `components/login-page.tsx`
- `components/player-preview.tsx`
- `components/tablet-kiosk.tsx`
- `docs/recording-accuracy.md`
- `docs/recording-recovery.md`
- `lib/admin-types.ts`
- `lib/auth.ts`
- `lib/browser-jobs.ts`
- `lib/browser-recorder.ts`
- `lib/browser-storage.ts`
- `lib/browser-tablets.ts`
- `lib/browser-upload.ts`
- `lib/drive-upload-server.ts`
- `lib/email-server.ts`
- `lib/gmail.ts`
- `lib/google-drive.ts`
- `lib/google-server.ts`
- `lib/kiosk.ts`
- `lib/recorder-server.ts`
- `lib/supabase-server.ts`
- `lib/tablet-camera-config.ts`
- `next.config.ts`
- `recorder/cli.mjs`
- `recorder/start-hidden.ps1`
- `scripts/provision-account.mjs`
- `scripts/test-live.mjs`
- `scripts/test-recorder-agent.mjs`
- `tests/audio-permissions.test.ts`
- `tests/browser-tablets.test.ts`
- `tests/capture.test.ts`
- `tests/database.test.ts`
- `tests/drive-jobs.test.ts`
- `tests/google-drive.test.ts`
- `tests/kiosk.test.ts`
- `tests/recorder.test.ts`
- `tests/tablet-camera-config.test.ts`

## Added files

- `android/app/src/androidTest/assets/recording-sixty-five-seconds.mp4`
- `android/app/src/androidTest/java/com/casabatik/recorder/VideoClipTest.java`
- `android/app/src/main/java/com/casabatik/recorder/VideoClip.java`
- `app/api/tenants/route.ts`
- `app/tablet/clips/page.tsx`
- `app/tenants/page.tsx`
- `components/local-clips.tsx`
- `components/tenant-settings.tsx`
- `docs/dinkvision-change-inventory.md`
- `docs/dinkvision-readiness-2026-10-14.md`
- `docs/implementation-scope.md`
- `docs/tenant-rollout.md`
- `lib/tenant-scope.ts`
- `lib/video-clip.ts`
- `scripts/test-browser-clips.mjs`
- `supabase/migrations/202610140036_tenant_isolation.sql`
- `supabase/migrations/202610140037_tenant_administration.sql`
- `supabase/migrations/202610140038_private_tenant_recordings.sql`
- `supabase/migrations/202610140039_independent_court_devices.sql`
- `supabase/migrations/202610140040_local_video_clips.sql`
- `supabase/migrations/202610140041_preserve_reenrolled_queue_ownership.sql`
- `tests/helpers/legacy-memberships.ts`
- `tests/tenant-isolation.test.ts`
- `tests/tenant-routes.test.ts`
- `tests/video-clip.test.ts`
